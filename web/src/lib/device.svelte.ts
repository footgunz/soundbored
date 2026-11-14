// App-wide device state (Svelte 5 runes).

import { decodeAdpcm, int16ToFloat } from './adpcm';
import { playSamples, stopPlayback } from './audio';
import { Client, type LogEntry, type UploadProgress } from './client';
import { seedDemo } from './demo';
import { MockDevice, safeLocalStorage } from './mock';
import {
  BeginKind,
  GAIN_UNITY,
  ICON_BYTES,
  MAX_CHUNK,
  Mode,
  PLAY_STOP,
  SLOTS,
  type Entry,
  type HelloInfo,
  type Meta,
} from './protocol';
import {
  MOCK_FLAKY,
  MOCK_REALISTIC,
  MockTransport,
  WebMidiTransport,
  findSoundbored,
  listPorts,
  midiSupported,
  requestMidi,
  type Transport,
} from './transport';

export type ConnState = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error';

const SEEDED_KEY = 'soundbored.mock.seeded';

function emptyEntry(slot: number): Entry {
  return { slot, used: false, key: 0xff, mode: 0, gain: 0, rate: 0, frames: 0, audioBytes: 0, sectors: 0, name: '' };
}

function signature(e: Entry) {
  return e.used ? `${e.frames}:${e.audioBytes}:${e.sectors}:${e.rate}` : '';
}

function errText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

class DeviceStore {
  state = $state<ConnState>('idle');
  label = $state('');
  kind = $state<'midi' | 'mock' | null>(null);
  hello = $state<HelloInfo | null>(null);
  entries = $state.raw<Entry[]>(Array.from({ length: SLOTS }, (_, i) => emptyEntry(i)));
  icons = $state.raw<(Uint8Array | null)[]>(new Array(SLOTS).fill(null));
  loading = $state<{ done: number; total: number } | null>(null);
  busy = $state(false);
  error = $state<string | null>(null);
  log = $state.raw<LogEntry[]>([]);
  midi = $state<{ supported: boolean; access: MIDIAccess | null; inputs: MIDIInput[]; outputs: MIDIOutput[]; denied: string | null }>({
    supported: midiSupported(),
    access: null,
    inputs: [],
    outputs: [],
    denied: null,
  });
  flaky = $state(false);

  private client: Client | null = null;
  private iconSig: string[] = new Array(SLOTS).fill('');
  private unsubState: (() => void) | null = null;

  get connected() {
    return this.state === 'connected';
  }

  get mock(): MockTransport | null {
    return this.client?.transport instanceof MockTransport ? this.client.transport : null;
  }

  get maxChunk() {
    return Math.min(MAX_CHUNK, this.hello?.maxChunk || MAX_CHUNK);
  }

  addLog(dir: LogEntry['dir'], text: string) {
    this.log = [...this.log.slice(-199), { t: Date.now(), dir, text }];
  }

  // -------------------------------------------------------------- connecting

  async requestMidi() {
    if (!this.midi.supported) return;
    try {
      const access = await requestMidi();
      this.midi.access = access;
      this.midi.denied = null;
      const update = () => {
        const p = listPorts(access);
        this.midi.inputs = p.inputs;
        this.midi.outputs = p.outputs;
        // auto-connect when a soundbored device shows up and nothing else is connected
        if (this.state === 'idle' || this.state === 'error') {
          const pair = findSoundbored(access);
          if (pair) void this.connectMidi(pair.input.name ?? '', pair.output.name ?? '');
        }
      };
      access.addEventListener('statechange', update);
      update();
    } catch (e) {
      this.midi.denied = errText(e);
      this.addLog('info', `Web MIDI unavailable: ${errText(e)}`);
    }
  }

  async connectMidi(inputName: string, outputName: string) {
    if (!this.midi.access) return;
    this.attach(new WebMidiTransport(this.midi.access, inputName, outputName));
    await this.onConnected();
  }

  async connectMock() {
    const store = safeLocalStorage();
    const device = new MockDevice(store);
    let seeded = false;
    try {
      seeded = store?.getItem(SEEDED_KEY) === '1';
    } catch {
      /* ignore */
    }
    if (!seeded && device.slots.every((s) => !s)) {
      seedDemo(device);
      try {
        store?.setItem(SEEDED_KEY, '1');
      } catch {
        /* ignore */
      }
    }
    device.events.onPlay = (_slot, s) => {
      if (!s) return stopPlayback();
      const x = int16ToFloat(decodeAdpcm(s.audio, s.frames));
      playSamples(x, s.rate, s.gain / GAIN_UNITY, s.mode === Mode.LOOP);
    };
    this.attach(new MockTransport(device, this.flaky ? MOCK_FLAKY : MOCK_REALISTIC));
    await this.onConnected();
  }

  setFlaky(on: boolean) {
    this.flaky = on;
    const m = this.mock;
    if (m) m.options = on ? MOCK_FLAKY : MOCK_REALISTIC;
  }

  async resetMock() {
    const m = this.mock;
    if (!m) return;
    await this.run('Reset simulated device', async (c) => {
      await c.format();
      seedDemo(m.device);
    });
    await this.refresh();
  }

  async simulateReconnect() {
    await this.mock?.simulateReconnect();
  }

  disconnect() {
    this.unsubState?.();
    this.client?.close();
    this.client = null;
    this.state = 'idle';
    this.kind = null;
    this.label = '';
    this.hello = null;
    this.entries = Array.from({ length: SLOTS }, (_, i) => emptyEntry(i));
    this.icons = new Array(SLOTS).fill(null);
    this.iconSig = new Array(SLOTS).fill('');
  }

