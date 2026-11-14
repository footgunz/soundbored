import { describe, expect, it } from 'vitest';
import { crc32 } from '../src/lib/crc32';

describe('crc32', () => {
  it('check value of "123456789"', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
  it('empty input', () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
  it('incremental equals one-shot', () => {
    const d = new TextEncoder().encode('123456789');
    expect(crc32(d.subarray(4), crc32(d.subarray(0, 4)))).toBe(0xcbf43926);
  });
});
