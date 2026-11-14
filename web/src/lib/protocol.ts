// soundbored SysEx protocol v1 — see docs/protocol.md (the contract).
// Framing: F0 7D 53 42 <cmd> <seq> <pack7(body)...> <chk> F7

export const MANUFACTURER = 0x7d;
export const MAGIC = [0x53, 0x42] as const; // "SB"
export const HEADER = [0xf0, MANUFACTURER, ...MAGIC] as const;
export const MAX_FRAME = 640; // bytes between F0 and F7
export const MAX_CHUNK = 512; // raw data bytes per chunk, before packing
export const REPLY_FLAG = 0x40;

export const SLOTS = 48;
export const SECTOR_PAYLOAD = 3840;
export const ICON_W = 48;
export const ICON_H = 48;
export const ICON_PALETTE_BYTES = 32;
export const ICON_BYTES = ICON_PALETTE_BYTES + (ICON_W * ICON_H) / 2; // 1184
export const NAME_MAX = 16;
export const KEYS = 27;
export const KEY_NONE = 0xff;
export const KEY_AUTO = 0xfe;
export const SLOT_AUTO = 0xff;
export const PLAY_STOP = 0xff;
export const KEY_BASE_NOTE = 53; // key 0 = F3 = MIDI 53
export const GAIN_UNITY = 256;
export const GAIN_MAX = 512;
export const RATE_MIN = 4000;
export const RATE_MAX = 44100;
export const DEFAULT_RATE = 16000;

export const Cmd = {
  HELLO: 0x01,
  GET_ENTRY: 0x02,
  GET_ICON: 0x03,
  BEGIN: 0x10,
  DATA: 0x11,
  COMMIT: 0x12,
  ABORT: 0x13,
  SET_META: 0x20,
  DELETE: 0x21,
  SWAP: 0x22,
  PLAY: 0x23,
  FORMAT: 0x24,
} as const;
export type CmdCode = (typeof Cmd)[keyof typeof Cmd];

export const CMD_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(Cmd).map(([k, v]) => [v, k]),
);

export const Status = {
  OK: 0,
  BAD_FRAME: 1,
  UNKNOWN_CMD: 2,
  BAD_SLOT: 3,
  NO_SPACE: 4,
  BUSY: 5,
  BAD_OFFSET: 6,
  CRC_MISMATCH: 7,
  FLASH_ERROR: 8,
  BAD_ARG: 9,
} as const;

export const STATUS_TEXT: Record<number, string> = {
  0: 'ok',
  1: 'bad frame',
  2: 'unknown command',
  3: 'bad slot',
  4: 'no space',
  5: 'busy / no transfer open',
  6: 'bad offset',
  7: 'CRC mismatch',
  8: 'flash error',
  9: 'bad argument',
};

export const Mode = { ONE_SHOT: 0, GATE: 1, LOOP: 2 } as const;
export const MODE_NAMES = ['one-shot', 'gate', 'loop'];

export const BeginKind = { SOUND: 0, ICON: 1 } as const;

// ---------------------------------------------------------------- pack7

/** 8-to-7 pack: groups of up to 7 bytes, each preceded by a byte holding their bit 7s (bit i = byte i). */
export function pack7(data: Uint8Array): Uint8Array {
  const groups = Math.ceil(data.length / 7);
  const out = new Uint8Array(data.length + groups);
  let o = 0;
  for (let g = 0; g < data.length; g += 7) {
    const k = Math.min(7, data.length - g);
    let hi = 0;
    for (let i = 0; i < k; i++) if (data[g + i] & 0x80) hi |= 1 << i;
    out[o++] = hi;
    for (let i = 0; i < k; i++) out[o++] = data[g + i] & 0x7f;
  }
  return out;
}

