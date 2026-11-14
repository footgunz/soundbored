// "Simulated FM-1": the device side of docs/protocol.md, in memory, optionally persisted to localStorage.

import { crc32 } from './crc32';
import {
  BeginKind,
  Cmd,
  GAIN_MAX,
  ICON_BYTES,
  ICON_H,
  ICON_W,
  KEY_AUTO,
  KEY_NONE,
  KEYS,
  MAX_CHUNK,
  NAME_MAX,
  PLAY_STOP,
  RATE_MAX,
  RATE_MIN,
  REPLY_FLAG,
  Reader,
  SECTOR_PAYLOAD,
  SLOT_AUTO,
  SLOTS,
  ShortBodyError,
  Status,
  Writer,
  buildFrame,
  decodeBegin,
  encodeEntry,
  encodeHello,
  isPrintableAscii,
  parseFrame,
  type Entry,
} from './protocol';

export const MOCK_SECTORS_TOTAL = 94;
const STORAGE_KEY = 'soundbored.mock.v1';

export interface MockSound {
  key: number;
  mode: number;
  gain: number;
  name: string;
  rate: number;
  frames: number;
  sectors: number;
  icon: Uint8Array;
  audio: Uint8Array;
}

interface Transfer {
  kind: number;
  slot: number;
  total: number;
  rate: number;
  frames: number;
  key: number;
  mode: number;
  gain: number;
  name: string;
  sectors: number;
  buf: Uint8Array;
  next: number;
}

export interface KVStore {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

/** localStorage, if it exists and works; every access is wrapped. */
export function safeLocalStorage(): KVStore | null {
  try {
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    if (!ls) return null;
    const probe = '__sb_probe__';
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    return ls;
  } catch {
    return null;
  }
}

function b64(u: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}

function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

export interface MockEvents {
  onPlay?: (slot: number, sound: MockSound | null) => void;
  onChange?: () => void;
}

export class MockDevice {
  slots: (MockSound | null)[] = new Array(SLOTS).fill(null);
  sectorsTotal = MOCK_SECTORS_TOTAL;
  transfer: Transfer | null = null;
  private last: { cmd: number; seq: number; reply: Uint8Array } | null = null;
  events: MockEvents = {};
  /** Set by handle(): true when the last frame was a DATA that crossed into a new sector (a flash erase). */
  lastWasErase = false;

  constructor(private store: KVStore | null = null) {
    this.load();
  }

  // -------------------------------------------------------------- accounting

  sectorsUsed(): number {
    let n = 0;
    for (const s of this.slots) if (s) n += s.sectors;
    if (this.transfer) n += this.transfer.sectors;
    return n;
  }

  sectorsFree(): number {
    return Math.max(0, this.sectorsTotal - this.sectorsUsed());
  }

  // -------------------------------------------------------------- persistence

  load() {
    if (!this.store) return;
    try {
      const raw = this.store.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw) as { slots: (null | (Omit<MockSound, 'icon' | 'audio'> & { icon: string; audio: string }))[] };
      if (!Array.isArray(data.slots) || data.slots.length !== SLOTS) return;
      this.slots = data.slots.map((s) => (s ? { ...s, icon: unb64(s.icon), audio: unb64(s.audio) } : null));
    } catch {
      this.slots = new Array(SLOTS).fill(null);
    }
  }

  save() {
    this.events.onChange?.();
    if (!this.store) return;
    try {
      const data = { slots: this.slots.map((s) => (s ? { ...s, icon: b64(s.icon), audio: b64(s.audio) } : null)) };
      this.store.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      /* quota or disabled storage: keep running in memory */
    }
  }