  private attach(t: Transport) {
    this.disconnect();
    this.client = new Client(t);
    this.client.onLog = (e) => this.addLog(e.dir, e.text);
    this.kind = t.kind;
    this.label = t.label;
    this.state = t.state === 'connected' ? 'connecting' : 'disconnected';
    this.unsubState = t.onState((s) => {
      this.addLog('info', `${t.label}: ${s}`);
      if (s === 'disconnected') this.state = 'disconnected';
      else void this.onConnected();
    });
  }

  private async onConnected() {
    if (!this.client || this.client.transport.state !== 'connected') {
      this.state = 'disconnected';
      return;
    }
    this.state = 'connecting';
    try {
      this.hello = await this.client.hello();
      if (this.hello.proto !== 1) this.addLog('info', `warning: device speaks protocol ${this.hello.proto}`);
      this.state = 'connected';
      this.error = null;
      this.addLog('info', `connected to ${this.label}`);
      this.iconSig = new Array(SLOTS).fill(''); // device may have changed while away
      await this.refresh();
    } catch (e) {
      this.state = 'error';
      this.error = `HELLO failed: ${errText(e)}`;
    }
  }

  // -------------------------------------------------------------- reading

  async refresh() {
    const c = this.client;
    if (!c) return;
    try {
      this.hello = await c.hello();
      const slots = this.hello.slots || SLOTS;
      const entries: Entry[] = [];
      this.loading = { done: 0, total: slots };
      for (let s = 0; s < slots; s++) {
        entries.push(await c.getEntry(s));
        this.loading = { done: s + 1, total: slots };
      }
      this.entries = entries;
      const need = entries.filter((e) => e.used && (this.iconSig[e.slot] !== signature(e) || !this.icons[e.slot]));
      const icons = this.icons.slice();
      for (const e of entries) if (!e.used) icons[e.slot] = null;
      this.icons = icons;
      this.loading = { done: 0, total: need.length };
      for (let i = 0; i < need.length; i++) {
        await this.fetchIcon(need[i].slot, need[i]);
        this.loading = { done: i + 1, total: need.length };
      }
    } catch (e) {
      this.error = `refresh failed: ${errText(e)}`;
    } finally {
      this.loading = null;
    }
  }

  private async fetchIcon(slot: number, e: Entry) {
    const icon = await this.client!.getIcon(slot, this.hello?.iconBytes || ICON_BYTES, this.maxChunk);
    const icons = this.icons.slice();
    icons[slot] = icon;
    this.icons = icons;
    this.iconSig[slot] = signature(e);
  }

  // -------------------------------------------------------------- actions

  private async run<T>(what: string, fn: (c: Client) => Promise<T>): Promise<T | undefined> {
    const c = this.client;
    if (!c || !this.connected) {
      this.error = 'not connected';
      return undefined;
    }
    this.busy = true;
    this.error = null;
    try {
      return await fn(c);
    } catch (e) {
      this.error = `${what}: ${errText(e)}`;
      this.addLog('info', this.error);
      throw e;
    } finally {
      this.busy = false;
    }
  }

  async swap(a: number, b: number) {
    if (a === b) return;
    const ok = await this.run('Swap', (c) => c.swap(a, b)).then(
      () => true,
      () => false,
    );
    if (!ok) return;
    const icons = this.icons.slice();
    [icons[a], icons[b]] = [icons[b], icons[a]];
    this.icons = icons;
    [this.iconSig[a], this.iconSig[b]] = [this.iconSig[b], this.iconSig[a]];
    await this.refresh();
  }

  async play(slot: number) {
    await this.run('Play', (c) => c.play(slot)).catch(() => {});
  }

  async stop() {
    await this.run('Stop', (c) => c.play(PLAY_STOP)).catch(() => {});
  }

  async setMeta(slot: number, m: Meta) {
    await this.run('Save', (c) => c.setMeta(slot, m));
    await this.refresh();
  }

  async delete(slot: number) {
    await this.run('Delete', (c) => c.delete(slot));
    await this.refresh();
  }

  async format() {
    await this.run('Format', (c) => c.format());
    await this.refresh();
  }

  async uploadSound(
    slot: number,
    meta: Meta,
    rate: number,
    frames: number,
    icon: Uint8Array,
    adpcm: Uint8Array,
    onProgress: (p: UploadProgress) => void,
  ) {
    const stream = new Uint8Array(icon.length + adpcm.length);
    stream.set(icon);
    stream.set(adpcm, icon.length);
    const res = await this.run('Upload', (c) =>
      c.upload({ kind: BeginKind.SOUND, slot, rate, frames, ...meta }, stream, onProgress, this.maxChunk),
    );
    if (res) {
      this.addLog('info', `uploaded to slot ${res.slot + 1}: ${stream.length} bytes, CRC-32 ${res.crc.toString(16).padStart(8, '0')}`);
      this.iconSig[res.slot] = '';
    }
    await this.refresh();
    return res;
  }

  async uploadIcon(slot: number, icon: Uint8Array, onProgress: (p: UploadProgress) => void) {
    const res = await this.run('Icon upload', (c) => c.uploadIcon(slot, icon, onProgress, this.maxChunk));
    this.iconSig[slot] = '';
    await this.refresh();
    return res;
  }
}

export const device = new DeviceStore();
