// Host side of the protocol: a request queue with one request in flight, timeouts, and resends on the same seq.

import { crc32 } from './crc32';
import {
  BeginKind,
  Cmd,
  ICON_BYTES,
  MAX_CHUNK,
  REPLY_FLAG,
  Reader,
  Status,
  StatusError,
  buildFrame,
  decodeEntry,
  decodeHello,
  parseFrame,
  req,
  type Entry,
  type HelloInfo,
  type Meta,
} from './protocol';
import type { Transport } from './transport';

export const TIMEOUT_MS = 1500;
export const DATA_TIMEOUT_MS = 3000;
export const RESENDS = 3; // attempts = 1 + RESENDS

export class TimeoutError extends Error {
  constructor(public cmd: number) {
    super(`no reply to ${cmdName(cmd)}`);
  }
}

export class DisconnectedError extends Error {
  constructor() {
    super('device disconnected');
  }
}

function cmdName(cmd: number) {
  return Object.entries(Cmd).find(([, v]) => v === cmd)?.[0] ?? `0x${cmd.toString(16)}`;
}

export interface RequestOptions {
  timeout?: number;
  resends?: number;
}

interface InFlight {
  cmd: number;
  seq: number;
  resolve: (body: Uint8Array) => void;
  reject: (e: Error) => void;
}

export interface LogEntry {
  t: number;
  dir: 'tx' | 'rx' | 'info';
  text: string;
}

export interface UploadProgress {
  sent: number;
  total: number;
}

export class Client {
  private seq: number;
  private chain: Promise<unknown> = Promise.resolve();
  private inflight: InFlight | null = null;
  private unsubs: (() => void)[] = [];
  stats = { requests: 0, resends: 0, timeouts: 0 };
  onLog: ((e: LogEntry) => void) | null = null;

  constructor(
    public transport: Transport,
    startSeq = Math.floor(Math.random() * 128),
  ) {
    // Start at a random seq so a reloaded page doesn't collide with the device's cached (cmd, seq).
    this.seq = startSeq & 0x7f;
    this.unsubs.push(transport.onMessage((m) => this.onMessage(m)));
    this.unsubs.push(
      transport.onState((s) => {
        if (s === 'disconnected' && this.inflight) {
          const f = this.inflight;
          this.inflight = null;
          f.reject(new DisconnectedError());
        }
      }),
    );
  }

  close() {
    this.unsubs.forEach((u) => u());
    this.transport.close();
  }

  private log(dir: LogEntry['dir'], text: string) {
    this.onLog?.({ t: Date.now(), dir, text });
  }

  private onMessage(msg: Uint8Array) {
    const p = parseFrame(msg);
    if (!p.ok) {
      if (p.reason === 'bad-frame') this.log('rx', `bad frame from device (${p.detail})`);
      return;
    }
    const f = this.inflight;
    const { cmd, seq } = p.frame;
    if (!f || cmd !== (f.cmd | REPLY_FLAG) || seq !== f.seq) return; // stale or unrelated
    this.inflight = null;
    f.resolve(p.frame.body);
  }

  /**
   * Send one request and wait for its reply. Requests are serialised: only one is ever in flight.
   * On timeout the same frame (same seq) is resent. Returns the reply body after the status byte;
   * a non-zero status throws StatusError.
   */
  request(cmd: number, body: Uint8Array = new Uint8Array(0), opts: RequestOptions = {}): Promise<Uint8Array> {
    const run = () => this.run(cmd, body, opts);
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }

