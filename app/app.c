/* SPDX-License-Identifier: MPL-2.0
 * Copyright (C) 2026 Charles Vestal (the template this grew from) */
/* soundbored: a soundboard. Up to 48 sounds, each mono IMA ADPCM with a name and a 48x48 16-colour icon, live in
 * the flash's data windows; the screen shows them 12 at a time as a 4x3 grid, the keys play them (each sound may own
 * a key; MIDI note 53 + k plays key k), and a computer adds, edits, moves and deletes them over USB SysEx
 * (docs/protocol.md). Part of the unity build (device/unity.c, host/plat_host.c), after the platform: gfx.c and
 * announce.c are in scope.
 *
 * Storage: the audio sectors (SEC_*) hold 3840 bytes each (0x000..0xEFF; 0xF00..0xFFF is left erased, as the XDATA
 * windows need: plat.h). A sound is a chain of them, its stream the icon (ICON_BYTES) then the audio. The directory
 * (dir_t: a FAT of the chains and the entries) is a store object, A/B and CRC'd by the platform: an upload writes its
 * sectors first and the directory last, so a cut-off transfer leaves nothing. */

/* ------------------------------------------------------------------ store --- */
#define NSLOT 48u
#define PER_PAGE 12u
#define NPAGE (NSLOT / PER_PAGE)
#define SEC_PAY 3840u                    /* bytes a sector holds */
#define ICON_W 48u
#define ICON_PAL 32u                     /* 16 x RGB565 */
#define ICON_BYTES (ICON_PAL + ICON_W * ICON_W / 2u)   /* 1184 */
#define NAME_MAX 16u
#define MAX_CHUNK 512u
/* the audio sectors, in index order: XDATA0 (4), the data area below the directory (67), XDATA1 (23) */
#define SEC_X0 4u
#define SEC_D 67u
#define SEC_X1 23u
#define NSEC (SEC_X0 + SEC_D + SEC_X1)   /* 94 */
#define FAT_FREE 0xFFu
#define FAT_END 0xFEu
#define KEY_NONE 0xFFu
#define KEY_AUTO 0xFEu
enum { MODE_ONESHOT, MODE_GATE, MODE_LOOP, NMODE };

typedef struct {
    uint8_t used, first, key, mode;      /* first: the chain's first sector */
    uint16_t gain, rate;                 /* gain Q8 (256 = 1); rate Hz */
    uint32_t frames, abytes;             /* samples; audio bytes (the stream is ICON_BYTES more) */
    uint8_t nsec, rsv[3];
    char name[NAME_MAX];                 /* NUL-padded, not terminated at 16 */
} entry_t;

#define DIR_MAGIC 0x31444253u            /* "SBD1" */
typedef struct {
    uint32_t magic;
    uint8_t fat[96];                     /* NSEC used: the next sector of a chain, FAT_END, FAT_FREE */
    entry_t e[NSLOT];
} dir_t;
_Static_assert(sizeof(dir_t) <= PLAT_STORE_MAX, "the directory is one store object");

static dir_t dir;                        /* what the render plays from: changed only under plat_lock */
static dir_t tmp;                        /* the next directory, built and saved before it replaces dir */
static uint8_t key_slot[NKEYS];          /* key -> slot, or 0xFF (from dir) */

static uint32_t sec_off(uint32_t i)
{
    if (i < SEC_X0)
        return PLAT_XDATA0_LO + i * 0x1000u;
    if (i < SEC_X0 + SEC_D)
        return PLAT_DATA_LO + (i - SEC_X0) * 0x1000u;
    return PLAT_XDATA1_LO + (i - SEC_X0 - SEC_D) * 0x1000u;
}

static uint32_t sectors_for(uint32_t stream) { return (stream + SEC_PAY - 1u) / SEC_PAY; }

static void keys_index(const dir_t *d)
{
    uint32_t s;
    for (s = 0; s < NKEYS; s++)
        key_slot[s] = 0xFFu;
    for (s = 0; s < NSLOT; s++)
        if (d->e[s].used && d->e[s].key < NKEYS && key_slot[d->e[s].key] == 0xFFu)
            key_slot[d->e[s].key] = (uint8_t)s;
}

/* a directory read back is checked whole: every chain walked (a broken or crossed one drops its entry), every sector
 * no chain reaches freed */
static void dir_repair(dir_t *d)
{
    uint8_t seen[NSEC];
    uint32_t s, i;
    memset(seen, 0, sizeof seen);
    for (s = 0; s < NSLOT; s++) {
        entry_t *e = &d->e[s];
        uint32_t sec, n = 0, ok = 1;
        if (!e->used)
            continue;
        if (e->mode >= NMODE || e->rate < 4000u || e->rate > 44100u || e->gain > 512u ||
            e->abytes != (e->frames + 1u) / 2u || e->nsec != sectors_for(ICON_BYTES + e->abytes))
            ok = 0;
        for (sec = e->first; ok && sec != FAT_END; sec = d->fat[sec]) {
            if (sec >= NSEC || seen[sec] || ++n > e->nsec)
                ok = 0;
            else
                seen[sec] = (uint8_t)(s + 1u);
        }
        if (ok && n != e->nsec)
            ok = 0;
        if (!ok) {                           /* undo the marks it made, drop it */
            for (i = 0; i < NSEC; i++)
                if (seen[i] == s + 1u)
                    seen[i] = 0;
            memset(e, 0, sizeof *e);
        }
        if (e->key != KEY_NONE && e->key >= NKEYS)
            e->key = KEY_NONE;
        for (i = 0; i < NAME_MAX; i++)       /* printable ASCII, NUL-padded */
            if (e->name[i] && (e->name[i] < 0x20 || e->name[i] > 0x7E))
                e->name[i] = '?';
    }
    for (i = 0; i < NSEC; i++)
        if (!seen[i])
            d->fat[i] = FAT_FREE;
    for (i = NSEC; i < sizeof d->fat; i++)
        d->fat[i] = FAT_FREE;
}

static void dir_empty(dir_t *d)
{
    memset(d, 0, sizeof *d);
    d->magic = DIR_MAGIC;
    memset(d->fat, FAT_FREE, sizeof d->fat);
}

static uint32_t free_sectors(const dir_t *d)
{
    uint32_t i, n = 0;
    for (i = 0; i < NSEC; i++)
        n += d->fat[i] == FAT_FREE;
    return n;
}

