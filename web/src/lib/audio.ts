// Audio preparation: decode -> mono -> 16 kHz -> trim -> normalise -> IMA ADPCM.

import { decodeAdpcm, encodeAdpcm, floatToInt16, int16ToFloat } from './adpcm';
import { DEFAULT_RATE } from './protocol';

export function dbToLin(db: number) {
  return Math.pow(10, db / 20);
}

export function linToDb(v: number) {
  return v > 0 ? 20 * Math.log10(v) : -Infinity;
}

export function peak(x: Float32Array, start = 0, end = x.length): number {
  let p = 0;
  for (let i = start; i < end; i++) {
    const a = Math.abs(x[i]);
    if (a > p) p = a;
  }
  return p;
}

/**
 * Find the [start, end) range left after removing leading and trailing silence.
 * A sample is "loud" when |x| >= threshold (linear). `padSamples` keeps a little context on both sides.
 */
export function findSilenceTrim(x: Float32Array, thresholdDb: number, padSamples = 0): { start: number; end: number } {
  const t = dbToLin(thresholdDb);
  let s = 0;
  while (s < x.length && Math.abs(x[s]) < t) s++;
  if (s === x.length) return { start: 0, end: 0 };
  let e = x.length;
  while (e > s && Math.abs(x[e - 1]) < t) e--;
  return { start: Math.max(0, s - padSamples), end: Math.min(x.length, e + padSamples) };
}

/** Scale so the peak sits at `targetDb` dBFS. Silent input is returned unchanged. */
export function normalize(x: Float32Array, targetDb = -1): Float32Array {
  const p = peak(x);
  if (p === 0) return x.slice();
  const g = dbToLin(targetDb) / p;
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i] * g;
  return out;
}

export function downmix(buf: AudioBuffer): Float32Array {
  const n = buf.length;
  const out = new Float32Array(n);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += d[i];
  }
  if (buf.numberOfChannels > 1) for (let i = 0; i < n; i++) out[i] /= buf.numberOfChannels;
  return out;
}

/** Decode a file with Web Audio, downmix to mono and resample to `rate` with an OfflineAudioContext. */
export async function decodeToMono(file: Blob, rate = DEFAULT_RATE): Promise<{ samples: Float32Array; sourceRate: number; sourceChannels: number; sourceDuration: number }> {
  const bytes = await file.arrayBuffer();
  // decodeAudioData on an OfflineAudioContext avoids needing a user gesture.
  const decoder = new OfflineAudioContext(1, 1, 44100);
  const decoded = await decoder.decodeAudioData(bytes);
  const mono = downmix(decoded);
  const outLen = Math.max(1, Math.ceil((mono.length * rate) / decoded.sampleRate));
  const ctx = new OfflineAudioContext(1, outLen, rate);
  const src = ctx.createBuffer(1, mono.length, decoded.sampleRate);
  src.copyToChannel(mono, 0);
  const node = ctx.createBufferSource();
  node.buffer = src;
  node.connect(ctx.destination);
  node.start();
  const rendered = await ctx.startRendering();
  return {
    samples: rendered.getChannelData(0).slice(),
    sourceRate: decoded.sampleRate,
    sourceChannels: decoded.numberOfChannels,
    sourceDuration: decoded.duration,
  };
}

export interface Prepared {
  pcm: Int16Array; // what was encoded
  adpcm: Uint8Array;
  decoded: Float32Array; // ADPCM decoded back, for audition
  frames: number;
  rate: number;
}

export function prepare(samples: Float32Array, start: number, end: number, doNormalize: boolean, rate = DEFAULT_RATE): Prepared {
  let x = samples.subarray(start, end);
  x = doNormalize ? normalize(x, -1) : x;
  const pcm = floatToInt16(x);
  const adpcm = encodeAdpcm(pcm);
  const decoded = int16ToFloat(decodeAdpcm(adpcm, pcm.length));
  return { pcm, adpcm, decoded, frames: pcm.length, rate };
}

// ---------------------------------------------------------------- playback

let ctx: AudioContext | null = null;
let current: AudioBufferSourceNode | null = null;

export function audioContext(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

export function playSamples(x: Float32Array, rate: number, gain = 1, loop = false): AudioBufferSourceNode | null {
  if (x.length === 0) return null;
  stopPlayback();
  const ac = audioContext();
  const buf = ac.createBuffer(1, x.length, rate);
  buf.copyToChannel(x as Float32Array<ArrayBuffer>, 0);
  const src = ac.createBufferSource();
  src.buffer = buf;
  src.loop = loop;
  const g = ac.createGain();
  g.gain.value = gain;
  src.connect(g).connect(ac.destination);
  src.start();
  current = src;
  src.onended = () => {
    if (current === src) current = null;
  };
  return src;
}

export function stopPlayback() {
  try {
    current?.stop();
  } catch {
    /* already stopped */
  }
  current = null;
}
