// Cross-check: the web page's own protocol code against the firmware in the host simulator.
//   gen OUT.txt      a simulator script whose frames come from src/lib (protocol, adpcm, icon, crc32)
//   verify LOG       the device's replies (the script's sysex_log), parsed with src/lib's parseFrame
// Run by tools/xcheck.sh from the repo root.
import { readFileSync, writeFileSync } from 'node:fs';
import {
  Cmd, req, buildFrame, parseFrame, Reader, decodeHello, decodeEntry, ICON_BYTES, MAX_CHUNK, KEY_AUTO, SLOT_AUTO,
} from '../src/lib/protocol';
import { encodeAdpcm } from '../src/lib/adpcm';
import { quantizeToIcon } from '../src/lib/icon';
import { crc32 } from '../src/lib/crc32';

const RATE = 16000;
const FRAMES = 8000; // 0.5 s

function pcm(): Int16Array {
  const p = new Int16Array(FRAMES);
  for (let i = 0; i < FRAMES; i++) {
    const env = Math.min(1, i / 80, (FRAMES - i) / 320);
    p[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / RATE) * env * 0.8 * 32767);
  }
  return p;
}

function icon(): Uint8Array {
  const rgba = new Uint8ClampedArray(48 * 48 * 4);
  for (let y = 0; y < 48; y++)
    for (let x = 0; x < 48; x++) {
      const i = (y * 48 + x) * 4;
      rgba[i] = x * 5; rgba[i + 1] = y * 5; rgba[i + 2] = (x ^ y) * 4; rgba[i + 3] = 255;
    }
  return quantizeToIcon(rgba);
}

const hex = (f: Uint8Array) => Array.from(f, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');

function gen(out: string, log: string) {
  const L: string[] = ['wait 600', `sysex_log ${log}`];
  let seq = 0;
  const send = (cmd: number, body: Uint8Array, status = 0) => {
    seq = (seq + 1) & 0x7f;
    L.push(`sysex ${hex(buildFrame(cmd, seq, body))}`, `expect status ${status}`);
  };
  const ic = icon();
  const audio = encodeAdpcm(pcm());
  const stream = new Uint8Array(ICON_BYTES + audio.length);
  stream.set(ic, 0);
  stream.set(audio, ICON_BYTES);
  send(Cmd.HELLO, req.hello());
  send(Cmd.BEGIN, req.begin({ kind: 0, slot: SLOT_AUTO, total: stream.length, rate: RATE, frames: FRAMES,
                              key: KEY_AUTO, mode: 0, gain: 256, name: 'WEB SINE' }));
  for (let o = 0; o < stream.length; o += MAX_CHUNK) send(Cmd.DATA, req.data(o, stream.subarray(o, o + MAX_CHUNK)));
  send(Cmd.COMMIT, req.commit(crc32(stream)));
  L.push('expect sounds 1', 'expect key0 0');
  send(Cmd.GET_ENTRY, req.getEntry(0));
  for (let o = 0; o < ICON_BYTES; o += MAX_CHUNK)
    send(Cmd.GET_ICON, req.getIcon(0, o, Math.min(MAX_CHUNK, ICON_BYTES - o)));
  send(Cmd.SET_META, req.setMeta(0, { key: 4, mode: 1, gain: 300, name: 'RENAMED' }));
  L.push('expect key4 0', 'expect key0 -1');
  send(Cmd.GET_ENTRY, req.getEntry(0));
  send(Cmd.PLAY, req.play(0));
  L.push('wait 20', 'expect voices 1', 'wav out:xcheck.wav', 'wait 300', 'wavstop', 'expect peak_db_min -30',
         'sysex_log off');
  writeFileSync(out, L.join('\n') + '\n');
  writeFileSync(out + '.icon', ic);
}

function verify(log: string, iconFile: string) {
  const raw = readFileSync(log);
  const frames: Uint8Array[] = [];
  for (let i = 0; i < raw.length; i++)
    if (raw[i] === 0xf0) {
      const e = raw.indexOf(0xf7, i);
      frames.push(new Uint8Array(raw.subarray(i, e + 1)));
      i = e;
    }
  const fail = (m: string) => { console.log('FAIL', m); process.exitCode = 1; };
  const iconBack = new Uint8Array(ICON_BYTES);
  let entries = 0;
  for (const f of frames) {
    const p = parseFrame(f);
    if (!p.ok) { fail(`unparsable reply ${hex(f)}`); continue; }
    const cmd = p.frame.cmd & 0x3f, r = new Reader(p.frame.body), st = r.u8();
    if (st !== 0) fail(`cmd ${cmd} status ${st}`);
    if (cmd === Cmd.HELLO) {
      const h = decodeHello(r);
      console.log('hello', JSON.stringify(h));
      if (h.sectorsTotal !== 94 || h.iconBytes !== ICON_BYTES || h.maxChunk !== MAX_CHUNK) fail('hello values');
    } else if (cmd === Cmd.GET_ENTRY) {
      const e = decodeEntry(r);
      console.log('entry', JSON.stringify(e));
      const want = entries++ === 0 ? { name: 'WEB SINE', key: 0, mode: 0, gain: 256 }
                                   : { name: 'RENAMED', key: 4, mode: 1, gain: 300 };
      if (!e.used || e.frames !== FRAMES || e.rate !== RATE || e.audioBytes !== FRAMES / 2 || e.sectors !== 2 ||
          e.name !== want.name || e.key !== want.key || e.mode !== want.mode || e.gain !== want.gain)
        fail('entry values');
    } else if (cmd === Cmd.GET_ICON) {
      r.u8();
      const off = r.u16();
      iconBack.set(p.frame.body.subarray(4), off);
    }
  }
  const sent = readFileSync(iconFile);
  if (Buffer.compare(Buffer.from(iconBack), sent) !== 0) fail('icon read back differs from the one uploaded');
  else console.log('icon read back: identical,', ICON_BYTES, 'bytes');
  console.log(`${frames.length} replies parsed`);
}

const [mode, a, b] = process.argv.slice(2);
if (mode === 'gen') gen(a, b);
else if (mode === 'verify') verify(a, b);
else { console.log('xcheck.ts gen OUT LOG | verify LOG ICONFILE'); process.exitCode = 2; }