/** Inverse of pack7. Throws on malformed input (a dangling header byte, or a byte with bit 7 set). */
export function unpack7(packed: Uint8Array): Uint8Array {
  const groups = Math.ceil(packed.length / 8);
  const rawLen = packed.length - groups;
  if (packed.length % 8 === 1) throw new Error('pack7: dangling header byte');
  const out = new Uint8Array(rawLen);
  let o = 0;
  for (let p = 0; p < packed.length; p += 8) {
    const hi = packed[p];
    if (hi & 0x80) throw new Error('pack7: bit 7 set');
    const k = Math.min(7, packed.length - p - 1);
    for (let i = 0; i < k; i++) {
      const b = packed[p + 1 + i];
      if (b & 0x80) throw new Error('pack7: bit 7 set');
      out[o++] = b | (((hi >> i) & 1) << 7);
    }
  }
  return out;
}

export function packedLength(rawLen: number): number {
  return rawLen + Math.ceil(rawLen / 7);
}

// ---------------------------------------------------------------- framing

/** chk = (sum of every byte from cmd through the last packed byte) & 0x7F */
export function checksum(bytes: ArrayLike<number>, start = 0, end = bytes.length): number {
  let s = 0;
  for (let i = start; i < end; i++) s += bytes[i];
  return s & 0x7f;
}

export function buildFrame(cmd: number, seq: number, body: Uint8Array = new Uint8Array(0)): Uint8Array {
  if (cmd < 0 || cmd > 0x7f) throw new Error(`cmd out of range: ${cmd}`);
  if (seq < 0 || seq > 0x7f) throw new Error(`seq out of range: ${seq}`);
  const packed = pack7(body);
  const frame = new Uint8Array(4 + 2 + packed.length + 2);
  frame.set(HEADER, 0);
  frame[4] = cmd;
  frame[5] = seq;
  frame.set(packed, 6);
  frame[6 + packed.length] = checksum(frame, 4, 6 + packed.length);
  frame[frame.length - 1] = 0xf7;
  if (frame.length - 2 > MAX_FRAME) throw new Error(`frame too long: ${frame.length - 2}`);
  return frame;
}

export interface Frame {
  cmd: number;
  seq: number;
  body: Uint8Array;
}

export type ParseResult =
  | { ok: true; frame: Frame }
  | { ok: false; reason: 'not-ours' }
  | { ok: false; reason: 'bad-frame'; cmd?: number; seq?: number; detail: string };

/** Parse a full SysEx message (F0 … F7). */
export function parseFrame(msg: Uint8Array): ParseResult {
  if (msg.length < 4 || msg[0] !== 0xf0 || msg[1] !== MANUFACTURER || msg[2] !== MAGIC[0] || msg[3] !== MAGIC[1]) {
    return { ok: false, reason: 'not-ours' };
  }
  const cmd = msg.length > 4 ? msg[4] : undefined;
  const seq = msg.length > 5 ? msg[5] : undefined;
  const bad = (detail: string): ParseResult => ({ ok: false, reason: 'bad-frame', cmd, seq, detail });
  if (msg[msg.length - 1] !== 0xf7) return bad('missing F7');
  if (msg.length - 2 > MAX_FRAME) return bad('frame too long');
  if (msg.length < 8) return bad('frame too short');
  const chkPos = msg.length - 2;
  for (let i = 4; i <= chkPos; i++) if (msg[i] & 0x80) return bad('data byte with bit 7 set');
  if (checksum(msg, 4, chkPos) !== msg[chkPos]) return bad('checksum');
  let body: Uint8Array;
  try {
    body = unpack7(msg.subarray(6, chkPos));
  } catch (e) {
    return bad(String((e as Error).message));
  }
  return { ok: true, frame: { cmd: cmd!, seq: seq!, body } };
}

// ---------------------------------------------------------------- byte helpers

export class Writer {
  private buf: number[] = [];
  u8(v: number) {
    this.buf.push(v & 0xff);
    return this;
  }
  u16(v: number) {
    this.buf.push(v & 0xff, (v >>> 8) & 0xff);
    return this;
  }
  u32(v: number) {
    this.buf.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
    return this;
  }
  bytes(b: ArrayLike<number>) {
    for (let i = 0; i < b.length; i++) this.buf.push(b[i] & 0xff);
    return this;
  }
  done(): Uint8Array {
    return Uint8Array.from(this.buf);
  }
}

