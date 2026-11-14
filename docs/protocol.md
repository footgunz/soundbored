# soundbored SysEx protocol (version 1)

This protocol runs between the web page (or `tools/sbtool.py`) and the FM-1 over USB MIDI SysEx. The host sends one
request and waits for its reply before sending the next.

## Framing

```
F0 7D 53 42 <cmd> <seq> <pack7(body)...> <chk> F7
```

- `7D` is the non-commercial manufacturer ID. `53 42` ("SB") marks soundbored. The platform keeps `7D 4C` for itself.
- `cmd` is 7-bit. A reply carries `cmd | 0x40`.
- `seq` runs 0..127. The host increments it for each new request, and the reply echoes it.
- `body` is binary and goes on the wire 8-to-7 packed (below). All integers are **little-endian**.
- `chk` = (sum of every byte from `cmd` through the last packed byte) & 0x7F.
- A whole frame is at most 640 bytes between `F0` and `F7`. A data chunk is at most 512 bytes before packing.

**pack7.** The raw bytes are split into groups of up to 7. Each group goes out as one byte holding the groups' high
bits (bit *i* = bit 7 of byte *i* in the group), followed by the group's bytes with bit 7 cleared. A group of *k*
bytes becomes *k* + 1 bytes.

**Retries.** If a request arrives with the same `cmd` and `seq` as the last one the device handled, the device sends
its cached reply again and does not repeat the action. So the host can safely resend after a timeout. Use about
1.5 s for a normal request, and about 3 s for a `DATA` request that may cross a sector erase.

## Replies

Every reply body starts with a `status` byte:

| status | meaning |
| --- | --- |
| 0 | ok |
| 1 | bad frame (checksum, length) |
| 2 | unknown command |
| 3 | bad slot (out of range, or empty when it must be used) |
| 4 | no space (not enough free sectors) |
| 5 | busy / no transfer open / a transfer of another kind is open |
| 6 | bad offset (the reply still carries the offset expected next) |
| 7 | CRC mismatch on commit (the transfer is aborted) |
| 8 | flash error |
| 9 | bad argument |

## Constants (also reported by HELLO)

| | |
| --- | --- |
| slots | 48 (4 pages of 12, in a 4×3 grid; slot *s* is page *s*/12, row (*s*%12)/4, column *s*%4) |
| sector payload | 3840 bytes per 4 KiB flash sector |
| icon | 48×48 pixels, 4 bits per pixel, 16-entry RGB565 palette: 1184 bytes |
| name | up to 16 ASCII characters, 0x20..0x7E, NUL-padded to 16 |
| keys | 0..26 = the FM-1's keys from F3 upward; 0xFF = none. MIDI note *n* in (any channel) plays key *n* − 53 |

## Commands

| cmd | name | request body | reply body (after status) |
| --- | --- | --- | --- |
| 0x01 | HELLO | — | `proto u8` (1), `slots u8`, `sectors_total u8`, `sectors_free u8`, `sector_payload u16`, `icon_w u8`, `icon_h u8`, `icon_bytes u16`, `max_chunk u16`, `name_max u8` |
| 0x02 | GET_ENTRY | `slot u8` | `slot u8`, `used u8`, `key u8`, `mode u8`, `gain u16`, `rate u16`, `frames u32`, `audio_bytes u32`, `sectors u8`, `name[16]` |
| 0x03 | GET_ICON | `slot u8`, `offset u16`, `len u16` (≤ 512) | `slot u8`, `offset u16`, `data[len]` |
| 0x10 | BEGIN | `kind u8`, `slot u8`, `total u32`, `rate u16`, `frames u32`, `key u8`, `mode u8`, `gain u16`, `name[16]` | `slot u8`, `sectors u8` |
| 0x11 | DATA | `offset u32`, `data[1..512]` | `next u32` |
| 0x12 | COMMIT | `crc32 u32` | `slot u8` |
| 0x13 | ABORT | — | — |
| 0x20 | SET_META | `slot u8`, `key u8`, `mode u8`, `gain u16`, `name[16]` | — |
| 0x21 | DELETE | `slot u8` | — |
| 0x22 | SWAP | `a u8`, `b u8` | — (moves slots in the grid, either may be empty) |
| 0x23 | PLAY | `slot u8` (0xFF = stop everything) | — (a preview, as if its key were tapped) |
| 0x24 | FORMAT | the 4 ASCII bytes `WIPE` | — (every sound deleted) |

### Uploading

The **stream** of a sound is its icon (1184 bytes) followed by its audio bytes.

1. Send `BEGIN` with `kind` 0, `total` = 1184 + `audio_bytes`, and the metadata.
   - `slot` 0xFF takes the first empty slot.
   - A used slot is replaced at commit. The old sound plays on until then.
   - `key` 0xFE picks a key: the slot number if it is under 27 and no other sound has that key, otherwise none.
   - Binding a key that another sound already has moves the key to this sound.
2. Send `DATA` chunks of up to 512 bytes in order. Each `offset` must equal the `next` from the previous reply.
   - A chunk at an offset already written is acknowledged without writing it again.
3. Send `COMMIT` with the IEEE CRC-32 of the whole stream. The device compares it with the CRC of what it reads back
   from flash. Only then does it save the directory, so a transfer that is cut off leaves nothing behind.

To **change an icon**, send `BEGIN` with `kind` 1, the used `slot`, and `total` = 1184. The other fields are
ignored. Then send `DATA` and `COMMIT` as above. The device copies the sound's first sector with the new icon in it.

A new `BEGIN` aborts any open transfer. So does a USB reconnect.

## Formats

**Icon** (1184 bytes): `palette[16]` as RGB565 u16 little-endian (32 bytes), then the 48×48 pixels row-major, top row
first. There are 2 pixels per byte, and the **high nibble is the left pixel**.

**Audio**: mono IMA ADPCM, 4 bits a sample.
- It uses the standard IMA step table (89 entries) and index table (−1 −1 −1 −1 2 4 6 8).
- The decoder starts at predictor 0 and step index 0.
- The first sample of each byte is in its **low nibble**.
- `frames` is the number of samples, and `audio_bytes` = ceil(`frames` / 2).
- `rate` is the sample rate in Hz, 4000..44100. The default is 16000; the device resamples to 44.1 kHz.

**Modes**: 0 one-shot (a press restarts it), 1 gate (it plays while held), 2 loop (a press starts it and the next
press stops it).

**Gain**: Q8, where 256 = unity. The range is 0..512, and key velocity scales it further.
