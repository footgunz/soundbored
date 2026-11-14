// Web MIDI and the simulated device behind one interface.

import { MockDevice, safeLocalStorage } from './mock';
import { Cmd, parseFrame } from './protocol';

export type TransportState = 'connected' | 'disconnected';

export interface Transport {
  readonly kind: 'midi' | 'mock';
  readonly label: string;
  readonly state: TransportState;
  send(frame: Uint8Array): void;
  /** Subscribe to incoming SysEx messages (complete F0…F7). Returns an unsubscribe function. */
  onMessage(cb: (msg: Uint8Array) => void): () => void;
  /** Subscribe to connection state changes. */
  onState(cb: (s: TransportState) => void): () => void;
  close(): void;
}

class Emitter<T> {
  private subs = new Set<(v: T) => void>();
  on(cb: (v: T) => void) {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }
  emit(v: T) {
    for (const s of [...this.subs]) s(v);
  }
}

// ---------------------------------------------------------------- Web MIDI

export const DEVICE_MATCH = 'SOUNDBORED';

export function midiSupported(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.requestMIDIAccess === 'function';
}

export async function requestMidi(): Promise<MIDIAccess> {
  return navigator.requestMIDIAccess({ sysex: true });
}

export interface PortPair {
  input: MIDIInput;
  output: MIDIOutput;
}

export function listPorts(access: MIDIAccess): { inputs: MIDIInput[]; outputs: MIDIOutput[] } {
  return { inputs: [...access.inputs.values()], outputs: [...access.outputs.values()] };
}

function matches(name: string | null | undefined, match: string) {
  return (name ?? '').toUpperCase().includes(match.toUpperCase());
}

/** The input/output pair whose names contain "SOUNDBORED", if both exist and are connected. */
export function findSoundbored(access: MIDIAccess, match = DEVICE_MATCH): PortPair | null {
  const { inputs, outputs } = listPorts(access);
  const input = inputs.find((p) => matches(p.name, match) && p.state === 'connected');
  const output = outputs.find((p) => matches(p.name, match) && p.state === 'connected');
  return input && output ? { input, output } : null;
}

export class WebMidiTransport implements Transport {
  readonly kind = 'midi' as const;
  private msgs = new Emitter<Uint8Array>();
  private states = new Emitter<TransportState>();
  private input: MIDIInput | null = null;
  private output: MIDIOutput | null = null;
  state: TransportState = 'disconnected';

  /**
   * `inputName`/`outputName` identify the chosen ports by name, so a reconnect (which may give the
   * ports new ids) rebinds automatically.
   */
  constructor(
    private access: MIDIAccess,
    private inputName: string,
    private outputName: string,
  ) {
    this.access.addEventListener('statechange', this.onStateChange);
    this.rebind();
  }

  get label() {
    return this.outputName === this.inputName ? this.outputName : `${this.outputName} / ${this.inputName}`;
  }

  private onMidi = (e: Event) => {
    const data = (e as MIDIMessageEvent).data;
    if (data && data[0] === 0xf0) this.msgs.emit(new Uint8Array(data));
  };

  private onStateChange = () => this.rebind();

  private rebind() {
    const { inputs, outputs } = listPorts(this.access);
    const input = inputs.find((p) => p.name === this.inputName && p.state === 'connected') ?? null;
    const output = outputs.find((p) => p.name === this.outputName && p.state === 'connected') ?? null;
    if (input !== this.input) {
      this.input?.removeEventListener('midimessage', this.onMidi);
      this.input = input;
      if (input) {
        input.addEventListener('midimessage', this.onMidi);
        void input.open().catch(() => {});
      }
    }
    if (output !== this.output) {
      this.output = output;
      if (output) void output.open().catch(() => {});
    }
    const next: TransportState = this.input && this.output ? 'connected' : 'disconnected';
    if (next !== this.state) {
      this.state = next;
      this.states.emit(next);
    }
  }

