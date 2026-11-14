// Mono IMA ADPCM, 4 bits per sample, per docs/protocol.md:
// standard 89-entry step table and index table, decoder starts at predictor 0 / index 0,
// first sample of each byte in the LOW nibble, audio_bytes = ceil(frames / 2).

export const STEP_TABLE = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107,
  118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
  1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894,
  6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
  32767,
];

export const INDEX_TABLE = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];

export interface AdpcmState {
  predictor: number;
  index: number;
}

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Decode one nibble, updating the state; returns the new sample. */
export function decodeNibble(nibble: number, st: AdpcmState): number {
  const step = STEP_TABLE[st.index];
  let diff = step >> 3;
  if (nibble & 4) diff += step;
  if (nibble & 2) diff += step >> 1;
  if (nibble & 1) diff += step >> 2;
  st.predictor = clamp(nibble & 8 ? st.predictor - diff : st.predictor + diff, -32768, 32767);
  st.index = clamp(st.index + INDEX_TABLE[nibble & 15], 0, 88);
  return st.predictor;
}

/** Encode one sample, updating the state exactly as the decoder will; returns the nibble. */
export function encodeSample(sample: number, st: AdpcmState): number {
  const step = STEP_TABLE[st.index];
  let diff = sample - st.predictor;
  let nibble = 0;
  if (diff < 0) {
    nibble = 8;
    diff = -diff;
  }
  let s = step;
  if (diff >= s) {
    nibble |= 4;
    diff -= s;
  }
  s >>= 1;
  if (diff >= s) {
    nibble |= 2;
    diff -= s;
  }
  s >>= 1;
  if (diff >= s) nibble |= 1;
  decodeNibble(nibble, st); // keep encoder state identical to the decoder's
  return nibble;
}

/** Encode 16-bit PCM samples. Odd frame counts pad the last high nibble with 0. */
export function encodeAdpcm(pcm: Int16Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(pcm.length / 2));
  const st: AdpcmState = { predictor: 0, index: 0 };
  for (let i = 0; i < pcm.length; i++) {
    const n = encodeSample(pcm[i], st);
    if (i & 1) out[i >> 1] |= n << 4;
    else out[i >> 1] = n;
  }
  return out;
}

export function decodeAdpcm(data: Uint8Array, frames = data.length * 2): Int16Array {
  const out = new Int16Array(frames);
  const st: AdpcmState = { predictor: 0, index: 0 };
  for (let i = 0; i < frames; i++) {
    const b = data[i >> 1];
    out[i] = decodeNibble(i & 1 ? b >> 4 : b & 15, st);
  }
  return out;
}

export function floatToInt16(f: Float32Array): Int16Array {
  const out = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) out[i] = clamp(Math.round(f[i] * 32767), -32768, 32767);
  return out;
}

export function int16ToFloat(p: Int16Array): Float32Array {
  const out = new Float32Array(p.length);
  for (let i = 0; i < p.length; i++) out[i] = p[i] / 32768;
  return out;
}