static uint32_t used_slots(void)
{
    uint32_t s, n = 0;
    for (s = 0; s < NSLOT; s++)
        n += dir.e[s].used;
    return n;
}

/* ----------------------------------------------------------------- voices --- */
/* IMA ADPCM, the standard tables */
static const int16_t IMA_STEP[89] = {
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97,
    107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796,
    876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871,
    5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623,
    27086, 29794, 32767};
static const int8_t IMA_IDX[8] = {-1, -1, -1, -1, 2, 4, 6, 8};

#define NVOICE 8u
#define ENV_ONE 32768
#define ENV_REL 96                       /* per frame: ~8 ms from full to nothing */
typedef struct {
    uint8_t on, slot, key, mode, releasing, hi, cur, sec;
    int8_t idx;
    uint16_t pos;                        /* the next byte in the sector */
    const uint8_t *p;                    /* the sector's bytes */
    uint32_t left;                       /* samples still to decode */
    int32_t pred, s0, s1;                /* the decoder; the two samples interpolated between */
    uint32_t frac, inc;                  /* Q16 position between s0 and s1; the step a frame (rate / 44100) */
    int32_t gain, env;                   /* Q8 (the entry's and the velocity's); Q15 */
    uint32_t age;
} voice_t;
static voice_t voice[NVOICE];
static uint32_t voice_age;
static int32_t gain_now;                 /* MASTER, gliding: Q12 << 8 */
static int32_t mix[APP_BLOCK];

static void voice_rewind(voice_t *v)     /* the sound from its start (under the lock) */
{
    const entry_t *e = &dir.e[v->slot];
    v->sec = e->first;
    v->p = plat_data(sec_off(v->sec));
    v->pos = (uint16_t)ICON_BYTES;
    v->left = e->frames;
    v->pred = 0;
    v->idx = 0;
    v->hi = 0;
    v->s0 = v->s1 = 0;
    v->frac = 0;
}

static int32_t voice_next(voice_t *v)    /* the next sample, 0 once done (v->left 0) */
{
    uint32_t nib;
    int32_t step, diff;
    if (!v->left || !v->p)
        return 0;
    if (!v->hi) {
        if (v->pos >= SEC_PAY) {
            uint8_t nx = dir.fat[v->sec];
            if (nx >= NSEC) {
                v->left = 0;
                return 0;
            }
            v->sec = nx;
            v->p = plat_data(sec_off(nx));
            v->pos = 0;
        }
        v->cur = v->p[v->pos++];
        nib = v->cur & 15u;
        v->hi = 1;
    } else {
        nib = (uint32_t)v->cur >> 4;
        v->hi = 0;
    }
    v->left--;
    step = IMA_STEP[v->idx];
    diff = step >> 3;
    if (nib & 4u)
        diff += step;
    if (nib & 2u)
        diff += step >> 1;
    if (nib & 1u)
        diff += step >> 2;
    v->pred += (nib & 8u) ? -diff : diff;
    v->pred = clamp(v->pred, -32768, 32767);
    v->idx = (int8_t)clamp(v->idx + IMA_IDX[nib & 7u], 0, 88);
    return v->pred;
}

/* a press: slot's sound, at velocity vel (1..127), for key (KEY_NONE: a preview, which never gates) */
static void voice_press(uint32_t slot, uint32_t vel, uint32_t key)
{
    const entry_t *e;
    voice_t *v = 0;
    uint32_t i, f = plat_lock(), mode;
    if (slot >= NSLOT || !(e = &dir.e[slot])->used) {
        plat_unlock(f);
        return;
    }
    mode = e->mode == MODE_GATE && key == KEY_NONE ? MODE_ONESHOT : e->mode;
    for (i = 0; i < NVOICE; i++)
        if (voice[i].on && voice[i].slot == slot && !voice[i].releasing)
            v = &voice[i];
    if (v && mode == MODE_LOOP) {            /* a loop: the second press stops it */
        v->releasing = 1;
        plat_unlock(f);
        return;
    }
    if (!v) {                                /* a free voice, else the oldest */
        for (i = 0; i < NVOICE && voice[i].on; i++)
            ;
        if (i == NVOICE) {
            uint32_t old = 0;
            for (i = 1; i < NVOICE; i++)
                if (voice_age - voice[i].age > voice_age - voice[old].age)
                    old = i;
            i = old;
        }
        v = &voice[i];
    }
    v->slot = (uint8_t)slot;
    v->key = (uint8_t)key;
    v->mode = (uint8_t)mode;
    v->releasing = 0;
    v->gain = (int32_t)((e->gain * (vel < 1u ? 1u : vel > 127u ? 127u : vel)) / 127u);
    v->inc = (uint32_t)e->rate * 65536u / 44100u;
    v->env = ENV_ONE;
    v->age = ++voice_age;
    voice_rewind(v);
    v->on = 1;
    plat_unlock(f);
}

static void voice_release(uint32_t key)  /* a key let go: its gated sounds fade */
{
    uint32_t i, f = plat_lock();
    for (i = 0; i < NVOICE; i++)
        if (voice[i].on && voice[i].key == key && voice[i].mode == MODE_GATE)
            voice[i].releasing = 1;
    plat_unlock(f);
}

static void voices_stop(int slot)        /* -1: every voice; else the slot's (before its sectors change) */
{
    uint32_t i, f = plat_lock();
    for (i = 0; i < NVOICE; i++)
        if (slot < 0 || voice[i].slot == (uint32_t)slot)
            voice[i].on = 0;
    plat_unlock(f);
}

static void midi_in(void)                /* audio interrupt: notes in play the keys' sounds */
{
    uint32_t pkt;
    int port;
    while (plat_midi_in(&pkt, &port)) {
        uint32_t st = (pkt >> 8) & 0xF0u, d1 = (pkt >> 16) & 0x7Fu, d2 = pkt >> 24 & 0x7Fu;
        int32_t k = (int32_t)d1 - 53;
        if (k < 0 || k >= (int32_t)NKEYS)
            continue;
        if (st == 0x90u && d2) {
            if (key_slot[k] != 0xFFu)
                voice_press(key_slot[k], d2, (uint32_t)k);
        } else if (st == 0x80u || st == 0x90u) {
            voice_release((uint32_t)k);
        }
    }
}