export class Reader {
  pos = 0;
  constructor(private b: Uint8Array) {}
  get remaining() {
    return this.b.length - this.pos;
  }
  private need(n: number) {
    if (this.pos + n > this.b.length) throw new ShortBodyError();
  }
  u8() {
    this.need(1);
    return this.b[this.pos++];
  }
  u16() {
    this.need(2);
    const v = this.b[this.pos] | (this.b[this.pos + 1] << 8);
    this.pos += 2;
    return v;
  }
  u32() {
    this.need(4);
    const v =
      (this.b[this.pos] | (this.b[this.pos + 1] << 8) | (this.b[this.pos + 2] << 16) | (this.b[this.pos + 3] << 24)) >>>
      0;
    this.pos += 4;
    return v;
  }
  bytes(n: number) {
    this.need(n);
    const v = this.b.slice(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }
  rest() {
    return this.bytes(this.remaining);
  }
}

export class ShortBodyError extends Error {
  constructor() {
    super('body too short');
  }
}

// ---------------------------------------------------------------- names / keys

export function isPrintableAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) return false;
  }
  return true;
}

/** Make a user string a valid name: printable ASCII only, at most 16 characters. */
export function sanitizeName(s: string): string {
  let out = '';
  for (const ch of s.normalize('NFKD')) {
    const c = ch.charCodeAt(0);
    if (ch.length === 1 && c >= 0x20 && c <= 0x7e) out += ch;
    if (out.length >= NAME_MAX) break;
  }
  return out;
}

export function encodeName(name: string): Uint8Array {
  if (name.length > NAME_MAX) throw new Error('name too long');
  if (!isPrintableAscii(name)) throw new Error('name must be printable ASCII');
  const out = new Uint8Array(NAME_MAX); // NUL-padded
  for (let i = 0; i < name.length; i++) out[i] = name.charCodeAt(i);
  return out;
}

export function decodeName(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length && b[i] !== 0; i++) s += String.fromCharCode(b[i]);
  return s;
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** MIDI note name with C4 = 60, so key 0 (note 53) is F3. */
export function noteName(note: number): string {
  return NOTE_NAMES[note % 12] + (Math.floor(note / 12) - 1);
}

export function keyName(key: number): string {
  if (key === KEY_NONE) return '—';
  if (key === KEY_AUTO) return 'auto';
  if (key < 0 || key >= KEYS) return `?${key}`;
  return noteName(KEY_BASE_NOTE + key);
}

export function slotPosition(slot: number) {
  return { page: Math.floor(slot / 12), row: Math.floor((slot % 12) / 4), col: slot % 4 };
}

export function audioBytesFor(frames: number): number {
  return Math.ceil(frames / 2);
}

export function sectorsFor(totalStreamBytes: number, sectorPayload = SECTOR_PAYLOAD): number {
  return Math.ceil(totalStreamBytes / sectorPayload);
}

/** Seconds of 16 kHz ADPCM audio (8000 bytes/s) that fit in the given number of sectors. */
export function sectorsToSeconds(sectors: number, sectorPayload = SECTOR_PAYLOAD): number {
  return (sectors * sectorPayload) / 8000;
}

// ---------------------------------------------------------------- command payloads

export interface HelloInfo {
  proto: number;
  slots: number;
  sectorsTotal: number;
  sectorsFree: number;
  sectorPayload: number;
  iconW: number;
  iconH: number;
  iconBytes: number;
  maxChunk: number;
  nameMax: number;
}

export interface Meta {
  key: number;
  mode: number;
  gain: number;
  name: string;
}

export interface Entry extends Meta {
  slot: number;
  used: boolean;
  rate: number;
  frames: number;
  audioBytes: number;
  sectors: number;
}