  clearStorage() {
    try {
      this.store?.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }

  /** A USB reconnect aborts any open transfer. */
  usbReconnect() {
    this.transfer = null;
  }

  // -------------------------------------------------------------- frame handling

  /** Handle one incoming SysEx message; returns the reply frame or null (not ours). */
  handle(msg: Uint8Array): Uint8Array | null {
    this.lastWasErase = false;
    const p = parseFrame(msg);
    if (!p.ok) {
      if (p.reason === 'not-ours') return null;
      if (p.cmd === undefined || p.seq === undefined || p.cmd > 0x7f || p.seq > 0x7f) return null;
      // not cached: a corrected resend must be processed
      return buildFrame(p.cmd | REPLY_FLAG, p.seq, Uint8Array.of(Status.BAD_FRAME));
    }
    const { cmd, seq, body } = p.frame;
    if (this.last && this.last.cmd === cmd && this.last.seq === seq) return this.last.reply;
    let replyBody: Uint8Array;
    try {
      replyBody = this.dispatch(cmd, body);
    } catch (e) {
      if (e instanceof ShortBodyError) replyBody = Uint8Array.of(Status.BAD_FRAME);
      else replyBody = Uint8Array.of(Status.FLASH_ERROR);
    }
    const reply = buildFrame(cmd | REPLY_FLAG, seq, replyBody);
    this.last = { cmd, seq, reply };
    return reply;
  }

  private dispatch(cmd: number, body: Uint8Array): Uint8Array {
    const r = new Reader(body);
    const st = (s: number) => Uint8Array.of(s);
    const ok = () => new Writer().u8(Status.OK);
    const validMeta = (key: number, mode: number, gain: number, name: string, allowAuto: boolean) =>
      (key < KEYS || key === KEY_NONE || (allowAuto && key === KEY_AUTO)) &&
      mode <= 2 &&
      gain <= GAIN_MAX &&
      name.length <= NAME_MAX &&
      isPrintableAscii(name);
    const nameBytesValid = (raw: Uint8Array) => {
      // NUL padding only after the name; no embedded control bytes
      let i = 0;
      while (i < raw.length && raw[i] !== 0) {
        if (raw[i] < 0x20 || raw[i] > 0x7e) return false;
        i++;
      }
      for (; i < raw.length; i++) if (raw[i] !== 0) return false;
      return true;
    };

    switch (cmd) {
      case Cmd.HELLO:
        return new Writer()
          .u8(Status.OK)
          .bytes(
            encodeHello({
              proto: 1,
              slots: SLOTS,
              sectorsTotal: this.sectorsTotal,
              sectorsFree: this.sectorsFree(),
              sectorPayload: SECTOR_PAYLOAD,
              iconW: ICON_W,
              iconH: ICON_H,
              iconBytes: ICON_BYTES,
              maxChunk: MAX_CHUNK,
              nameMax: NAME_MAX,
            }),
          )
          .done();

      case Cmd.GET_ENTRY: {
        const slot = r.u8();
        if (slot >= SLOTS) return st(Status.BAD_SLOT);
        return ok().bytes(encodeEntry(this.entry(slot))).done();
      }

      case Cmd.GET_ICON: {
        const slot = r.u8();
        const offset = r.u16();
        const len = r.u16();
        const s = slot < SLOTS ? this.slots[slot] : null;
        if (!s) return st(Status.BAD_SLOT);
        if (len < 1 || len > MAX_CHUNK || offset + len > ICON_BYTES) return st(Status.BAD_ARG);
        return ok().u8(slot).u16(offset).bytes(s.icon.subarray(offset, offset + len)).done();
      }

      case Cmd.BEGIN: {
        const a = decodeBegin(r);
        const nameRaw = body.subarray(16, 16 + NAME_MAX);
        this.transfer = null; // a new BEGIN aborts any open transfer
        let slot = a.slot;
        let sectors: number;
        if (a.kind === BeginKind.SOUND) {
          if (slot === SLOT_AUTO) {
            slot = this.slots.findIndex((s) => s === null);
            if (slot < 0) return st(Status.BAD_SLOT);
          } else if (slot >= SLOTS) return st(Status.BAD_SLOT);
          if (
            a.frames < 1 ||
            a.total !== ICON_BYTES + Math.ceil(a.frames / 2) ||
            a.rate < RATE_MIN ||
            a.rate > RATE_MAX ||
            !nameBytesValid(nameRaw) ||
            !validMeta(a.key, a.mode, a.gain, a.name, true)
          )
            return st(Status.BAD_ARG);
          sectors = Math.ceil(a.total / SECTOR_PAYLOAD);
          if (sectors > 255) return st(Status.NO_SPACE);
        } else if (a.kind === BeginKind.ICON) {
          if (slot >= SLOTS || !this.slots[slot]) return st(Status.BAD_SLOT);
          if (a.total !== ICON_BYTES) return st(Status.BAD_ARG);
          sectors = 1; // the device writes a copy of the sound's first sector
        } else return st(Status.BAD_ARG);
        if (sectors > this.sectorsFree()) return st(Status.NO_SPACE);
        this.transfer = {
          kind: a.kind,
          slot,
          total: a.total,
          rate: a.rate,
          frames: a.frames,
          key: a.key,
          mode: a.mode,
          gain: a.gain,
          name: a.name,
          sectors,
          buf: new Uint8Array(a.total),
          next: 0,
        };
        return ok().u8(slot).u8(sectors).done();
      }

      case Cmd.DATA: {
        const offset = r.u32();
        const data = r.rest();
        const t = this.transfer;
        if (!t) return st(Status.BUSY);
        if (data.length < 1 || data.length > MAX_CHUNK) return st(Status.BAD_ARG);
        if (offset < t.next) return ok().u32(t.next).done(); // already written: acknowledge, don't rewrite
        if (offset > t.next) return new Writer().u8(Status.BAD_OFFSET).u32(t.next).done();
        if (offset + data.length > t.total) return st(Status.BAD_ARG);
        const before = Math.floor((t.next - 1) / SECTOR_PAYLOAD);
        t.buf.set(data, offset);
        t.next = offset + data.length;
        this.lastWasErase = offset === 0 || Math.floor((t.next - 1) / SECTOR_PAYLOAD) !== before;
        return ok().u32(t.next).done();
      }

      case Cmd.COMMIT: {
        const crc = r.u32();
        const t = this.transfer;
        if (!t) return st(Status.BUSY);
        if (t.next !== t.total) return new Writer().u8(Status.BAD_OFFSET).u32(t.next).done();
        if (crc32(t.buf) !== crc) {
          this.transfer = null;
          return st(Status.CRC_MISMATCH);
        }
        this.transfer = null;
        if (t.kind === BeginKind.ICON) {
          const s = this.slots[t.slot];
          if (!s) return st(Status.BAD_SLOT);
          s.icon = t.buf.slice(0, ICON_BYTES);
        } else {
          let key = t.key;
          if (key === KEY_AUTO) {
            key = t.slot < KEYS && !this.slots.some((s, i) => i !== t.slot && s?.key === t.slot) ? t.slot : KEY_NONE;
          }
          this.slots[t.slot] = {
            key,
            mode: t.mode,
            gain: t.gain,
            name: t.name,
            rate: t.rate,
            frames: t.frames,
            sectors: t.sectors,
            icon: t.buf.slice(0, ICON_BYTES),
            audio: t.buf.slice(ICON_BYTES),
          };
          this.moveKey(t.slot, key);
        }
        this.save();
        return ok().u8(t.slot).done();
      }

      case Cmd.ABORT:
        this.transfer = null;
        return st(Status.OK);

      case Cmd.SET_META: {
        const slot = r.u8();
        const key = r.u8();
        const mode = r.u8();
        const gain = r.u16();
        const nameRaw = r.bytes(NAME_MAX);
        const s = slot < SLOTS ? this.slots[slot] : null;
        if (!s) return st(Status.BAD_SLOT);
        let name = '';
        for (let i = 0; i < nameRaw.length && nameRaw[i]; i++) name += String.fromCharCode(nameRaw[i]);
        if (!nameBytesValid(nameRaw) || !validMeta(key, mode, gain, name, false)) return st(Status.BAD_ARG);
        if (this.transfer) return st(Status.BUSY);
        Object.assign(s, { key, mode, gain, name });
        this.moveKey(slot, key);
        this.save();
        return st(Status.OK);
      }

      case Cmd.DELETE: {
        const slot = r.u8();
        if (slot >= SLOTS || !this.slots[slot]) return st(Status.BAD_SLOT);
        if (this.transfer) return st(Status.BUSY);
        this.slots[slot] = null;
        this.save();
        return st(Status.OK);
      }

      case Cmd.SWAP: {
        const a = r.u8();
        const b = r.u8();
        if (a >= SLOTS || b >= SLOTS) return st(Status.BAD_SLOT);
        if (this.transfer) return st(Status.BUSY);
        [this.slots[a], this.slots[b]] = [this.slots[b], this.slots[a]];
        this.save();
        return st(Status.OK);
      }

      case Cmd.PLAY: {
        const slot = r.u8();
        if (slot === PLAY_STOP) {
          this.events.onPlay?.(PLAY_STOP, null);
          return st(Status.OK);
        }
        if (slot >= SLOTS || !this.slots[slot]) return st(Status.BAD_SLOT);
        this.events.onPlay?.(slot, this.slots[slot]);
        return st(Status.OK);
      }

      case Cmd.FORMAT: {
        const magic = r.bytes(4);
        if (String.fromCharCode(...magic) !== 'WIPE') return st(Status.BAD_ARG);
        this.transfer = null;
        this.slots = new Array(SLOTS).fill(null);
        this.save();
        return st(Status.OK);
      }

      default:
        return st(Status.UNKNOWN_CMD);
    }
  }

  private moveKey(slot: number, key: number) {
    if (key === KEY_NONE) return;
    this.slots.forEach((s, i) => {
      if (s && i !== slot && s.key === key) s.key = KEY_NONE;
    });
  }

  entry(slot: number): Entry {
    const s = this.slots[slot];
    if (!s)
      return { slot, used: false, key: KEY_NONE, mode: 0, gain: 0, rate: 0, frames: 0, audioBytes: 0, sectors: 0, name: '' };
    return {
      slot,
      used: true,
      key: s.key,
      mode: s.mode,
      gain: s.gain,
      rate: s.rate,
      frames: s.frames,
      audioBytes: s.audio.length,
      sectors: s.sectors,
      name: s.name,
    };
  }
}