  send(frame: Uint8Array) {
    if (!this.output) throw new Error('device not connected');
    this.output.send(frame);
  }

  onMessage(cb: (m: Uint8Array) => void) {
    return this.msgs.on(cb);
  }

  onState(cb: (s: TransportState) => void) {
    return this.states.on(cb);
  }

  close() {
    this.access.removeEventListener('statechange', this.onStateChange);
    this.input?.removeEventListener('midimessage', this.onMidi);
    this.input = null;
    this.output = null;
    this.state = 'disconnected';
  }
}

// ---------------------------------------------------------------- simulated device

export interface MockOptions {
  /** Reply delay range in ms. */
  minDelay: number;
  maxDelay: number;
  /** Extra delay for a DATA chunk that starts a new sector (a flash erase). */
  eraseDelay: number;
  /** Probability of a long delay (longer than the request timeout, so the host resends). */
  slowChance: number;
  slowDelay: number;
  /** Probability that a reply is lost entirely. */
  dropChance: number;
}

export const MOCK_FAST: MockOptions = { minDelay: 0, maxDelay: 0, eraseDelay: 0, slowChance: 0, slowDelay: 0, dropChance: 0 };
export const MOCK_REALISTIC: MockOptions = {
  minDelay: 2,
  maxDelay: 15,
  eraseDelay: 40,
  slowChance: 0,
  slowDelay: 0,
  dropChance: 0,
};
export const MOCK_FLAKY: MockOptions = {
  ...MOCK_REALISTIC,
  slowChance: 0.02,
  slowDelay: 3500,
  dropChance: 0.02,
};

export class MockTransport implements Transport {
  readonly kind = 'mock' as const;
  readonly label = 'Simulated FM-1';
  private msgs = new Emitter<Uint8Array>();
  private states = new Emitter<TransportState>();
  state: TransportState = 'connected';
  private timers = new Set<ReturnType<typeof setTimeout>>();
  stats = { requests: 0, slowed: 0, dropped: 0 };

  constructor(
    public device: MockDevice = new MockDevice(safeLocalStorage()),
    public options: MockOptions = MOCK_REALISTIC,
  ) {}

  send(frame: Uint8Array) {
    if (this.state !== 'connected') throw new Error('device not connected');
    const reply = this.device.handle(new Uint8Array(frame));
    this.stats.requests++;
    if (!reply) return;
    const o = this.options;
    if (o.dropChance > 0 && Math.random() < o.dropChance) {
      this.stats.dropped++;
      return;
    }
    let delay = o.minDelay + Math.random() * (o.maxDelay - o.minDelay);
    if (this.device.lastWasErase) delay += o.eraseDelay;
    const p = parseFrame(frame);
    const isHello = p.ok && p.frame.cmd === Cmd.HELLO;
    if (!isHello && o.slowChance > 0 && Math.random() < o.slowChance) {
      delay = o.slowDelay;
      this.stats.slowed++;
    }
    if (delay <= 0) {
      queueMicrotask(() => this.deliver(reply));
    } else {
      const t = setTimeout(() => {
        this.timers.delete(t);
        this.deliver(reply);
      }, delay);
      this.timers.add(t);
    }
  }

  private deliver(reply: Uint8Array) {
    if (this.state === 'connected') this.msgs.emit(reply);
  }

  /** Simulate unplugging and replugging the USB cable. */
  async simulateReconnect(ms = 800) {
    this.setState('disconnected');
    this.device.usbReconnect();
    await new Promise((r) => setTimeout(r, ms));
    this.setState('connected');
  }

  private setState(s: TransportState) {
    if (s === this.state) return;
    this.state = s;
    this.states.emit(s);
  }

  onMessage(cb: (m: Uint8Array) => void) {
    return this.msgs.on(cb);
  }

  onState(cb: (s: TransportState) => void) {
    return this.states.on(cb);
  }

  close() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.state = 'disconnected';
  }
}
