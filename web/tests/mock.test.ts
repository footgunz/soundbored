import { describe, expect, it } from 'vitest';
import { decodeAdpcm, encodeAdpcm } from '../src/lib/adpcm';
import { Client } from '../src/lib/client';
import { crc32 } from '../src/lib/crc32';
import { packIcon } from '../src/lib/icon';
import { MockDevice, type KVStore } from '../src/lib/mock';
import { BeginKind, Cmd, KEY_AUTO, KEY_NONE, Status, StatusError, buildFrame, parseFrame, req } from '../src/lib/protocol';
import { MOCK_FAST, MockTransport } from '../src/lib/transport';

function memStore(): KVStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

function makeSound(frames: number) {
  const pcm = new Int16Array(frames);
  for (let i = 0; i < frames; i++) pcm[i] = Math.round(12000 * Math.sin(i / 7));
  const adpcm = encodeAdpcm(pcm);
  const idx = new Uint8Array(48 * 48);
  for (let i = 0; i < idx.length; i++) idx[i] = (i >> 3) & 15;
  const pal = Array.from({ length: 16 }, (_, i) => i * 0x1111);
  const icon = packIcon(pal, idx);
  const stream = new Uint8Array(icon.length + adpcm.length);
  stream.set(icon);
  stream.set(adpcm, icon.length);
  return { pcm, adpcm, icon, stream };
}

function setup(store: KVStore | null = null) {
  const device = new MockDevice(store);
  const transport = new MockTransport(device, MOCK_FAST);
  const client = new Client(transport, 120); // start near the wrap to exercise seq 127 -> 0
  return { device, transport, client };
}

