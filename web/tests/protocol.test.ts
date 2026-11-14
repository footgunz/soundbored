import { describe, expect, it } from 'vitest';
import {
  Cmd,
  Reader,
  buildFrame,
  checksum,
  decodeEntry,
  encodeEntry,
  encodeName,
  decodeName,
  keyName,
  pack7,
  packedLength,
  parseFrame,
  req,
  decodeBegin,
  slotPosition,
  unpack7,
} from '../src/lib/protocol';

function rnd(n: number, seed = 1) {
  const out = new Uint8Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) >>> 0;
    out[i] = s >>> 24;
  }
  return out;
}

describe('pack7', () => {
  it('known vector [0x80, 0x01] -> [0x01, 0x00, 0x01]', () => {
    expect([...pack7(Uint8Array.of(0x80, 0x01))]).toEqual([0x01, 0x00, 0x01]);
    expect([...unpack7(Uint8Array.of(0x01, 0x00, 0x01))]).toEqual([0x80, 0x01]);
  });

  it('header bit i is bit 7 of byte i', () => {
    const raw = Uint8Array.of(0x00, 0xff, 0x00, 0x80, 0, 0, 0x81, 0xaa);
    const p = pack7(raw);
    expect(p[0]).toBe(0b1001010);
    expect([...p.subarray(1, 8)]).toEqual([0x00, 0x7f, 0x00, 0x00, 0, 0, 0x01]);
    expect([...p.subarray(8)]).toEqual([0x01, 0x2a]);
  });

  for (const n of [...Array.from({ length: 21 }, (_, i) => i), 512]) {
    it(`round trip, length ${n}`, () => {
      for (const seed of [1, 2, 3]) {
        const raw = rnd(n, seed + n);
        const p = pack7(raw);
        expect(p.length).toBe(packedLength(n));
        expect(p.length).toBe(n + Math.ceil(n / 7));
        for (const b of p) expect(b & 0x80).toBe(0);
        expect([...unpack7(p)]).toEqual([...raw]);
      }
      const ones = new Uint8Array(n).fill(0xff);
      expect([...unpack7(pack7(ones))]).toEqual([...ones]);
    });
  }

  it('rejects malformed input', () => {
    expect(() => unpack7(Uint8Array.of(0x00))).toThrow();
    expect(() => unpack7(Uint8Array.of(0x00, 0x80))).toThrow();
  });
});

describe('checksum and frames', () => {
  it('checksum is the 7-bit sum', () => {
    expect(checksum([0x01, 0x02, 0x7f])).toBe((1 + 2 + 0x7f) & 0x7f);
    expect(checksum([])).toBe(0);
  });

  it('HELLO frame is exact', () => {
    const f = buildFrame(Cmd.HELLO, 5);
    // F0 7D 53 42 cmd seq chk F7, chk = (1 + 5) & 0x7f
    expect([...f]).toEqual([0xf0, 0x7d, 0x53, 0x42, 0x01, 0x05, 0x06, 0xf7]);
  });

  it('GET_ENTRY frame is exact', () => {
    const f = buildFrame(Cmd.GET_ENTRY, 0x7f, Uint8Array.of(0x80 | 3));
    // body [0x83] -> packed [0x01, 0x03]; chk = (0x02 + 0x7f + 0x01 + 0x03) & 0x7f
    expect([...f]).toEqual([0xf0, 0x7d, 0x53, 0x42, 0x02, 0x7f, 0x01, 0x03, (0x02 + 0x7f + 0x01 + 0x03) & 0x7f, 0xf7]);
  });

  it('build/parse round trip, and a max DATA frame fits in 640 bytes', () => {
    const body = req.data(123456, rnd(512, 9));
    const f = buildFrame(Cmd.DATA, 42, body);
    expect(f.length - 2).toBeLessThanOrEqual(640);
    const p = parseFrame(f);
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(p.frame.cmd).toBe(Cmd.DATA);
      expect(p.frame.seq).toBe(42);
      expect([...p.frame.body]).toEqual([...body]);
    }
  });

  it('parse rejects a bad checksum and ignores foreign SysEx', () => {
    const f = buildFrame(Cmd.HELLO, 1, Uint8Array.of(1, 2, 3));
    f[f.length - 2] ^= 1;
    const p = parseFrame(f);
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.reason).toBe('bad-frame');
    const other = parseFrame(Uint8Array.of(0xf0, 0x7d, 0x4c, 0x00, 0xf7));
    expect(!other.ok && other.reason).toBe('not-ours');
  });

  it('integers are little-endian', () => {
    const b = req.getIcon(7, 0x0200, 0x01a0);
    expect([...b]).toEqual([7, 0x00, 0x02, 0xa0, 0x01]);
    expect([...req.commit(0xcbf43926)]).toEqual([0x26, 0x39, 0xf4, 0xcb]);
  });

  it('BEGIN body layout', () => {
    const b = req.begin({ kind: 0, slot: 0xff, total: 1184 + 5, rate: 16000, frames: 10, key: 0xfe, mode: 2, gain: 256, name: 'Hi' });
    expect(b.length).toBe(1 + 1 + 4 + 2 + 4 + 1 + 1 + 2 + 16);
    expect([...b.subarray(0, 16)]).toEqual([0, 0xff, 0xa5, 0x04, 0, 0, 0x80, 0x3e, 10, 0, 0, 0, 0xfe, 2, 0x00, 0x01]);
    expect(decodeBegin(new Reader(b)).name).toBe('Hi');
  });

  it('entry round trip, names NUL-padded', () => {
    const e = { slot: 3, used: true, key: 0, mode: 1, gain: 300, rate: 16000, frames: 12345, audioBytes: 6173, sectors: 2, name: 'Sixteen chars!!!' };
    expect(decodeEntry(new Reader(encodeEntry(e)))).toEqual(e);
    expect([...encodeName('ab')]).toEqual([0x61, 0x62, ...new Array(14).fill(0)]);
    expect(decodeName(encodeName('ab'))).toBe('ab');
    expect(() => encodeName('x'.repeat(17))).toThrow();
    expect(() => encodeName('é')).toThrow();
  });

  it('keys and slots', () => {
    expect(keyName(0)).toBe('F3');
    expect(keyName(7)).toBe('C4');
    expect(keyName(26)).toBe('G5');
    expect(keyName(0xff)).toBe('—');
    expect(slotPosition(17)).toEqual({ page: 1, row: 1, col: 1 });
  });
});