void app_render(int32_t *lr, uint32_t n, uint32_t master_q12)
{
    uint32_t i, k;
    int32_t g = (int32_t)master_q12 << 8;
    midi_in();
    if (n > APP_BLOCK)
        n = APP_BLOCK;
    for (i = 0; i < n; i++)
        mix[i] = 0;
    for (k = 0; k < NVOICE; k++) {
        voice_t *v = &voice[k];
        if (!v->on)
            continue;
        /* 32-bit only: a 64-bit multiply beside the loads here can corrupt a register (felucca-bsp docs/CPU.md) */
        for (i = 0; i < n; i++) {
            int32_t s = v->s0 + (((v->s1 - v->s0) * (int32_t)(v->frac >> 2)) >> 14);   /* 2^16 x 2^14 */
            int32_t ge = (v->gain * v->env) >> 15;                                      /* Q8: 2^9 x 2^15 */
            mix[i] += (s * ge) >> 8;                                                    /* 2^16 x 2^9 */
            v->frac += v->inc;
            while (v->frac >= 65536u) {
                v->frac -= 65536u;
                v->s0 = v->s1;
                v->s1 = voice_next(v);
            }
            if (v->releasing && (v->env -= ENV_REL) <= 0) {
                v->env = 0;
                break;
            }
            if (!v->left && v->s0 == 0 && v->s1 == 0) {
                if (v->mode == MODE_LOOP && !v->releasing) {
                    voice_rewind(v);
                    continue;
                }
                break;
            }
        }
        if (i < n)
            v->on = 0;
    }
    for (i = 0; i < n; i++) {
        int32_t s = clamp(mix[i], -(1 << 18), 1 << 18);
        gain_now += (g - gain_now) >> 8;     /* ~6 ms: turning MASTER does not click */
        s = clamp((s * (gain_now >> 8)) >> 4, -8388607, 8388607);
        lr[2 * i] = s;
        lr[2 * i + 1] = s;
    }
}

void app_panic(void) { voices_stop(-1); }

/* --------------------------------------------------------------- settings --- */
#define SET_MAGIC 0x31534253u            /* "SBS1" */
typedef struct {
    uint32_t magic;
    uint8_t ble_off;                     /* Bluetooth switched off (REC held) */
    uint8_t page, cursor, rsv;
} settings_t;
static settings_t set;

int sb_ble_off(void) { return set.ble_off; }

static void settings_save(void) { (void)plat_store_save(OBJ_SETTINGS, &set, sizeof set); }

void app_init(void)
{
    if (plat_store_load(OBJ_SETTINGS, &set, sizeof set) != (int)sizeof set || set.magic != SET_MAGIC ||
        set.ble_off > 1u || set.cursor >= NSLOT) {
        memset(&set, 0, sizeof set);
        set.magic = SET_MAGIC;
    }
    if (plat_store_load(OBJ_DIR, &dir, sizeof dir) != (int)sizeof dir || dir.magic != DIR_MAGIC)
        dir_empty(&dir);
    dir_repair(&dir);
    keys_index(&dir);
}

/* tmp saved, then it is the directory (0); else nothing changed */
static int dir_commit(void)
{
    uint32_t f;
    if (plat_store_save(OBJ_DIR, &tmp, sizeof tmp) != 0)
        return -1;
    f = plat_lock();
    memcpy(&dir, &tmp, sizeof dir);
    keys_index(&dir);
    plat_unlock(f);
    return 0;
}

static void chain_free(dir_t *d, uint32_t first)
{
    uint32_t sec = first, n = 0;
    while (sec < NSEC && n++ < NSEC) {
        uint32_t nx = d->fat[sec];
        d->fat[sec] = FAT_FREE;
        sec = nx;
    }
}

/* a key for slot s in d: k (KEY_AUTO: s itself if under 27 and free); another sound's hold on it is taken */
static void key_take(dir_t *d, uint32_t s, uint32_t k)
{
    uint32_t i;
    if (k == KEY_AUTO) {
        k = KEY_NONE;
        if (s < NKEYS) {
            k = s;
            for (i = 0; i < NSLOT; i++)
                if (i != s && d->e[i].used && d->e[i].key == s)
                    k = KEY_NONE;
        }
    }
    if (k >= NKEYS)
        k = KEY_NONE;
    if (k != KEY_NONE)
        for (i = 0; i < NSLOT; i++)
            if (i != s && d->e[i].key == k)
                d->e[i].key = KEY_NONE;
    d->e[s].key = (uint8_t)k;
}

/* --------------------------------------------------------------- protocol --- */
enum { ST_OK, ST_FRAME, ST_CMD, ST_SLOT, ST_SPACE, ST_BUSY, ST_OFFSET, ST_CRC, ST_FLASH, ST_ARG };
enum { C_HELLO = 0x01, C_GET_ENTRY = 0x02, C_GET_ICON = 0x03, C_BEGIN = 0x10, C_DATA = 0x11, C_COMMIT = 0x12,
       C_ABORT = 0x13, C_SET_META = 0x20, C_DELETE = 0x21, C_SWAP = 0x22, C_PLAY = 0x23, C_FORMAT = 0x24 };

static uint32_t crc32_add(uint32_t c, const uint8_t *p, uint32_t n)   /* IEEE, reflected: c starts at 0 */
{
    static const uint32_t T[16] = {0x00000000u, 0x1DB71064u, 0x3B6E20C8u, 0x26D930ACu, 0x76DC4190u, 0x6B6B51F4u,
                                   0x4DB26158u, 0x5005713Cu, 0xEDB88320u, 0xF00F9344u, 0xD6D6A3E8u, 0xCB61B38Cu,
                                   0x9B64C2B0u, 0x86D3D2D4u, 0xA00AE278u, 0xBDBDF21Cu};
    c = ~c;
    while (n--) {
        c ^= *p++;
        c = (c >> 4) ^ T[c & 15u];
        c = (c >> 4) ^ T[c & 15u];
    }
    return ~c;
}

static struct {                          /* the transfer under way */
    uint8_t open, kind, slot;
    uint8_t secs[NSEC], nsec;            /* the sectors it writes, in order */
    uint32_t total, next, crc;
    entry_t meta;
    uint32_t session;                    /* the USB connection it belongs to */
    uint32_t t0;
} up;