  private async run(cmd: number, body: Uint8Array, opts: RequestOptions): Promise<Uint8Array> {
    const seq = this.seq;
    this.seq = (this.seq + 1) & 0x7f;
    const frame = buildFrame(cmd, seq, body);
    const timeout = opts.timeout ?? (cmd === Cmd.DATA ? DATA_TIMEOUT_MS : TIMEOUT_MS);
    const resends = opts.resends ?? RESENDS;
    this.stats.requests++;
    if (cmd !== Cmd.DATA && cmd !== Cmd.GET_ICON && cmd !== Cmd.GET_ENTRY) this.log('tx', `${cmdName(cmd)} seq ${seq}`);

    for (let attempt = 0; attempt <= resends; attempt++) {
      if (this.transport.state !== 'connected') throw new DisconnectedError();
      if (attempt > 0) {
        this.stats.resends++;
        this.log('info', `resend ${cmdName(cmd)} seq ${seq} (attempt ${attempt + 1})`);
      }
      const reply = await new Promise<Uint8Array | null>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (this.inflight?.seq === seq) this.inflight = null;
          resolve(null);
        }, timeout);
        this.inflight = {
          cmd,
          seq,
          resolve: (b) => {
            clearTimeout(timer);
            resolve(b);
          },
          reject: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        };
        try {
          this.transport.send(frame);
        } catch (e) {
          clearTimeout(timer);
          this.inflight = null;
          reject(e as Error);
        }
      });
      if (reply === null) continue;
      if (reply.length < 1) throw new StatusError(cmd, Status.BAD_FRAME, reply);
      const status = reply[0];
      if (status === Status.BAD_FRAME && attempt < resends) {
        // Our frame was corrupted in transit; the device does not cache that reply, so resend.
        continue;
      }
      if (status !== Status.OK) {
        this.log('rx', `${cmdName(cmd)} seq ${seq}: status ${status}`);
        throw new StatusError(cmd, status, reply.subarray(1));
      }
      return reply.subarray(1);
    }
    this.stats.timeouts++;
    this.log('info', `${cmdName(cmd)} seq ${seq}: timed out`);
    throw new TimeoutError(cmd);
  }

  // -------------------------------------------------------------- commands

  async hello(): Promise<HelloInfo> {
    return decodeHello(new Reader(await this.request(Cmd.HELLO, req.hello())));
  }

  async getEntry(slot: number): Promise<Entry> {
    return decodeEntry(new Reader(await this.request(Cmd.GET_ENTRY, req.getEntry(slot))));
  }

  async getIcon(slot: number, iconBytes = ICON_BYTES, maxChunk = MAX_CHUNK): Promise<Uint8Array> {
    const out = new Uint8Array(iconBytes);
    for (let off = 0; off < iconBytes; off += maxChunk) {
      const len = Math.min(maxChunk, iconBytes - off);
      const r = new Reader(await this.request(Cmd.GET_ICON, req.getIcon(slot, off, len)));
      const rslot = r.u8();
      const roff = r.u16();
      const data = r.rest();
      if (rslot !== slot || roff !== off || data.length !== len) throw new Error(`GET_ICON: unexpected reply for slot ${slot}`);
      out.set(data, off);
    }
    return out;
  }

  async setMeta(slot: number, m: Meta) {
    await this.request(Cmd.SET_META, req.setMeta(slot, m));
  }

  async delete(slot: number) {
    await this.request(Cmd.DELETE, req.delete(slot));
  }

  async swap(a: number, b: number) {
    await this.request(Cmd.SWAP, req.swap(a, b));
  }

  async play(slot: number) {
    await this.request(Cmd.PLAY, req.play(slot));
  }

  async format() {
    await this.request(Cmd.FORMAT, req.format());
  }

  async abort() {
    await this.request(Cmd.ABORT, req.abort());
  }

  /**
   * BEGIN / DATA… / COMMIT. `stream` is icon + audio (kind 0) or just the icon (kind 1).
   * Returns the slot the device stored it in.
   */
  async upload(
    begin: { kind: number; slot: number; rate: number; frames: number } & Meta,
    stream: Uint8Array,
    onProgress?: (p: UploadProgress) => void,
    maxChunk = MAX_CHUNK,
    signal?: AbortSignal,
  ): Promise<{ slot: number; sectors: number; crc: number }> {
    const total = stream.length;
    const b = new Reader(await this.request(Cmd.BEGIN, req.begin({ ...begin, total })));
    const slot = b.u8();
    const sectors = b.u8();
    const crc = crc32(stream);
    try {
      let offset = 0;
      let guard = Math.ceil(total / maxChunk) * 4 + 8;
      onProgress?.({ sent: 0, total });
      while (offset < total) {
        if (signal?.aborted) throw new Error('upload cancelled');
        if (--guard < 0) throw new Error('DATA: device is not making progress');
        const chunk = stream.subarray(offset, Math.min(total, offset + maxChunk));
        let next: number;
        try {
          next = new Reader(await this.request(Cmd.DATA, req.data(offset, chunk))).u32();
        } catch (e) {
          if (e instanceof StatusError && e.status === Status.BAD_OFFSET && e.body.length >= 4) {
            next = new Reader(e.body).u32();
            this.log('info', `DATA: device expects offset ${next}`);
          } else throw e;
        }
        if (next > total) throw new Error(`DATA: device reported next ${next} past the end`);
        offset = next;
        onProgress?.({ sent: offset, total });
      }
      const c = new Reader(await this.request(Cmd.COMMIT, req.commit(crc)));
      return { slot: c.u8(), sectors, crc };
    } catch (e) {
      // CRC mismatch already aborted on the device; otherwise close the transfer explicitly.
      if (!(e instanceof StatusError && e.status === Status.CRC_MISMATCH)) {
        try {
          await this.abort();
        } catch {
          /* ignore */
        }
      }
      throw e;
    }
  }

  uploadIcon(slot: number, icon: Uint8Array, onProgress?: (p: UploadProgress) => void, maxChunk = MAX_CHUNK) {
    return this.upload(
      { kind: BeginKind.ICON, slot, rate: 0, frames: 0, key: 0, mode: 0, gain: 0, name: '' },
      icon,
      onProgress,
      maxChunk,
    );
  }
}
