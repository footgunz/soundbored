// Icons: 48×48, 4 bpp, 16-entry RGB565 palette (u16 LE) first, then pixels row-major,
// two per byte with the HIGH nibble = LEFT pixel. 32 + 1152 = 1184 bytes.

import { ICON_BYTES, ICON_H, ICON_PALETTE_BYTES, ICON_W } from './protocol';

export type RGB = [number, number, number];

export function rgbTo565(r: number, g: number, b: number): number {
  return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
}

export function rgb565ToRgb(c: number): RGB {
  const r5 = (c >> 11) & 31;
  const g6 = (c >> 5) & 63;
  const b5 = c & 31;
  return [(r5 << 3) | (r5 >> 2), (g6 << 2) | (g6 >> 4), (b5 << 3) | (b5 >> 2)];
}

/** Snap an RGB colour to the nearest RGB565-representable colour (as 8-bit RGB). */
function snap565(c: RGB): RGB {
  return rgb565ToRgb(rgbTo565(clampByte(c[0]), clampByte(c[1]), clampByte(c[2])));
}

function clampByte(v: number) {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

export function packIcon(palette565: ArrayLike<number>, indices: ArrayLike<number>): Uint8Array {
  if (palette565.length > 16) throw new Error('palette has more than 16 entries');
  if (indices.length !== ICON_W * ICON_H) throw new Error('icon must be 48×48');
  const out = new Uint8Array(ICON_BYTES);
  for (let i = 0; i < 16; i++) {
    const c = i < palette565.length ? palette565[i] : 0;
    out[i * 2] = c & 0xff;
    out[i * 2 + 1] = (c >> 8) & 0xff;
  }
  for (let p = 0; p < indices.length; p += 2) {
    const left = indices[p] & 15;
    const right = indices[p + 1] & 15;
    out[ICON_PALETTE_BYTES + (p >> 1)] = (left << 4) | right;
  }
  return out;
}

export function unpackIcon(icon: Uint8Array): { palette565: Uint16Array; indices: Uint8Array } {
  if (icon.length !== ICON_BYTES) throw new Error(`icon must be ${ICON_BYTES} bytes`);
  const palette565 = new Uint16Array(16);
  for (let i = 0; i < 16; i++) palette565[i] = icon[i * 2] | (icon[i * 2 + 1] << 8);
  const indices = new Uint8Array(ICON_W * ICON_H);
  for (let p = 0; p < indices.length; p += 2) {
    const b = icon[ICON_PALETTE_BYTES + (p >> 1)];
    indices[p] = b >> 4;
    indices[p + 1] = b & 15;
  }
  return { palette565, indices };
}

/** Render a packed icon to RGBA (what the device's screen will show). */
export function iconToRgba(icon: Uint8Array): Uint8ClampedArray<ArrayBuffer> {
  const { palette565, indices } = unpackIcon(icon);
  const pal = Array.from(palette565, rgb565ToRgb);
  const out = new Uint8ClampedArray(new ArrayBuffer(indices.length * 4));
  for (let i = 0; i < indices.length; i++) {
    const c = pal[indices[i]];
    out[i * 4] = c[0];
    out[i * 4 + 1] = c[1];
    out[i * 4 + 2] = c[2];
    out[i * 4 + 3] = 255;
  }
  return out;
}

// ---------------------------------------------------------------- quantisation

interface Box {
  px: RGB[];
}

function boxRange(b: Box): { ch: number; range: number } {
  let best = { ch: 0, range: -1 };
  for (let ch = 0; ch < 3; ch++) {
    let lo = 255,
      hi = 0;
    for (const p of b.px) {
      if (p[ch] < lo) lo = p[ch];
      if (p[ch] > hi) hi = p[ch];
    }
    if (hi - lo > best.range) best = { ch, range: hi - lo };
  }
  return best;
}

function mean(px: RGB[]): RGB {
  let r = 0,
    g = 0,
    b = 0;
  for (const p of px) {
    r += p[0];
    g += p[1];
    b += p[2];
  }
  const n = px.length || 1;
  return [r / n, g / n, b / n];
}

function dist2(a: RGB, b: RGB) {
  const dr = a[0] - b[0],
    dg = a[1] - b[1],
    db = a[2] - b[2];
  // mild perceptual weighting
  return 2 * dr * dr + 4 * dg * dg + 3 * db * db;
}

function nearest(pal: RGB[], c: RGB): number {
  let best = 0,
    bd = Infinity;
  for (let i = 0; i < pal.length; i++) {
    const d = dist2(pal[i], c);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

/** Median cut to at most `n` colours, then a few k-means passes; colours are snapped to RGB565. */
export function buildPalette(pixels: RGB[], n = 16, kmeansIters = 4): RGB[] {
  const snapped = pixels.map(snap565);
  // distinct colours short-circuit
  const distinct = new Map<number, RGB>();
  for (const p of snapped) distinct.set(rgbTo565(p[0], p[1], p[2]), p);
  if (distinct.size <= n) return [...distinct.values()];

  const boxes: Box[] = [{ px: snapped }];
  while (boxes.length < n) {
    let bi = -1,
      score = -1,
      ch = 0;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].px.length < 2) continue;
      const r = boxRange(boxes[i]);
      const s = r.range * Math.sqrt(boxes[i].px.length);
      if (r.range > 0 && s > score) {
        score = s;
        bi = i;
        ch = r.ch;
      }
    }
    if (bi < 0) break;
    const px = boxes[bi].px.slice().sort((a, b) => a[ch] - b[ch]);
    const mid = px.length >> 1;
    boxes.splice(bi, 1, { px: px.slice(0, mid) }, { px: px.slice(mid) });
  }
  let pal = boxes.map((b) => mean(b.px));

  for (let it = 0; it < kmeansIters; it++) {
    const sums = pal.map(() => [0, 0, 0, 0]);
    for (const p of snapped) {
      const s = sums[nearest(pal, p)];
      s[0] += p[0];
      s[1] += p[1];
      s[2] += p[2];
      s[3]++;
    }
    pal = sums.map((s, i) => (s[3] ? ([s[0] / s[3], s[1] / s[3], s[2] / s[3]] as RGB) : pal[i]));
  }
  // snap and dedupe
  const out = new Map<number, RGB>();
  for (const c of pal) {
    const s = snap565(c);
    out.set(rgbTo565(s[0], s[1], s[2]), s);
  }
  return [...out.values()];
}

