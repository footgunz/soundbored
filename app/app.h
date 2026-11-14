/* SPDX-License-Identifier: MPL-2.0
 * Copyright (C) 2026 Charles Vestal (the template this grew from) */
/* soundbored: the FM-1 as a soundboard. Sounds (mono IMA ADPCM, a name and a 48x48 icon each) are uploaded over USB
 * SysEx (docs/protocol.md) into the flash's data windows, shown as a 4x3 grid of icons, and played by the keys.
 * This header is the app's half of the contract with the platform (device/unity.c, host/plat_host.c). */
#pragma once
#include <stdint.h>
#include "plat.h"

#define APP_NAME "SOUNDBORED"
#define APP_SPLASH_RGB RGB(242, 120, 72)
#define APP_BLOCK 256u                   /* frames per audio block: 5.8 ms at 44.1 kHz */
#define APP_TOUCH                        /* velocity from the keys (lib/touch.h) */
#define APP_SYSEX                        /* the upload protocol: app_sysex (docs/protocol.md) */
#define APP_BLE_AT_BOOT (!sb_ble_off())  /* Bluetooth at power-on: as the player left it (REC held) */
int sb_ble_off(void);

/* the store: the app's objects (settings, the sound directory), the panel calibration and Bluetooth's pairing (the
 * platform's), and their flash offsets: two 4 KiB sectors each. The directory's pair sits just below the panel's,
 * at the top of the data area; the audio sectors are the rest of the data windows (app.c SEC_*) */
enum { OBJ_SETTINGS, OBJ_PANEL, OBJ_BLE, OBJ_DIR, OBJ_NOBJ };
#define APP_STORE_MAP {0xFC000u, 0xDC000u, 0xDE000u, 0xDA000u}

/* the contract: the platform calls these */
void app_init(void);                     /* boot: the saved directory and settings (or empty ones) */
void app_render(int32_t *lr, uint32_t n, uint32_t master_q12);   /* audio interrupt: n stereo frames, 24-bit */
void app_panic(void);                    /* silence now (before an update rewrites the flash) */
void app_ui_init(void);                  /* the first screen, after the splash */
void app_frame(void);                    /* the UI: input and a redraw, about 60 times a second */
void app_input_only(void);               /* between frames: input only */
void app_say(const char *a, const char *b);   /* a short message on the screen and to a screen reader */
int app_sysex(const uint8_t *p, uint32_t n);  /* a SysEx frame from USB (the bytes between F0 and F7): 1 = ours */

/* the host simulator's checks (host/plat_host.c "expect"): sounds, free, voices, page, cursor, upload, status */
#define APP_HOST_EXPECT
int app_expect(const char *what, int *got);