export interface BeginArgs extends Meta {
  kind: number;
  slot: number;
  total: number;
  rate: number;
  frames: number;
}

export const req = {
  hello: () => new Uint8Array(0),
  getEntry: (slot: number) => new Writer().u8(slot).done(),
  getIcon: (slot: number, offset: number, len: number) => new Writer().u8(slot).u16(offset).u16(len).done(),
  begin: (a: BeginArgs) =>
    new Writer()
      .u8(a.kind)
      .u8(a.slot)
      .u32(a.total)
      .u16(a.rate)
      .u32(a.frames)
      .u8(a.key)
      .u8(a.mode)
      .u16(a.gain)
      .bytes(encodeName(a.name))
      .done(),
  data: (offset: number, data: Uint8Array) => new Writer().u32(offset).bytes(data).done(),
  commit: (crc: number) => new Writer().u32(crc >>> 0).done(),
  abort: () => new Uint8Array(0),
  setMeta: (slot: number, m: Meta) =>
    new Writer().u8(slot).u8(m.key).u8(m.mode).u16(m.gain).bytes(encodeName(m.name)).done(),
  delete: (slot: number) => new Writer().u8(slot).done(),
  swap: (a: number, b: number) => new Writer().u8(a).u8(b).done(),
  play: (slot: number) => new Writer().u8(slot).done(),
  format: () => Uint8Array.from([0x57, 0x49, 0x50, 0x45]), // "WIPE"
};

export function decodeHello(r: Reader): HelloInfo {
  return {
    proto: r.u8(),
    slots: r.u8(),
    sectorsTotal: r.u8(),
    sectorsFree: r.u8(),
    sectorPayload: r.u16(),
    iconW: r.u8(),
    iconH: r.u8(),
    iconBytes: r.u16(),
    maxChunk: r.u16(),
    nameMax: r.u8(),
  };
}

export function encodeHello(h: HelloInfo): Uint8Array {
  return new Writer()
    .u8(h.proto)
    .u8(h.slots)
    .u8(h.sectorsTotal)
    .u8(h.sectorsFree)
    .u16(h.sectorPayload)
    .u8(h.iconW)
    .u8(h.iconH)
    .u16(h.iconBytes)
    .u16(h.maxChunk)
    .u8(h.nameMax)
    .done();
}

export function decodeEntry(r: Reader): Entry {
  const slot = r.u8();
  const used = r.u8() !== 0;
  const key = r.u8();
  const mode = r.u8();
  const gain = r.u16();
  const rate = r.u16();
  const frames = r.u32();
  const audioBytes = r.u32();
  const sectors = r.u8();
  const name = decodeName(r.bytes(NAME_MAX));
  return { slot, used, key, mode, gain, rate, frames, audioBytes, sectors, name };
}

export function encodeEntry(e: Entry): Uint8Array {
  return new Writer()
    .u8(e.slot)
    .u8(e.used ? 1 : 0)
    .u8(e.key)
    .u8(e.mode)
    .u16(e.gain)
    .u16(e.rate)
    .u32(e.frames)
    .u32(e.audioBytes)
    .u8(e.sectors)
    .bytes(encodeName(e.name))
    .done();
}

export function decodeBegin(r: Reader): BeginArgs {
  const kind = r.u8();
  const slot = r.u8();
  const total = r.u32();
  const rate = r.u16();
  const frames = r.u32();
  const key = r.u8();
  const mode = r.u8();
  const gain = r.u16();
  const nameRaw = r.bytes(NAME_MAX);
  return { kind, slot, total, rate, frames, key, mode, gain, name: decodeName(nameRaw) };
}

/** Error raised when a reply carries a non-zero status. */
export class StatusError extends Error {
  constructor(
    public cmd: number,
    public status: number,
    public body: Uint8Array,
  ) {
    super(`${CMD_NAMES[cmd] ?? `cmd 0x${cmd.toString(16)}`}: ${STATUS_TEXT[status] ?? `status ${status}`}`);
  }
}
