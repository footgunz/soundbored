// Demo content for a fresh simulated device (browser only: icons are drawn on a canvas).

import { encodeAdpcm, floatToInt16 } from './adpcm';
import { defaultIconRgba, quantizeToIcon } from './icon';
import type { MockDevice } from './mock';
import { GAIN_UNITY, ICON_BYTES, KEY_NONE, SECTOR_PAYLOAD } from './protocol';

const RATE = 16000;

function synth(seconds: number, f: (t: number) => number): Float32Array {
  const n = Math.round(seconds * RATE);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = f(i / RATE);
  return x;
}

const demos: { name: string; slot: number; key: number; mode: number; hue: number; x: () => Float32Array }[] = [
  {
    name: 'Kick',
    slot: 0,
    key: 0,
    mode: 0,
    hue: 10,
    x: () => synth(0.45, (t) => 0.9 * Math.exp(-t * 9) * Math.sin(2 * Math.PI * (45 * t + 90 * (1 - Math.exp(-t * 30)) / 30))),
  },
  {
    name: 'Beep',
    slot: 1,
    key: 1,
    mode: 1,
    hue: 200,
    x: () => synth(0.6, (t) => 0.5 * Math.sign(Math.sin(2 * Math.PI * 880 * t)) * Math.min(1, (0.6 - t) * 40)),
  },
  {
    name: 'Air horn',
    slot: 2,
    key: 2,
    mode: 0,
    hue: 45,
    x: () =>
      synth(1.2, (t) => {
        const env = Math.min(1, t * 30) * Math.min(1, (1.2 - t) * 10);
        let s = 0;
        for (const f of [440, 554, 659]) s += ((2 * ((f * t) % 1)) - 1) / 3;
        return 0.7 * env * s;
      }),
  },
  {
    name: 'Drone loop',
    slot: 5,
    key: KEY_NONE,
    mode: 2,
    hue: 280,
    x: () => synth(1.0, (t) => 0.4 * Math.sin(2 * Math.PI * 110 * t) + 0.2 * Math.sin(2 * Math.PI * 165 * t)),
  },
];

export function seedDemo(device: MockDevice) {
  for (const d of demos) {
    const pcm = floatToInt16(d.x());
    const audio = encodeAdpcm(pcm);
    const icon = quantizeToIcon(defaultIconRgba(d.name, d.hue));
    device.slots[d.slot] = {
      name: d.name,
      key: d.key,
      mode: d.mode,
      gain: GAIN_UNITY,
      rate: RATE,
      frames: pcm.length,
      sectors: Math.ceil((ICON_BYTES + audio.length) / SECTOR_PAYLOAD),
      icon,
      audio,
    };
  }
  device.save();
}