static struct {                          /* the frame being answered, and the last answer (a retry gets it again) */
    uint8_t body[MAX_CHUNK + 16u];
    uint32_t n;
    uint8_t frame[640];
    uint32_t frame_n;
    uint8_t last_cmd, last_seq, have_last;
    uint8_t status;                      /* the last status sent (host checks) */
} px;

static uint8_t raw[MAX_CHUNK + 16u];     /* a request's body, unpacked */

static uint32_t unpack7(const uint8_t *s, uint32_t n, uint8_t *d, uint32_t max)
{
    uint32_t o = 0;
    while (n) {
        uint32_t k = n - 1u < 7u ? n - 1u : 7u, i;
        uint8_t hi = *s++;
        n--;
        for (i = 0; i < k; i++) {
            if (o >= max)
                return 0xFFFFFFFFu;
            d[o++] = (uint8_t)(s[i] | ((hi >> i & 1u) << 7));
        }
        s += k;
        n -= k;
    }
    return o;
}

static uint32_t pack7(const uint8_t *s, uint32_t n, uint8_t *d)
{
    uint32_t o = 0;
    while (n) {
        uint32_t k = n < 7u ? n : 7u, i;
        uint8_t hi = 0;
        for (i = 0; i < k; i++)
            hi |= (uint8_t)((s[i] >> 7) << i);
        d[o++] = hi;
        for (i = 0; i < k; i++)
            d[o++] = s[i] & 0x7Fu;
        s += k;
        n -= k;
    }
    return o;
}

static void put8(uint32_t v) { px.body[px.n++] = (uint8_t)v; }
static void put16(uint32_t v) { put8(v); put8(v >> 8); }
static void put32(uint32_t v) { put16(v); put16(v >> 16); }
static uint32_t get16(const uint8_t *p) { return p[0] | (uint32_t)p[1] << 8; }
static uint32_t get32(const uint8_t *p) { return get16(p) | get16(p + 2) << 16; }

static void reply_begin(uint32_t status)
{
    px.n = 0;
    px.status = (uint8_t)status;
    put8(status);
}

static void reply_send(uint32_t cmd, uint32_t seq, int cache)
{
    uint32_t i, sum = 0, n = 0;
    uint8_t *f = px.frame;
    f[n++] = 0xF0; f[n++] = 0x7D; f[n++] = 0x53; f[n++] = 0x42;
    f[n++] = (uint8_t)((cmd | 0x40u) & 0x7Fu);
    f[n++] = (uint8_t)(seq & 0x7Fu);
    n += pack7(px.body, px.n, f + n);
    for (i = 4; i < n; i++)
        sum += f[i];
    f[n++] = (uint8_t)(sum & 0x7Fu);
    f[n++] = 0xF7;
    px.frame_n = n;
    px.have_last = (uint8_t)cache;
    px.last_cmd = (uint8_t)cmd;
    px.last_seq = (uint8_t)seq;
    (void)plat_sysex_send(f, n);
}

static void meta_get(entry_t *e, const uint8_t *p)   /* key, mode, gain, name[16] */
{
    uint32_t i;
    e->key = p[0];
    e->mode = p[1];
    e->gain = (uint16_t)get16(p + 2);
    for (i = 0; i < NAME_MAX; i++)
        e->name[i] = (char)(p[4 + i] >= 0x20 && p[4 + i] <= 0x7E ? p[4 + i] : 0);
    for (i = 0; i < NAME_MAX && e->name[i]; i++)
        ;
    for (; i < NAME_MAX; i++)                 /* NUL-padded after the first NUL */
        e->name[i] = 0;
}

static int meta_ok(const entry_t *e)
{
    return e->mode < NMODE && e->gain <= 512u && (e->key < NKEYS || e->key == KEY_NONE || e->key == KEY_AUTO);
}

static void up_abort(void) { up.open = 0; }

static uint32_t up_begin(const uint8_t *b, uint32_t n)
{
    uint32_t kind, slot, total, i, k, need;
    up_abort();
    if (n < 32u)
        return ST_ARG;
    kind = b[0];
    slot = b[1];
    total = get32(b + 2);
    memset(&up.meta, 0, sizeof up.meta);
    if (kind == 0u) {
        up.meta.rate = (uint16_t)get16(b + 6);
        up.meta.frames = get32(b + 8);
        meta_get(&up.meta, b + 12);
        up.meta.abytes = (up.meta.frames + 1u) / 2u;
        if (slot == 0xFFu)
            for (slot = 0; slot < NSLOT && dir.e[slot].used; slot++)
                ;
        if (slot >= NSLOT)
            return ST_SLOT;
        if (!meta_ok(&up.meta) || up.meta.rate < 4000u || up.meta.rate > 44100u || !up.meta.frames ||
            total != ICON_BYTES + up.meta.abytes)
            return ST_ARG;
    } else if (kind == 1u) {
        if (slot >= NSLOT || !dir.e[slot].used)
            return ST_SLOT;
        if (total != ICON_BYTES)
            return ST_ARG;
    } else {
        return ST_ARG;
    }
    need = sectors_for(total);
    if (need > free_sectors(&dir))
        return ST_SPACE;
    for (i = 0, k = 0; i < NSEC && k < need; i++)   /* the free sectors it writes; erased as it reaches each */
        if (dir.fat[i] == FAT_FREE)
            up.secs[k++] = (uint8_t)i;
    up.nsec = (uint8_t)need;
    up.kind = (uint8_t)kind;
    up.slot = (uint8_t)slot;
    up.total = total;
    up.next = 0;
    up.crc = 0;
    up.session = plat_usb_session();
    up.t0 = plat_ms();
    up.open = 1;
    return ST_OK;
}

static int sector_blank(uint32_t off)
{
    const uint32_t *w = (const uint32_t *)plat_data(off);
    uint32_t i;
    if (!w)
        return 0;
    for (i = 0; i < 1024u; i++)
        if (w[i] != 0xFFFFFFFFu)
            return 0;
    return 1;
}

