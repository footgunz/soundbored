import { describe, expect, it } from 'vitest';
import { decodeAdpcm, encodeAdpcm, STEP_TABLE } from '../src/lib/adpcm';

describe('IMA ADPCM', () => {
  it('tables are standard', () => {
    expect(STEP_TABLE.length).toBe(89);
    expect(STEP_TABLE[0]).toBe(7);
    expect(STEP_TABLE[88]).toBe(32767);
  });

  it('first nibbles, checked by hand', () => {
    // predictor 0, index 0 (step 7).
    // s0 = 1000: diff 1000 >= 7 -> bit4 (rem 993), >= 3 -> bit2 (rem 990), >= 1 -> bit1 => nibble 7.
    //   decoder: 7>>3=0 + 7 + 3 + 1 = 11 -> pred 11, index 0+8 = 8 (step 16).
    // s1 = 1000: diff 989 -> nibble 7; delta 2+16+8+4 = 30 -> pred 41, index 16 (step 34).
    // s2 = 0: diff -41 -> sign; 41 >= 34 -> 4 (rem 7); 7 < 17; 7 >= 8? no => nibble 0xC.
    //   delta 4 + 34 = 38 -> pred 3, index 16 + 2 = 18 (step 41).
    // s3 = 0: diff -3 -> sign; 3 < 41, 3 < 20, 3 < 10 => nibble 0x8; delta 5 -> pred -2, index 17.
    const enc = encodeAdpcm(Int16Array.of(1000, 1000, 0, 0, 5));
    // low nibble = first sample
    expect([...enc]).toEqual([0x77, 0x8c, 0x00]); // s4 = 5: diff 7 < step 37 -> nibble 0
    expect(enc[0] & 0x0f).toBe(7);
    expect(enc[1] & 0x0f).toBe(0xc);
    expect(enc[1] >> 4).toBe(0x8);
    expect(enc[2] >> 4).toBe(0); // odd frame count pads the high nibble with 0
    const dec = decodeAdpcm(enc, 4);
    expect([...dec]).toEqual([11, 41, 3, -2]);
  });

  it('decodes hand-made bytes low nibble first', () => {
    // byte 0x07: first sample nibble 7 (+11), second nibble 0 (+ step 16 >> 3 = 2 -> 13)
    expect([...decodeAdpcm(Uint8Array.of(0x07), 2)]).toEqual([11, 13]);
  });

  it('sine round trip SNR > 20 dB', () => {
    const n = 16000;
    const x = new Int16Array(n);
    for (let i = 0; i < n; i++) x[i] = Math.round(20000 * Math.sin((2 * Math.PI * 440 * i) / 16000));
    const enc = encodeAdpcm(x);
    expect(enc.length).toBe(n / 2);
    const y = decodeAdpcm(enc, n);
    let sig = 0,
      noise = 0;
    // skip the first 100 samples while the step size adapts
    for (let i = 100; i < n; i++) {
      sig += x[i] * x[i];
      noise += (x[i] - y[i]) ** 2;
    }
    const snr = 10 * Math.log10(sig / noise);
    expect(snr).toBeGreaterThan(20);
  });
});
