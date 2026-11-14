# soundbored: research notes (2026-11-14)

Third-party firmware for the M-VAVE FM-1. First target: a soundboard. Mono samples, each with a short name and a
small icon, are uploaded from a local web page over Web MIDI SysEx and played on the device. You can add, edit and
remove sounds without reflashing.

## 1. Hardware facts

These come from the upstream SDK headers and felucca-bsp. Items marked "(src)" were read from source code; the rest
come from reviews or the manual.

| Item | Value |
| --- | --- |
| MCU | JieLi **AC791N** ("WL82"), PI32v2 core, dual core (the second core is experimental in the community BSPs) (src) |
| RAM | About 511 KiB of internal SRAM, no SDRAM (src: `RAM0_SIZE`). fm1-base gives an app 96 KB for `.data`/`.bss` plus a 336 KB buffer pool |
| Flash | **1 MiB** SPI NOR on SOIC-8: Puya P25Q80 (JEDEC 856014), or UC25HQ80 (B36014) on newer units. Code runs XIP from it (src) |
| Display | 1.54" ST7789, **240×240 RGB565**, SPI with DMA (src) |
| Audio out | I2S/ALNK0 to a DAC, stereo 24-bit (Q23), 44,118 Hz hardware rate, 128-frame blocks. Built-in speaker, TRS stereo out, headphone-detect switch (PB5) |
| Audio in | None connected |
| Controls | 27 silicone keys (F3–G5; velocity and pressure possible via felucca-bsp), 14 buttons with LEDs, 7 encoders, 1 master pot (src) |
| MIDI | USB-C MIDI (device; experimental USB host), TRS MIDI in, BLE MIDI |
| USB | Full-speed device: MIDI, CDC serial and UAC audio classes are available in felucca-bsp |
| Power | 2000 mAh Li-ion (users have fitted 4000 mAh), USB-C charging; battery level on an ADC |
| Recovery | Mask-ROM "UBOOT" mode (USB `4C4A:8057`, "WL80UBOOT1.00"). The chip enters it after two failed boots, or from a key combination |

## 2. Candidate starting points

| | **m-vave/fm1_open** (upstream) | **felucca-bsp** | **fm1-base** (on felucca-bsp) |
| --- | --- | --- | --- |
| Nature | APP layer over a **binary** engine `libfm1_engine.a` (RTOS, USB, BLE, flash, updater, the whole groovebox engine) | From-scratch bare-metal chip and board layer, no audio engine or UI | Platform and template above felucca-bsp: screen, fonts, input, audio, MIDI, storage, SysEx, updater |
| License | APP: GPLv3 with an SDK linking exception. Engine: proprietary, FM1-only grant | MPL-2.0 (per file) | MPL-2.0 (an app built on it can use any licence) |
| Toolchain | **Windows-only** JieLi 2.5.3, PowerShell build, hash-pinned | JieLi **Linux** x86-64 clang 4.0.1 for pi32v2 (`get_toolchain.sh`) | Same as felucca-bsp, plus `tools/build.py`; `emcc` for the browser emulator |
| Coupling | The lib calls ~30 `groove_*` hooks (screen, project, MIDI, samples, transfer), so the app is shaped around the groovebox | None | App callbacks (`app_init`, `app_render`, `app_tick`, …) |
| Dev loop | Flash and test | Flash and test | **Host simulator and browser (WASM) emulator** of the same app |
| Storage API | `fm1_flash_*` over a 524 KiB user partition, already used by projects, samples and the DX7 library | `fl_*` raw with write-region policy | `plat_data*` (read in place, erase and write), `APP_STORE_MAP` objects, backup over USB |
| Host comms | `fm1_app_sysex` (≤1024 B frames in, ≤128 B replies out) | USB MIDI and CDC | `plat_sysex_send` and `APP_USB_CMD` (update-style framing; data pulled from the host) |
| Installer | Their web workbench (Web MIDI) | `fm1_install.py`, `fm1_rescue` | Web installer page, `fm1_install.py` |
| Shipping firmwares | Official Open V14 | Felucca (GPL) | CTL-1, Radio (MPL) |