static uint32_t up_data(const uint8_t *b, uint32_t n)
{
    uint32_t off, len;
    if (!up.open)
        return ST_BUSY;
    if (n < 5u)
        return ST_ARG;
    off = get32(b);
    len = n - 4u;
    b += 4;
    if (off + len <= up.next)                    /* written already (a retry): acknowledged */
        return ST_OK;
    if (off != up.next || off + len > up.total)
        return ST_OFFSET;
    while (len) {
        uint32_t si = off / SEC_PAY, in = off % SEC_PAY, k = SEC_PAY - in, base = sec_off(up.secs[si]);
        if (k > len)
            k = len;
        if (in == 0u && !sector_blank(base) && plat_data_erase(base) != 0) {
            up_abort();
            return ST_FLASH;
        }
        if (plat_data_write(base + in, b, k) != 0) {
            up_abort();
            return ST_FLASH;
        }
        up.crc = crc32_add(up.crc, plat_data(base + in), k);   /* what the flash holds, read back */
        off += k;
        b += k;
        len -= k;
    }
    up.next = off;
    return ST_OK;
}

static uint32_t up_commit(const uint8_t *b, uint32_t n)
{
    uint32_t i, s = up.slot;
    if (!up.open)
        return ST_BUSY;
    if (n < 4u)
        return ST_ARG;
    if (up.next != up.total)
        return ST_OFFSET;
    if (get32(b) != up.crc) {
        up_abort();
        return ST_CRC;
    }
    memcpy(&tmp, &dir, sizeof tmp);
    if (up.kind == 0u) {
        entry_t *e = &tmp.e[s];
        if (e->used)
            chain_free(&tmp, e->first);
        *e = up.meta;
        e->used = 1;
        e->first = up.secs[0];
        e->nsec = up.nsec;
        e->key = KEY_NONE;
        for (i = 0; i < up.nsec; i++)
            tmp.fat[up.secs[i]] = i + 1u < up.nsec ? up.secs[i + 1] : FAT_END;
        key_take(&tmp, s, up.meta.key);
    } else {                                     /* a new icon: the first sector copied with it in */
        entry_t *e = &tmp.e[s];
        uint32_t old = sec_off(e->first), neu = sec_off(up.secs[0]), at;
        static uint8_t buf[256];
        for (at = ICON_BYTES; at < SEC_PAY; at += sizeof buf) {
            uint32_t k = SEC_PAY - at < sizeof buf ? SEC_PAY - at : sizeof buf;
            memcpy(buf, plat_data(old + at), k);
            if (plat_data_write(neu + at, buf, k) != 0 || memcmp(plat_data(neu + at), buf, k)) {
                up_abort();
                return ST_FLASH;
            }
        }
        tmp.fat[up.secs[0]] = tmp.fat[e->first];
        tmp.fat[e->first] = FAT_FREE;
        e->first = up.secs[0];
    }
    voices_stop((int)s);                         /* its old sectors go */
    up_abort();
    if (dir_commit() != 0)
        return ST_FLASH;
    return ST_OK;
}

static void ui_dirty_all(void);
static void ui_select(uint32_t slot);