export interface QuantizeOptions {
  dither?: boolean;
  colors?: number;
}

/** Quantise 48×48 RGBA (alpha composited onto black) into a packed 1184-byte icon. */
export function quantizeToIcon(rgba: ArrayLike<number>, opts: QuantizeOptions = {}): Uint8Array {
  const w = ICON_W,
    h = ICON_H;
  if (rgba.length !== w * h * 4) throw new Error('expected 48×48 RGBA');
  const px: RGB[] = [];
  for (let i = 0; i < w * h; i++) {
    const a = rgba[i * 4 + 3] / 255;
    px.push([rgba[i * 4] * a, rgba[i * 4 + 1] * a, rgba[i * 4 + 2] * a]);
  }
  const pal = buildPalette(px, Math.min(16, opts.colors ?? 16));
  const indices = new Uint8Array(w * h);
  if (opts.dither) {
    const work = px.map((p) => [p[0], p[1], p[2]] as RGB);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const old = work[i].map(clampByte) as RGB;
        const k = nearest(pal, old);
        indices[i] = k;
        const err = [old[0] - pal[k][0], old[1] - pal[k][1], old[2] - pal[k][2]];
        const spread = (dx: number, dy: number, f: number) => {
          const xx = x + dx,
            yy = y + dy;
          if (xx < 0 || xx >= w || yy >= h) return;
          const t = work[yy * w + xx];
          t[0] += err[0] * f;
          t[1] += err[1] * f;
          t[2] += err[2] * f;
        };
        spread(1, 0, 7 / 16);
        spread(-1, 1, 3 / 16);
        spread(0, 1, 5 / 16);
        spread(1, 1, 1 / 16);
      }
  } else {
    for (let i = 0; i < px.length; i++) indices[i] = nearest(pal, px[i]);
  }
  return packIcon(
    pal.map((c) => rgbTo565(c[0], c[1], c[2])),
    indices,
  );
}

// ---------------------------------------------------------------- browser helpers (canvas)

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** Center-crop to a square and scale to 48×48; returns RGBA. */
export function imageToRgba(img: CanvasImageSource & { width: number; height: number }): Uint8ClampedArray {
  const c = makeCanvas(ICON_W, ICON_H);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, ICON_W, ICON_H);
  const side = Math.min(img.width, img.height);
  const sx = (img.width - side) / 2;
  const sy = (img.height - side) / 2;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, sx, sy, side, side, 0, 0, ICON_W, ICON_H);
  return ctx.getImageData(0, 0, ICON_W, ICON_H).data;
}

export function initials(name: string): string {
  const words = name
    .trim()
    .split(/[\s_\-.]+/)
    .filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

export function nameHue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** A coloured tile with the first letters of the name. */
export function defaultIconRgba(name: string, hue = nameHue(name)): Uint8ClampedArray {
  const c = makeCanvas(ICON_W, ICON_H);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, ICON_W, ICON_H);
  ctx.fillStyle = `hsl(${hue} 65% 45%)`;
  ctx.beginPath();
  ctx.roundRect(1, 1, ICON_W - 2, ICON_H - 2, 8);
  ctx.fill();
  const text = initials(name);
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `bold ${text.length > 1 ? 22 : 28}px system-ui, sans-serif`;
  ctx.fillText(text, ICON_W / 2, ICON_H / 2 + 1);
  return ctx.getImageData(0, 0, ICON_W, ICON_H).data;
}

export async function fileToIconRgba(file: Blob): Promise<Uint8ClampedArray> {
  const bmp = await createImageBitmap(file);
  try {
    return imageToRgba(bmp);
  } finally {
    bmp.close();
  }
}

/** Draw a packed icon into a canvas (48×48). */
export function drawIcon(canvas: HTMLCanvasElement, icon: Uint8Array) {
  canvas.width = ICON_W;
  canvas.height = ICON_H;
  const ctx = canvas.getContext('2d')!;
  ctx.putImageData(new ImageData(iconToRgba(icon), ICON_W, ICON_H), 0, 0);
}
