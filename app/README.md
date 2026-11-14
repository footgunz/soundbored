# app: SOUNDBORED's firmware

This is an fm1-base app, started from `base/template`.

| File | What |
| --- | --- |
| `app.h` | Name, block size, the store's objects (settings, the sound directory) and the platform contract |
| `app.c` | Storage (the sector chains and directory), the voices (ADPCM, resampled to 44.1 kHz), the SysEx protocol, the grid UI |
| `fm1.toml` | Build and site settings |
| `tests/sounds.txt` | Simulator checks. Its `@` lines are protocol frames that `tools/sbtool.py` expands |
| `tests/screens.txt` | The manual's screenshots |
| `docs/MANUAL.md`, `site/landing.md` | The manual and the site's front page |

## Build and test (from the repo root)

    export AC79_SDK=~/fw-AC79_AIoT_SDK JIELI_TOOLCHAIN=~/.jieli/toolchain
    uv run base/tools/build.py app          # app/build/soundbrd.fwsc
    app/tests/run.sh                        # host simulator: build, expand, run

    # the screenshots:
    uv run tools/sbtool.py expand app/tests/screens.txt app/build/host/screens.txt
    app/build/host/soundbrd_host app/build/host/screens.txt app/docs/img

## Flash layout

| | |
| --- | --- |
| Audio sectors | 94 × 3840 bytes. XDATA0 has 4, the data area `0x97000..0xD9FFF` has 67, and XDATA1 has 23. The bytes `0xF00..0xFFF` of every sector stay erased. |
| Directory | Store object `OBJ_DIR` at `0xDA000` (A/B). It holds a FAT of the chains and 48 entries. |
| Settings | `OBJ_SETTINGS` at `0xFC000`. Panel `0xDC000`, Bluetooth `0xDE000` (the platform's) |