/* a frame: p = 7D 53 42 cmd seq packed... chk */
int app_sysex(const uint8_t *p, uint32_t n)
{
    uint32_t cmd, seq, i, sum = 0, bn, st = ST_OK;
    if (n < 6u || p[0] != 0x7Du || p[1] != 0x53u || p[2] != 0x42u)
        return 0;
    cmd = p[3];
    seq = p[4];
    for (i = 3; i < n - 1u; i++)
        sum += p[i];
    if ((sum & 0x7Fu) != p[n - 1u] || (bn = unpack7(p + 5, n - 6u, raw, sizeof raw)) == 0xFFFFFFFFu) {
        reply_begin(ST_FRAME);
        reply_send(cmd, seq, 0);
        return 1;
    }
    if (px.have_last && px.last_cmd == cmd && px.last_seq == seq) {   /* a retry: the same answer, not done again */
        (void)plat_sysex_send(px.frame, px.frame_n);
        return 1;
    }
    switch (cmd) {
    case C_HELLO:
        reply_begin(ST_OK);
        put8(1);
        put8(NSLOT);
        put8(NSEC);
        put8(free_sectors(&dir));
        put16(SEC_PAY);
        put8(ICON_W);
        put8(ICON_W);
        put16(ICON_BYTES);
        put16(MAX_CHUNK);
        put8(NAME_MAX);
        break;
    case C_GET_ENTRY: {
        const entry_t *e;
        if (bn < 1u || raw[0] >= NSLOT) {
            reply_begin(ST_SLOT);
            break;
        }
        e = &dir.e[raw[0]];
        reply_begin(ST_OK);
        put8(raw[0]);
        put8(e->used);
        put8(e->used ? e->key : KEY_NONE);
        put8(e->mode);
        put16(e->gain);
        put16(e->rate);
        put32(e->frames);
        put32(e->abytes);
        put8(e->nsec);
        for (i = 0; i < NAME_MAX; i++)
            put8((uint8_t)e->name[i]);
        break;
    }
    case C_GET_ICON: {
        uint32_t s, off, len;
        if (bn < 5u) {
            reply_begin(ST_ARG);
            break;
        }
        s = raw[0];
        off = get16(raw + 1);
        len = get16(raw + 3);
        if (s >= NSLOT || !dir.e[s].used) {
            reply_begin(ST_SLOT);
            break;
        }
        if (len > MAX_CHUNK || off + len > ICON_BYTES) {
            reply_begin(ST_ARG);
            break;
        }
        reply_begin(ST_OK);
        put8(s);
        put16(off);
        memcpy(px.body + px.n, plat_data(sec_off(dir.e[s].first)) + off, len);
        px.n += len;
        break;
    }
    case C_BEGIN:
        st = up_begin(raw, bn);
        reply_begin(st);
        put8(up.slot);
        put8(st == ST_OK ? up.nsec : 0u);
        break;
    case C_DATA:
        st = up_data(raw, bn);
        reply_begin(st);
        put32(up.next);
        break;
    case C_COMMIT: {
        uint32_t s = up.slot;
        st = up_commit(raw, bn);
        reply_begin(st);
        put8(s);
        if (st == ST_OK) {
            ui_select(s);
            app_say("RECEIVED", dir.e[s].name[0] ? dir.e[s].name : "SOUND");
        } else if (st == ST_CRC || st == ST_FLASH) {
            app_say("UPLOAD", st == ST_CRC ? "BAD CRC" : "FLASH ERROR");
        }
        break;
    }
    case C_ABORT:
        up_abort();
        reply_begin(ST_OK);
        break;
    case C_SET_META: {
        entry_t m;
        uint32_t s;
        memset(&m, 0, sizeof m);
        if (bn < 21u) {
            reply_begin(ST_ARG);
            break;
        }
        s = raw[0];
        meta_get(&m, raw + 1);
        if (s >= NSLOT || !dir.e[s].used) {
            reply_begin(ST_SLOT);
            break;
        }
        if (!meta_ok(&m)) {
            reply_begin(ST_ARG);
            break;
        }
        memcpy(&tmp, &dir, sizeof tmp);
        tmp.e[s].mode = m.mode;
        tmp.e[s].gain = m.gain;
        memcpy(tmp.e[s].name, m.name, NAME_MAX);
        key_take(&tmp, s, m.key);
        if (tmp.e[s].mode != dir.e[s].mode)
            voices_stop((int)s);
        reply_begin(dir_commit() == 0 ? ST_OK : ST_FLASH);
        break;
    }
    case C_DELETE: {
        uint32_t s = bn ? raw[0] : 0xFFu;
        if (s >= NSLOT || !dir.e[s].used) {
            reply_begin(ST_SLOT);
            break;
        }
        if (up.open && up.slot == s && up.kind == 1u)
            up_abort();
        voices_stop((int)s);
        memcpy(&tmp, &dir, sizeof tmp);
        chain_free(&tmp, tmp.e[s].first);
        memset(&tmp.e[s], 0, sizeof tmp.e[s]);
        reply_begin(dir_commit() == 0 ? ST_OK : ST_FLASH);
        break;
    }
    case C_SWAP: {
        uint32_t a, b, f;
        entry_t t;
        if (bn < 2u || (a = raw[0]) >= NSLOT || (b = raw[1]) >= NSLOT) {
            reply_begin(ST_SLOT);
            break;
        }
        if (up.open)
            up_abort();
        memcpy(&tmp, &dir, sizeof tmp);
        t = tmp.e[a];
        tmp.e[a] = tmp.e[b];
        tmp.e[b] = t;
        if (plat_store_save(OBJ_DIR, &tmp, sizeof tmp) != 0) {
            reply_begin(ST_FLASH);
            break;
        }
        f = plat_lock();                         /* the voices follow their sounds */
        memcpy(&dir, &tmp, sizeof dir);
        keys_index(&dir);
        for (i = 0; i < NVOICE; i++)
            voice[i].slot = voice[i].slot == a ? (uint8_t)b : voice[i].slot == b ? (uint8_t)a : voice[i].slot;
        plat_unlock(f);
        reply_begin(ST_OK);
        break;
    }
    case C_PLAY:
        if (bn < 1u) {
            reply_begin(ST_ARG);
            break;
        }
        if (raw[0] == 0xFFu) {
            voices_stop(-1);
            reply_begin(ST_OK);
        } else if (raw[0] >= NSLOT || !dir.e[raw[0]].used) {
            reply_begin(ST_SLOT);
        } else {
            voice_press(raw[0], 127, KEY_NONE);
            reply_begin(ST_OK);
        }
        break;
    case C_FORMAT:
        if (bn < 4u || memcmp(raw, "WIPE", 4)) {
            reply_begin(ST_ARG);
            break;
        }
        up_abort();
        voices_stop(-1);
        dir_empty(&tmp);
        reply_begin(dir_commit() == 0 ? ST_OK : ST_FLASH);
        if (px.status == ST_OK)
            app_say("ALL SOUNDS", "DELETED");
        break;
    default:
        reply_begin(ST_CMD);
        reply_send(cmd, seq, 0);
        return 1;
    }
    reply_send(cmd, seq, 1);
    ui_dirty_all();
    return 1;
}

/* --------------------------------------------------------------------- UI --- */
#define BAR_H 20
#define CELL_W 60
#define CELL_H 73
static struct {
    char msg[2][24];
    uint32_t msg_until;
    uint32_t keys, btn;
    uint32_t rec_t;
    uint8_t page, cursor;
    uint8_t dirty_bar, dirty_row[3];
    uint32_t playing;                    /* the page's slots sounding at the last draw: bit = position 0..11 */
    uint32_t up_pct;                     /* the transfer's progress at the last draw (+1; 0 none) */
    uint32_t session;
} ui;

static void ui_dirty_all(void)
{
    ui.dirty_bar = 1;
    ui.dirty_row[0] = ui.dirty_row[1] = ui.dirty_row[2] = 1;
}

static void text_cat(char *d, const char *s)
{
    while (*d)
        d++;
    while (*s)
        *d++ = *s++;
    *d = 0;
}

static void uint_text(uint32_t u, char *b)
{
    char t[12];
    int n = 0;
    do
        t[n++] = (char)('0' + u % 10u);
    while ((u /= 10u) && n < 11);
    while (n)
        *b++ = t[--n];
    *b = 0;
}

static void slot_name(uint32_t s, char *b)   /* NUL-terminated, 17 bytes */
{
    memcpy(b, dir.e[s].name, NAME_MAX);
    b[NAME_MAX] = 0;
    if (!b[0]) {
        b[0] = 0;
        text_cat(b, "SOUND ");
        uint_text(s + 1u, b + 6);
    }
}

void app_say(const char *a, const char *b)
{
    uint32_t i;
    char t[48];
    for (i = 0; i < 23u && a && a[i]; i++)
        ui.msg[0][i] = a[i];
    ui.msg[0][i] = 0;
    for (i = 0; i < 23u && b && b[i]; i++)
        ui.msg[1][i] = b[i];
    ui.msg[1][i] = 0;
    ui.msg_until = plat_ms() + 1500u;
    ui.dirty_bar = 1;
    if (ann_on()) {
        t[0] = 0;
        text_cat(t, ui.msg[0]);
        if (ui.msg[1][0]) {
            text_cat(t, " ");
            text_cat(t, ui.msg[1]);
        }
        ann_say(t, 0, ANN_NOW);
    }
}