**Recommendation: build on fm1-base, using felucca-bsp underneath.**
- It works natively on Linux and WSL2. The upstream SDK needs Windows plus a hash-pinned vendor installer.
- There is no proprietary engine to work around. We own the audio path, so sample playback is a small mixer we write.
- The host simulator and browser emulator give fast iteration without flashing.
- The storage and SysEx APIs are already shaped for what we need.
- MPL-2.0 lets us choose our own licence.

Keep upstream fm1_open as a **reference** for two things: its SysEx file-transfer protocol (`app/transfer.c`) and its
SEA codec (`web/synth/sea_*`, MIT).

Other community firmwares: Felucca, Hortator, JIANT FM, Baud Girl FM-1+VA, and Groove OS (paid). These are useful to
read but are not better bases for this project.

## 3. Storage budget, the main constraint

With the stock 1 MiB flash, fm1-base gives the app these data windows:

| Window | Range | Size |
| --- | --- | --- |
| `PLAT_DATA` (store objects + big data) | `0x97000–0xE0000` | 292 KiB |
| `PLAT_XDATA0` | `0x93000–0x97000` | 16 KiB |
| `PLAT_XDATA1` | `0xE5000–0xFC000` | 92 KiB |
| `PLAT_XDATA2` (opt-in) | `0xFC000–0xFF000` | 12 KiB |
| **Total** | | **≈ 412 KiB** |

Constraint: in XDATA0 and XDATA1, bytes `0xF00–0xF07` of every 4 KiB sector must stay `0xFF`. Otherwise the update
loader may read them as an update record.

Seconds of mono audio in about 400 KiB, with 2 KiB per sound reserved for metadata and the icon:

| Format | Bytes/s | ≈ seconds |
| --- | --- | --- |
| PCM 16-bit @ 22.05 kHz | 44,100 | 9 |
| PCM 8-bit / µ-law @ 16 kHz | 16,000 | 25 |
| IMA ADPCM 4-bit @ 22.05 kHz | 11,025 | 36 |
| IMA ADPCM 4-bit @ 16 kHz | 8,000 | 50 |
| SEA5 @ 32 kHz (upstream format, ~5.7 bit) | 22,800 | 18 |
| IMA ADPCM 4-bit @ 11.025 kHz | 5,513 | 72 |

Suggested default: **IMA ADPCM, 4-bit, 16 kHz or 22.05 kHz**, chosen per file and converted in the browser. Decoding
is cheap for a handful of voices with no pitch-shift. Felucca's ADPCM cost figures were for 8 pitched voices, which is
not our case. The device resamples to 44.1 kHz with linear interpolation, and the 44.1k/22.05k ratio is an exact 2×.

Capacity upgrade option: replace the SOIC-8 flash with a larger part (up to 16 MiB with 3-byte addressing). The
felucca-bsp driver supports this, but it is **unqualified on hardware**, and the XIP-mapped window stays at 1 MiB.
Samples above 1 MiB would need streaming through `fl_read` into RAM ring buffers instead of in-place reads. This is a
later phase, not needed for v1.

## 4. Proposed soundboard design (draft)

**Metadata per sound**
- Name: 12–16 printable ASCII characters.
- Icon: **32×32 RGB565 (2 KiB)** to start. It tiles well on 240×240, for example a 4×3 grid of 56 px cells with a
  label line. 48×48 with a 16-colour palette (1.2 KiB) is an alternative.
- Format, rate, frame count, gain, a play mode (one-shot, gate, or loop) and a key binding.

**Flash layout**
- A directory with a header and fixed entries. It is double-buffered across two sectors, with a sequence number and a
  CRC, so an interrupted write falls back to the previous copy.
- Sample data goes in 4 KiB sectors tracked by a free map. Each entry lists its extents, so we can delete without
  compacting.
- Delete marks the entry dead and frees its sectors. Edit rewrites only the directory entry and icon, or the audio
  if needed.
- A per-file CRC32 is written last as the commit.

**Host protocol** (Web MIDI SysEx, request/ack, modelled on upstream `transfer.c`)
- Messages: `INFO`, `LIST`, `GET_META`, `BEGIN_UPLOAD(size, meta)`, `CHUNK(offset, data)`, `COMMIT(crc)`, `DELETE`,
  `UPDATE_META`, `PLAY(id)` (preview), `FORMAT`.
- Encoding: 8-to-7-bit packing, one request in flight, exact retry of a request gets the cached reply, and a 7-bit
  checksum.
