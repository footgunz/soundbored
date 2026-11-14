import { describe, expect, it } from 'vitest';
import { iconToRgba, packIcon, quantizeToIcon, rgb565ToRgb, rgbTo565, unpackIcon } from '../src/lib/icon';

describe('icon packing', () => {
  it('palette first (RGB565 LE), then pixels with the high nibble = left pixel', () => {
    const pal = [0xf800, 0x07e0, 0x001f, 0x1234];
    const idx = new Uint8Array(48 * 48);
    idx[0] = 1; // left pixel of byte 0
    idx[1] = 2; // right pixel of byte 0
    idx[2] = 3;
    idx[48] = 0xf; // row 1, col 0
    const b = packIcon(pal, idx);
    expect(b.length).toBe(1184);
    expect([...b.subarray(0, 8)]).toEqual([0x00, 0xf8, 0xe0, 0x07, 0x1f, 0x00, 0x34, 0x12]);
    expect([...b.subarray(8, 32)]).toEqual(new Array(24).fill(0));
    expect(b[32]).toBe(0x12);
    expect(b[33]).toBe(0x30);
    expect(b[32 + 24]).toBe(0xf0);
    const u = unpackIcon(b);
    expect([...u.indices]).toEqual([...idx]);
    expect(u.palette565[3]).toBe(0x1234);
  });

  it('rgb565 conversions', () => {
    expect(rgbTo565(255, 255, 255)).toBe(0xffff);
    expect(rgb565ToRgb(0xffff)).toEqual([255, 255, 255]);
    expect(rgb565ToRgb(0xf800)).toEqual([255, 0, 0]);
  });

  it('quantises to at most 16 colours and renders back', () => {
    const rgba = new Uint8ClampedArray(48 * 48 * 4);
    for (let y = 0; y < 48; y++)
      for (let x = 0; x < 48; x++) {
        const i = (y * 48 + x) * 4;
        rgba[i] = x * 5;
        rgba[i + 1] = y * 5;
        rgba[i + 2] = 128;
        rgba[i + 3] = 255;
      }
    for (const dither of [false, true]) {
      const icon = quantizeToIcon(rgba, { dither });
      expect(icon.length).toBe(1184);
      const back = iconToRgba(icon);
      let err = 0;
      for (let i = 0; i < back.length; i += 4) err += Math.abs(back[i] - rgba[i]) + Math.abs(back[i + 1] - rgba[i + 1]);
      expect(err / (48 * 48)).toBeLessThan(40);
    }
  });

  it('keeps an exact two-colour image exact', () => {
    const rgba = new Uint8ClampedArray(48 * 48 * 4);
    for (let i = 0; i < 48 * 48; i++) {
      const white = (i % 48) < 24;
      rgba.set(white ? [255, 255, 255, 255] : [0, 0, 0, 255], i * 4);
    }
    const { palette565, indices } = unpackIcon(quantizeToIcon(rgba));
    expect(palette565[indices[0]]).toBe(0xffff);
    expect(palette565[indices[47]]).toBe(0x0000);
  });
});