describe('mock device', () => {
  it('HELLO reports 94 sectors', async () => {
    const { client } = setup();
    const h = await client.hello();
    expect(h).toEqual({ proto: 1, slots: 48, sectorsTotal: 94, sectorsFree: 94, sectorPayload: 3840, iconW: 48, iconH: 48, iconBytes: 1184, maxChunk: 512, nameMax: 16 });
  });

  it('full upload: BEGIN, DATA, COMMIT, then GET_ENTRY and GET_ICON', async () => {
    const store = memStore();
    const { client, device } = setup(store);
    const frames = 16001; // odd
    const s = makeSound(frames);
    expect(s.adpcm.length).toBe(8001);
    const progress: number[] = [];
    const res = await client.upload(
      { kind: BeginKind.SOUND, slot: 0xff, rate: 16000, frames, key: KEY_AUTO, mode: 0, gain: 256, name: 'Test tone' },
      s.stream,
      (p) => progress.push(p.sent),
    );
    expect(res.slot).toBe(0);
    expect(res.sectors).toBe(Math.ceil((1184 + 8001) / 3840));
    expect(res.crc).toBe(crc32(s.stream));
    expect(progress.at(-1)).toBe(s.stream.length);

    const e = await client.getEntry(0);
    expect(e).toEqual({ slot: 0, used: true, key: 0, mode: 0, gain: 256, rate: 16000, frames, audioBytes: 8001, sectors: 3, name: 'Test tone' });
    const icon = await client.getIcon(0);
    expect([...icon]).toEqual([...s.icon]);
    expect([...decodeAdpcm(device.slots[0]!.audio, frames)]).toEqual([...decodeAdpcm(s.adpcm, frames)]);
    expect((await client.hello()).sectorsFree).toBe(91);

    // persisted, and reloaded by a fresh device
    const again = new MockDevice(store);
    expect(again.entry(0).name).toBe('Test tone');
    expect([...again.slots[0]!.icon]).toEqual([...s.icon]);

    // empty slot
    expect((await client.getEntry(1)).used).toBe(false);
    await expect(client.getIcon(1)).rejects.toMatchObject({ status: Status.BAD_SLOT });
  });

  it('icon change (BEGIN kind 1), SET_META, key move, SWAP, DELETE, FORMAT', async () => {
    const { client } = setup();
    const a = makeSound(100);
    const b = makeSound(200);
    const meta = { rate: 16000, key: 5, mode: 1, gain: 100, kind: 0 };
    await client.upload({ ...meta, slot: 3, frames: 100, name: 'A' }, a.stream);
    await client.upload({ ...meta, slot: 7, frames: 200, name: 'B' }, b.stream);
    // B took key 5 from A
    expect((await client.getEntry(3)).key).toBe(KEY_NONE);
    expect((await client.getEntry(7)).key).toBe(5);

    const newIcon = packIcon([0xffff], new Uint8Array(48 * 48));
    await client.uploadIcon(3, newIcon);
    expect([...(await client.getIcon(3))]).toEqual([...newIcon]);
    expect((await client.getEntry(3)).frames).toBe(100);

    await client.setMeta(3, { key: 5, mode: 2, gain: 512, name: 'Renamed' });
    expect(await client.getEntry(3)).toMatchObject({ key: 5, mode: 2, gain: 512, name: 'Renamed' });
    expect((await client.getEntry(7)).key).toBe(KEY_NONE);
    await expect(client.setMeta(3, { key: 5, mode: 3, gain: 0, name: 'x' })).rejects.toMatchObject({ status: Status.BAD_ARG });

    await client.swap(3, 20);
    expect((await client.getEntry(3)).used).toBe(false);
    expect((await client.getEntry(20)).name).toBe('Renamed');
    await client.delete(20);
    expect((await client.getEntry(20)).used).toBe(false);
    await expect(client.delete(20)).rejects.toMatchObject({ status: Status.BAD_SLOT });

    await client.format();
    expect((await client.getEntry(7)).used).toBe(false);
    expect((await client.hello()).sectorsFree).toBe(94);
  });

  it('rejects a bad CRC and leaves nothing behind', async () => {
    const { client, device } = setup();
    const s = makeSound(1000);
    await client.request(Cmd.BEGIN, req.begin({ kind: 0, slot: 0, total: s.stream.length, rate: 16000, frames: 1000, key: KEY_NONE, mode: 0, gain: 256, name: 'x' }));
    for (let o = 0; o < s.stream.length; o += 512) await client.request(Cmd.DATA, req.data(o, s.stream.subarray(o, o + 512)));
    await expect(client.request(Cmd.COMMIT, req.commit(crc32(s.stream) ^ 1))).rejects.toMatchObject({ status: Status.CRC_MISMATCH });
    expect(device.slots[0]).toBeNull();
    await expect(client.request(Cmd.DATA, req.data(0, Uint8Array.of(1)))).rejects.toMatchObject({ status: Status.BUSY });
  });

  it('bad offset carries the expected offset; a repeated chunk is acknowledged', async () => {
    const { client } = setup();
    const s = makeSound(2000);
    await client.request(Cmd.BEGIN, req.begin({ kind: 0, slot: 0, total: s.stream.length, rate: 16000, frames: 2000, key: KEY_NONE, mode: 0, gain: 256, name: 'x' }));
    await client.request(Cmd.DATA, req.data(0, s.stream.subarray(0, 512)));
    const err = await client.request(Cmd.DATA, req.data(1024, s.stream.subarray(1024, 1536))).catch((e) => e);
    expect(err).toBeInstanceOf(StatusError);
    expect(err.status).toBe(Status.BAD_OFFSET);
    expect([...err.body]).toEqual([0x00, 0x02, 0, 0]);
    const dup = await client.request(Cmd.DATA, req.data(0, s.stream.subarray(0, 512)));
    expect([...dup]).toEqual([0x00, 0x02, 0, 0]);
  });

  it('no space', async () => {
    const { client } = setup();
    const frames = 2 * (95 * 3840);
    const total = 1184 + frames / 2;
    await expect(
      client.request(Cmd.BEGIN, req.begin({ kind: 0, slot: 0, total, rate: 16000, frames, key: KEY_NONE, mode: 0, gain: 256, name: 'big' })),
    ).rejects.toMatchObject({ status: Status.NO_SPACE });
  });

  it('a resend with the same cmd and seq gets the cached reply without repeating the action', () => {
    const device = new MockDevice();
    const s = makeSound(10);
    const begin = buildFrame(Cmd.BEGIN, 9, req.begin({ kind: 0, slot: 0xff, total: s.stream.length, rate: 16000, frames: 10, key: KEY_NONE, mode: 0, gain: 256, name: 'x' }));
    const r1 = device.handle(begin)!;
    const r2 = device.handle(begin)!;
    expect([...r2]).toEqual([...r1]);
    const data = buildFrame(Cmd.DATA, 10, req.data(0, s.stream.subarray(0, 512)));
    device.handle(data);
    expect(device.transfer!.next).toBe(512);
    const again = parseFrame(device.handle(data)!);
    expect(again.ok && [...again.frame.body]).toEqual([0, 0x00, 0x02, 0, 0]);
    // unknown command and bad checksum
    const unk = parseFrame(device.handle(buildFrame(0x30, 11))!);
    expect(unk.ok && unk.frame.cmd).toBe(0x30 | 0x40);
    expect(unk.ok && unk.frame.body[0]).toBe(Status.UNKNOWN_CMD);
    const bad = buildFrame(Cmd.HELLO, 12);
    bad[bad.length - 2] ^= 1;
    const badr = parseFrame(device.handle(bad)!);
    expect(badr.ok && badr.frame.body[0]).toBe(Status.BAD_FRAME);
  });

  it('client resends on the same seq when replies are lost', async () => {
    const device = new MockDevice();
    let drop = 2;
    const transport = new MockTransport(device, MOCK_FAST);
    const realSend = transport.send.bind(transport);
    const seqs: number[] = [];
    transport.send = (f: Uint8Array) => {
      seqs.push(f[5]);
      if (drop-- > 0) {
        device.handle(f); // device acts, reply lost
        return;
      }
      realSend(f);
    };
    const client = new Client(transport, 0);
    const res = await client.request(Cmd.HELLO, req.hello(), { timeout: 20 });
    expect(res[0]).toBe(1);
    expect(seqs).toEqual([0, 0, 0]);
    expect(client.stats.resends).toBe(2);
  });
});