- Uploads should expect pauses while a flash erase runs (tens to hundreds of ms per sector). Audio is muted during
  each erase or write; we can choose to block playback while an upload is in progress.

**Playback**
- Up to about 4–8 simultaneous voices, read in place from mapped flash and mixed into the 128-frame render.
- Keys trigger the sound bound to them. Encoders and buttons navigate pages and adjust volume.
- MIDI notes in can also trigger sounds.

**Web UI**: Vite with TypeScript and a modern component framework, plus hot reload.
- Uses the Web MIDI API with `{sysex: true}`. This is Web **MIDI**, not WebUSB.
- Needs Chrome or Edge on a secure context; `localhost` counts.
- Converts audio in the browser with Web Audio: decode, downmix to mono, resample, normalise, trim, then encode to
  ADPCM.
- Icon tool: crop or scale an image to 32×32, then quantise to RGB565.

## 5. Tooling checklist (this machine: WSL2, Linux)

| Need | Source | Notes |
| --- | --- | --- |
| JieLi pi32v2 toolchain (Linux) | `fm1-base/tools/get_toolchain.sh` → `~/.jieli` | Runs natively in WSL2; no Docker needed |
| JieLi AC79 SDK (Apache-2.0) | `gitee.com/Jieli-Tech/fw-AC79_AIoT_SDK` tag `AC79NN_SDK_V1.2.1_2023-12-13` | Only for packaging files, BLE or WiFi |
| Python 3 + Pillow, fontTools | pip | Font and icon rasterising in the fm1-base and Felucca builds |
| emscripten (`emcc`) | emsdk | Browser emulator build (`build.py --web`) |
| Node.js + Vite | nvm or system | Web UI. **Not installed yet** |
| Chrome or Edge on Windows | — | Web MIDI to the device. The Vite server in WSL is reachable at `localhost` |
| `fm1_install.py` / `fm1_rescue` | felucca-bsp / fm1-base tools | Need pyusb/libusb **on the side that owns the USB device**: usbipd-win to pass it into WSL2, or run on Windows. The web installer avoids this |
| Stock firmware `.fwsc` (V15/V16) | m-vave.com download; V15 in upstream `sdk/firmware/` | Keep a copy before the first flash |

## 6. Risks and open questions

- **Bricking.** A firmware that crashes before USB comes up cannot take a USB-MIDI update. Recovery goes through the
  mask-ROM UBOOT and `fm1_rescue`, which never writes the bootloader head below `0x4000`.
  - Before flashing our own firmware, **do a full flash backup**. The rescue script does this in its dry-run mode.
  - **Confirm the rescue path works from this machine** (WSL2 plus usbipd, or native Windows).
- Newer units with the UC25HQ80 flash need a recent loader. Earlier Felucca releases could not update them, so check
  the unit's JEDEC ID.
- Moving from stock or upstream firmware wipes their project and sample data. Back up through the official workbench
  first.
- Update and loader contracts: the app must stay below `0x93000`, and sectors `0xE0000–0xE5000` are OTA staging.
- To decide:
  - Sample rate and codec defaults.
  - Maximum number of sounds: the screen grid, and 27 keys.
  - Icon size and colour depth.
  - Whether a flash-chip upgrade is in scope.

## Sources

- Upstream: https://github.com/m-vave/fm1_open (read at commit `4c7496d`)
- felucca-bsp: https://github.com/hugelton/felucca-bsp (`docs/FLASH.md`, `docs/EXPERIMENTAL.md`, `tools/fm1_rescue.py`)
- fm1-base: https://github.com/charlesvestal/fm1-base (`include/plat.h`, README)
- Felucca: https://github.com/hugelton/Felucca (`BUILDING.md`)
- jl-uboot-tool: https://github.com/kagaimiq/jl-uboot-tool
- Synthanatomy roundup of custom firmwares: https://synthanatomy.com/2026/10/hugelton-instruments-felucca-custom-m-vave-fm-1-firmware-turns-it-into-a-multi-engine-synth.html
- Specs: https://manuals.plus/?p=21387493, https://synthanatomy.com/2026/07/m-vave-fm-1-review-low-budget-pocket-fm-ynthesizer-with-iconic-sounds.html, https://scrapbox.io/zenwerk/FM-1