static void say_cursor(void)
{
    char n[20], p[8];
    if (dir.e[ui.cursor].used)
        slot_name(ui.cursor, n);
    else {
        n[0] = 0;
        text_cat(n, "EMPTY ");
        uint_text(ui.cursor + 1u, n + 6);
    }
    p[0] = 0;
    text_cat(p, "PAGE ");
    uint_text(ui.page + 1u, p + 5);
    app_say(p, n);
}

static void speak(void)                  /* a screen reader that has just started listening hears the page */
{
    if (ann_on() && ann_where())
        say_cursor();
    ann_tick(plat_ms());
}

static void ui_select(uint32_t slot)
{
    if (slot >= NSLOT)
        return;
    ui.cursor = (uint8_t)slot;
    if (ui.page != slot / PER_PAGE) {
        ui.page = (uint8_t)(slot / PER_PAGE);
        ui_dirty_all();
    }
    ui.dirty_row[0] = ui.dirty_row[1] = ui.dirty_row[2] = 1;
}

static void page_step(int32_t d)
{
    int32_t p = ((int32_t)ui.page + d) % (int32_t)NPAGE;
    if (p < 0)
        p += (int32_t)NPAGE;
    ui_select((uint32_t)p * PER_PAGE + ui.cursor % PER_PAGE);
    say_cursor();
}

static void ble_toggle(void)
{
    set.ble_off = (uint8_t)!set.ble_off;
    settings_save();
    plat_ble_enable(!set.ble_off);
    app_say("BLUETOOTH", set.ble_off ? "OFF" : "ON");
}

static uint32_t keys_bound(void)
{
    uint32_t k, m = 0;
    for (k = 0; k < NKEYS; k++)
        if (key_slot[k] != 0xFFu)
            m |= 1u << k;
    return m;
}

static uint32_t keys_sounding(void)
{
    uint32_t i, m = 0;
    for (i = 0; i < NVOICE; i++)
        if (voice[i].on && dir.e[voice[i].slot].key < NKEYS)
            m |= 1u << dir.e[voice[i].slot].key;
    return m;
}

static void input(void)
{
    uint32_t keys, btn = plat_buttons(), k;
    int32_t e;
    touch_poll();
    keys = touch_keys();
    for (k = 0; k < NKEYS; k++) {
        uint32_t bit = 1u << k;
        if ((keys & bit) && !(ui.keys & bit)) {
            if (key_slot[k] != 0xFFu) {
                voice_press(key_slot[k], touch_vel(k), k);
                if (ui.cursor != key_slot[k])
                    ui_select(key_slot[k]);
            }
        } else if (!(keys & bit) && (ui.keys & bit)) {
            voice_release(k);
        }
    }
    for (k = 0; k < NB; k++) {
        uint32_t bit = 1u << k;
        if (!(btn & bit) || (ui.btn & bit))
            continue;
        if (k == B_OCTDN)
            page_step(-1);
        else if (k == B_OCTUP)
            page_step(1);
        else if (k == B_SEL || k == B_PLAY)      /* the cursor's sound */
            voice_press(ui.cursor, 127, KEY_NONE);
        else if (k == B_HOME) {
            voices_stop(-1);
            app_say("STOPPED", "");
        } else if (k == B_REC && FM1B_BLE)
            ui.rec_t = plat_ms();
    }
    if (FM1B_BLE && ui.rec_t && !(btn >> B_REC & 1u))
        ui.rec_t = 0;                            /* let go before a second: nothing */
    if (FM1B_BLE && ui.rec_t && plat_ms() - ui.rec_t >= 1000u) {
        ui.rec_t = 0;
        ble_toggle();
    }
    if ((e = plat_enc(EN_SELECT)) != 0) {        /* SELECT: the cursor, across the pages */
        int32_t c = ((int32_t)ui.cursor + e) % (int32_t)NSLOT;
        ui_select((uint32_t)(c < 0 ? c + (int32_t)NSLOT : c));
        say_cursor();
    }
    if ((e = plat_enc(EN_PRESET)) != 0 || (e = plat_enc(EN_ALGO)) != 0)
        page_step(e > 0 ? 1 : -1);
    for (k = EN_K1; k < NE; k++)                 /* (the small knobs: nothing yet) */
        (void)plat_enc((int)k);
    ui.keys = keys;
    ui.btn = btn;
    plat_lights(btn & (1u << B_PLAY | 1u << B_SEL), keys | keys_sounding(), 1u << B_OCTDN | 1u << B_OCTUP,
                keys_bound(), 2);
}

void app_input_only(void) { input(); }

/* the icon of slot s at (x, y): 4 bits a pixel, high nibble left, after its palette */
static void draw_icon(int32_t x, int32_t y, uint32_t s)
{
    const uint8_t *ic = plat_data(sec_off(dir.e[s].first));
    uint16_t pal16[16];
    uint32_t i, r, c;
    if (!ic)
        return;
    for (i = 0; i < 16u; i++)
        pal16[i] = (uint16_t)get16(ic + 2u * i);
    ic += ICON_PAL;
    for (r = 0; r < ICON_W; r++)
        for (c = 0; c < ICON_W; c += 2u) {
            uint8_t b = *ic++;
            cv_pset(x + (int32_t)c, y + (int32_t)r, pal16[b >> 4]);
            cv_pset(x + (int32_t)c + 1, y + (int32_t)r, pal16[b & 15u]);
        }
}

static void frame_rect(int32_t x, int32_t y, int32_t w, int32_t h, int32_t t, uint16_t c)   /* an outline t thick */
{
    cv_rect(x, y, w, t, c);
    cv_rect(x, y + h - t, w, t, c);
    cv_rect(x, y, t, h, c);
    cv_rect(x + w - t, y, t, h, c);
}

