# soundbored web

The browser side of soundbored. It manages the sounds on an FM-1 running the soundbored firmware over Web MIDI SysEx,
using the protocol in [`../docs/protocol.md`](../docs/protocol.md). It's built with Vite, TypeScript and Svelte 5.

## Run

```bash
cd web
npm install
npm run dev        # hot reload, served on all interfaces (host: true), port 5173
npm run build      # production build into dist/
npx vitest run     # unit tests
npx svelte-check   # type check (.ts and .svelte)
```

Open <http://localhost:5173> in Chrome or Edge, and allow SysEx when asked. Without hardware, use
**Use Simulated FM-1**: an in-browser device that implements the device side of the protocol (94 sectors, status codes,
retry cache, injected delays). It keeps its sounds in localStorage. "flaky link" adds lost and late replies to exercise
the resend path, and "Replug" simulates a USB reconnect.

### WSL2 → Windows Chrome

Run `npm run dev` inside WSL2 and open **`http://localhost:5173`** in Windows Chrome. WSL2 forwards `localhost` to
the Linux side. Web MIDI with SysEx needs a secure context, and `localhost` counts as one even over plain HTTP. The
`Network:` URLs Vite prints (172.x / 10.x) do **not** count, so `requestMIDIAccess({sysex:true})` fails on them. The FM-1
has to be visible to Windows (it is a USB MIDI device on the Windows side; no usbipd needed for Chrome).

## Layout

| file | role |
| --- | --- |
| `src/lib/protocol.ts` | framing, pack7, checksum, every command's encode/decode, constants |
| `src/lib/client.ts` | request queue (one in flight), timeouts, resend on the same seq, upload |
| `src/lib/transport.ts` | `Transport` interface: Web MIDI and the simulated device |
| `src/lib/mock.ts` | simulated FM-1 (device side of the protocol) |
| `src/lib/adpcm.ts` | IMA ADPCM encoder and decoder |
| `src/lib/audio.ts` | decode, mono, 16 kHz resample, trim, normalise, playback |
| `src/lib/icon.ts` | crop/scale, median cut + k-means to 16 colours, RGB565 + 4 bpp packing |
| `src/lib/crc32.ts` | IEEE CRC-32 |
| `src/lib/device.svelte.ts` | app state (runes) |
| `src/components/*` | UI |
| `tests/*` | vitest |