static void draw_row(uint32_t r)
{
    uint32_t c, i;
    cv_begin(240, CELL_H, C_BLACK);
    for (c = 0; c < 4u; c++) {
        uint32_t s = ui.page * PER_PAGE + r * 4u + c;
        int32_t x = (int32_t)c * CELL_W, ix = x + 6, iy = 3;
        int sel = s == ui.cursor, on = (ui.playing >> (s % PER_PAGE) & 1u) != 0;
        char n[20];
        if (dir.e[s].used) {
            draw_icon(ix, iy, s);
            slot_name(s, n);
            for (i = 0; n[i]; i++)
                ;
            while (i && text_w(&FONT_XS, n) > CELL_W - 2)   /* as much of the name as fits */
                n[--i] = 0;
            cv_text(x + (CELL_W - text_w(&FONT_XS, n)) / 2, 54, &FONT_XS, n, sel ? C_WHITE : on ? C_HI : C_GRAY);
        } else {
            cv_rect(ix, iy, (int32_t)ICON_W, (int32_t)ICON_W, C_LINE);
            uint_text(s + 1u, n);
            cv_text(ix + ((int32_t)ICON_W - text_w(&FONT_XS, n)) / 2, iy + 16, &FONT_XS, n, C_DIM);
        }
        if (on)
            frame_rect(ix - 3, iy - 3, (int32_t)ICON_W + 6, (int32_t)ICON_W + 6, 2, C_HI);
        if (sel)
            frame_rect(ix - 3, iy - 3, (int32_t)ICON_W + 6, (int32_t)ICON_W + 6, 1, C_WHITE);
    }
    cv_blit(0, BAR_H + (uint32_t)r * CELL_H);
}

static void draw_bar(void)
{
    char t[24];
    uint32_t now = plat_ms(), x;
    cv_begin(240, BAR_H, C_BLACK);
    cv_rect(0, BAR_H - 1, 240, 1, C_LINE);
    if (now < ui.msg_until) {
        int32_t e = cv_text(4, 2, &FONT_XS, ui.msg[0], C_WHITE);
        cv_text(e + 6, 2, &FONT_XS, ui.msg[1], C_HI);
    } else if (up.open) {                        /* a transfer: its progress */
        uint32_t pct = up.total ? up.next * 100u / up.total : 0u;   /* (a stream is < 400 KB: no overflow) */
        cv_text(4, 2, &FONT_XS, "RECEIVING", C_GRAY);
        cv_rect(80, 7, 120, 6, C_LINE);
        cv_rect(80, 7, (int32_t)(pct * 120u / 100u), 6, C_HI);
        uint_text(pct, t);
        text_cat(t, "%");
        cv_text(206, 2, &FONT_XS, t, C_HI);
    } else {
        int32_t e = cv_text(4, 2, &FONT_XS, APP_NAME, C_GRAY);
        if (FM1B_BLE)
            cv_text(e + 6, 2, &FONT_XS, "BLE", plat_ble_connected() ? C_HI : C_DIM);
        for (x = 0; x < NPAGE; x++)              /* the pages, as dots */
            cv_rect(118 + (int32_t)x * 10, 8, 6, 4, x == ui.page ? C_HI : C_DIM);
        uint_text(free_sectors(&dir) * SEC_PAY / 8000u, t);   /* seconds left at 16 kHz */
        text_cat(t, "s FREE");
        cv_text(236 - text_w(&FONT_XS, t), 2, &FONT_XS, t, C_GRAY);
    }
    cv_blit(0, 0);
}

void app_ui_init(void)
{
    touch_on(1);
    lcd_fill(0, 0, 240, 240, C_BLACK);
    ui.cursor = set.cursor;
    ui.page = (uint8_t)(set.cursor / PER_PAGE);
    ui.session = plat_usb_session();
    ui_dirty_all();
}

void app_frame(void)
{
    static uint32_t last_ble, last_free;
    uint32_t i, now = plat_ms(), pct;
    uint32_t playing = 0;
    input();
    speak();
    if (up.open && plat_usb_session() != up.session)   /* the computer went: its transfer with it */
        up_abort();
    for (i = 0; i < NVOICE; i++)
        if (voice[i].on)
            if (voice[i].slot / PER_PAGE == ui.page)
                playing |= 1u << (voice[i].slot % PER_PAGE);
    if (playing != ui.playing) {                 /* the rows whose cells started or stopped */
        uint32_t ch = playing ^ ui.playing;
        for (i = 0; i < 3u; i++)
            if (ch >> (i * 4u) & 0xFu)
                ui.dirty_row[i] = 1;
        ui.playing = playing;
    }
    pct = up.open ? up.next * 100u / (up.total ? up.total : 1u) + 1u : 0u;
    if (pct != ui.up_pct || (ui.msg_until && now >= ui.msg_until) ||
        (uint32_t)plat_ble_connected() != last_ble || free_sectors(&dir) != last_free) {
        ui.up_pct = pct;
        last_ble = (uint32_t)plat_ble_connected();
        last_free = free_sectors(&dir);
        if (ui.msg_until && now >= ui.msg_until)
            ui.msg_until = 0;
        ui.dirty_bar = 1;
    }
    if (ui.dirty_bar) {
        ui.dirty_bar = 0;
        draw_bar();
    }
    for (i = 0; i < 3u; i++)
        if (ui.dirty_row[i]) {
            ui.dirty_row[i] = 0;
            draw_row(i);
        }
    if (set.cursor != ui.cursor && !up.open) {   /* where the cursor was, kept (rarely: not each turn) */
        static uint32_t moved;
        if (!moved)
            moved = now;
        if (now - moved > 5000u) {
            moved = 0;
            set.cursor = ui.cursor;
            settings_save();
        }
    }
}

#ifdef PLAT_HOST
int app_expect(const char *what, int *got)
{
    uint32_t i, n = 0;
    if (!strcmp(what, "sounds"))
        *got = (int)used_slots();
    else if (!strcmp(what, "free"))
        *got = (int)free_sectors(&dir);
    else if (!strcmp(what, "voices")) {
        for (i = 0; i < NVOICE; i++)
            n += voice[i].on;
        *got = (int)n;
    } else if (!strcmp(what, "page"))
        *got = ui.page;
    else if (!strcmp(what, "cursor"))
        *got = ui.cursor;
    else if (!strcmp(what, "upload"))            /* 1: a transfer open */
        *got = up.open;
    else if (!strcmp(what, "status"))            /* the last reply's status */
        *got = px.status;
    else if (!strncmp(what, "key", 3) && what[3] >= '0' && what[3] <= '9')   /* keyN: the slot key N plays, -1 */
        *got = key_slot[atoi(what + 3) % NKEYS] == 0xFFu ? -1 : key_slot[atoi(what + 3) % NKEYS];
    else if (!strncmp(what, "used", 4))          /* usedN: slot N holds a sound */
        *got = dir.e[atoi(what + 4) % NSLOT].used;
    else
        return 0;
    return 1;
}
#endif
