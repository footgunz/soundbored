#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""soundbored's protocol (docs/protocol.md) from Python: frames, IMA ADPCM, icons.

    sbtool.py encode IN.wav OUT.adpcm     a PCM WAV (8/16/24/32-bit, any rate 4000..44100, stereo is mixed down)
                                          into the device's audio format; prints rate and frames
    sbtool.py decode IN.adpcm RATE OUT.wav  back into a 16-bit mono WAV, to listen to what the device will play
    sbtool.py icon IN.png OUT.icon        any image Pillow reads into the 1184-byte icon (cropped to a square,
                                          48x48, 16 colours)
    sbtool.py unicon IN.icon OUT.png      an icon back into a PNG
    sbtool.py selftest

    sbtool.py expand IN OUT      a host-simulator script with @-directives into a plain one (the frames as
                                 "sysex" lines); the directives:

  @upload name=BEEP (_ is a space) [freq=440] [ms=400] [rate=16000] [slot=255] [key=auto|none|N] [mode=0] [gain=256]
          [wave=sine|noise|square] [badcrc=1] [stop=N] [expect=0]
        BEGIN, DATA chunks, COMMIT, each followed by "expect status 0" (badcrc: the COMMIT's CRC wrong and
        expect=7 there; stop=N: only the first N chunks, no COMMIT)
  @icon slot=N [seed=1] [expect=0]       a new icon for slot N (BEGIN kind 1)
  @cmd NAME ARGS... [expect=S]           one request: HELLO, GET_ENTRY s, GET_ICON s off len, ABORT,
                                         SET_META s key mode gain NAME, DELETE s, SWAP a b, PLAY s, FORMAT
  @again                                 the last frame sent again, unchanged (a retry)
  @bad                                   a frame with a wrong checksum (expect status 1)
"""
import math
import random
import struct
import sys
import zlib

ICON_W = 48
ICON_BYTES = 32 + ICON_W * ICON_W // 2
CHUNK = 512

CMDS = {"HELLO": 0x01, "GET_ENTRY": 0x02, "GET_ICON": 0x03, "BEGIN": 0x10, "DATA": 0x11, "COMMIT": 0x12,
        "ABORT": 0x13, "SET_META": 0x20, "DELETE": 0x21, "SWAP": 0x22, "PLAY": 0x23, "FORMAT": 0x24}

STEP = [7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97,
        107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796,
        876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428,
        4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350,
        22385, 24623, 27086, 29794, 32767]
IDX = [-1, -1, -1, -1, 2, 4, 6, 8]


def pack7(b: bytes) -> bytes:
    out = bytearray()
    for i in range(0, len(b), 7):
        g = b[i:i + 7]
        out.append(sum(((x >> 7) & 1) << j for j, x in enumerate(g)))
        out += bytes(x & 0x7F for x in g)
    return bytes(out)


def frame(cmd: int, seq: int, body: bytes = b"", bad: bool = False) -> bytes:
    inner = bytes([cmd & 0x7F, seq & 0x7F]) + pack7(body)
    chk = (sum(inner) + (1 if bad else 0)) & 0x7F
    return b"\xF0\x7D\x53\x42" + inner + bytes([chk, 0xF7])


def ima_step(pred, idx, nib):
    step = STEP[idx]
    diff = step >> 3
    if nib & 4:
        diff += step
    if nib & 2:
        diff += step >> 1
    if nib & 1:
        diff += step >> 2
    pred = pred - diff if nib & 8 else pred + diff
    return max(-32768, min(32767, pred)), max(0, min(88, idx + IDX[nib & 7]))


def ima_encode(samples) -> bytes:
    """mono int16 samples -> IMA ADPCM, predictor 0 / index 0 at the start, first sample in the low nibble"""
    pred, idx, nibs = 0, 0, []
    for s in samples:
        step = STEP[idx]
        d = s - pred
        nib = 8 if d < 0 else 0
        d = abs(d)
        if d >= step:
            nib |= 4
            d -= step
        if d >= step >> 1:
            nib |= 2
            d -= step >> 1
        if d >= step >> 2:
            nib |= 1
        pred, idx = ima_step(pred, idx, nib)
        nibs.append(nib)
    if len(nibs) & 1:
        nibs.append(0)
    return bytes(nibs[i] | nibs[i + 1] << 4 for i in range(0, len(nibs), 2))


def ima_decode(data: bytes, frames: int):
    pred, idx, out = 0, 0, []
    for b in data:
        for nib in (b & 15, b >> 4):
            if len(out) == frames:
                return out
            pred, idx = ima_step(pred, idx, nib)
            out.append(pred)
    return out


def rgb565(r, g, b):
    return (r >> 3) << 11 | (g >> 2) << 5 | b >> 3


def test_icon(seed: int = 1) -> bytes:
    """a 16-colour test icon: concentric squares, a palette from the seed"""
    rnd = random.Random(seed)
    pal = [rgb565(rnd.randrange(256), rnd.randrange(256), rnd.randrange(256)) for _ in range(16)]
    pal[0] = 0
    px = []
    for y in range(ICON_W):
        for x in range(ICON_W):
            ring = min(x, y, ICON_W - 1 - x, ICON_W - 1 - y) // 3
            px.append((ring + seed) % 16 if ring else 0)
    body = b"".join(struct.pack("<H", c) for c in pal)
    body += bytes(px[i] << 4 | px[i + 1] for i in range(0, len(px), 2))
    assert len(body) == ICON_BYTES
    return body


def tone(wave: str, freq: float, ms: int, rate: int):
    n = rate * ms // 1000
    rnd = random.Random(7)
    out = []
    for i in range(n):
        env = min(1.0, i / (rate * 0.005), (n - i) / (rate * 0.02))   # 5 ms in, 20 ms out
        if wave == "noise":
            v = rnd.uniform(-1, 1)
        elif wave == "square":
            v = 1.0 if math.sin(2 * math.pi * freq * i / rate) >= 0 else -1.0
        else:
            v = math.sin(2 * math.pi * freq * i / rate)
        out.append(int(v * env * 0.8 * 32767))
    return out


def name16(s: str) -> bytes:
    return s.encode("ascii")[:16].ljust(16, b"\0")


def keyarg(v: str) -> int:
    return {"auto": 0xFE, "none": 0xFF}.get(v, None) if v in ("auto", "none") else int(v)


class Expander:
    def __init__(self):
        self.seq = 0
        self.last = None
        self.out = []

    def send(self, cmd: str, body: bytes = b"", expect=0, bad=False):
        self.seq = (self.seq + 1) & 0x7F
        f = frame(CMDS[cmd], self.seq, body, bad)
        self.last = f
        self.out.append("sysex " + f.hex(" ").upper())
        if expect is not None:
            self.out.append(f"expect status {expect}")

    def stream(self, kind, slot, total_stream, meta, expect, badcrc=False, stop=None):
        rate, frames, key, mode, gain, name = meta
        body = struct.pack("<BBIHIBBH", kind, slot, len(total_stream), rate, frames, key, mode, gain) + name16(name)
        self.send("BEGIN", body, 0 if expect in (0, 7) else expect)
        if expect not in (0, 7):
            return
        chunks = range(0, len(total_stream), CHUNK)
        for n, off in enumerate(chunks):
            if stop is not None and n >= stop:
                return
            self.send("DATA", struct.pack("<I", off) + total_stream[off:off + CHUNK], 0)
        crc = zlib.crc32(total_stream) ^ (1 if badcrc else 0)
        self.send("COMMIT", struct.pack("<I", crc), 7 if badcrc else expect)

    def directive(self, line: str):
        parts = line.split()
        name, args = parts[0], parts[1:]
        kv = dict(a.split("=", 1) for a in args if "=" in a)
        pos = [a for a in args if "=" not in a]
        expect = int(kv["expect"]) if "expect" in kv else 0
        if name == "@upload":
            rate = int(kv.get("rate", 16000))
            samples = tone(kv.get("wave", "sine"), float(kv.get("freq", 440)), int(kv.get("ms", 400)), rate)
            audio = ima_encode(samples)
            icon = test_icon(int(kv.get("seed", 1)))
            meta = (rate, len(samples), keyarg(kv.get("key", "auto")), int(kv.get("mode", 0)),
                    int(kv.get("gain", 256)), kv.get("name", "SOUND").replace("_", " "))
            self.stream(0, int(kv.get("slot", 255)), icon + audio, meta, expect, kv.get("badcrc") == "1",
                        int(kv["stop"]) if "stop" in kv else None)
        elif name == "@icon":
            self.stream(1, int(kv["slot"]), test_icon(int(kv.get("seed", 2))), (16000, 0, 0xFF, 0, 256, ""),
                        expect)
        elif name == "@cmd":
            cmd, a = pos[0], pos[1:]
            if cmd == "SET_META":
                body = struct.pack("<BBBH", int(a[0]), keyarg(a[1]), int(a[2]), int(a[3])) + name16(a[4].replace("_", " "))
            elif cmd == "GET_ICON":
                body = struct.pack("<BHH", int(a[0]), int(a[1]), int(a[2]))
            elif cmd == "FORMAT":
                body = b"WIPE"
            else:
                body = bytes(int(x, 0) for x in a)
            self.send(cmd, body, expect)
        elif name == "@again":
            self.out.append("sysex " + self.last.hex(" ").upper())
            self.out.append(f"expect status {expect}")
        elif name == "@bad":
            self.send("HELLO", b"", 1, bad=True)
        else:
            raise SystemExit(f"unknown directive {name}")


def expand(src: str, dst: str):
    ex = Expander()
    with open(src) as f:
        for line in f:
            line = line.rstrip("\n")
            if line.lstrip().startswith("@"):
                ex.directive(line.strip())
            else:
                ex.out.append(line)
    with open(dst, "w") as f:
        f.write("\n".join(ex.out) + "\n")


def read_wav(path: str):
    import wave
    with wave.open(path, "rb") as w:
        ch, width, rate, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
        raw = w.readframes(n)
    if not 4000 <= rate <= 44100:
        raise SystemExit(f"{path}: {rate} Hz; the device takes 4000..44100 (resample it first)")
    out = []
    step = width * ch
    for i in range(0, n * step, step):
        acc = 0
        for c in range(ch):
            b = raw[i + c * width:i + (c + 1) * width]
            v = b[0] - 128 if width == 1 else int.from_bytes(b, "little", signed=True)
            acc += v << 8 if width == 1 else v >> 8 * (width - 2)
        out.append(max(-32768, min(32767, acc // ch)))
    return rate, out


def write_wav(path: str, rate: int, samples):
    import wave
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"".join(struct.pack("<h", s) for s in samples))


def image_to_icon(path: str) -> bytes:
    from PIL import Image, ImageOps
    img = Image.open(path)
    img = img.convert("RGBA")
    bg = Image.new("RGBA", img.size, (0, 0, 0, 255))
    img = Image.alpha_composite(bg, img).convert("RGB")
    img = ImageOps.fit(img, (ICON_W, ICON_W), Image.LANCZOS)
    q = img.quantize(16, method=Image.Quantize.MEDIANCUT)
    pal = (q.getpalette() or [])[:48]
    pal += [0] * (48 - len(pal))
    px = q.tobytes()  # mode P: one palette index a pixel
    body = b"".join(struct.pack("<H", rgb565(*pal[i:i + 3])) for i in range(0, 48, 3))
    body += bytes(px[i] << 4 | px[i + 1] for i in range(0, len(px), 2))
    assert len(body) == ICON_BYTES
    return body


def icon_to_image(data: bytes):
    from PIL import Image
    if len(data) != ICON_BYTES:
        raise SystemExit(f"an icon is {ICON_BYTES} bytes, not {len(data)}")
    pal = []
    for i in range(16):
        c = struct.unpack_from("<H", data, 2 * i)[0]
        r, g, b = c >> 11, c >> 5 & 63, c & 31
        pal.append((r << 3 | r >> 2, g << 2 | g >> 4, b << 3 | b >> 2))
    img = Image.new("RGB", (ICON_W, ICON_W))
    img.putdata([pal[b >> 4 if k == 0 else b & 15] for b in data[32:] for k in (0, 1)])
    return img


def selftest():
    assert pack7(bytes([0x80, 0x01])) == bytes([0x01, 0x00, 0x01])
    assert zlib.crc32(b"123456789") == 0xCBF43926
    s = tone("sine", 440, 200, 16000)
    d = ima_decode(ima_encode(s), len(s))
    err = sum((a - b) ** 2 for a, b in zip(s, d))
    sig = sum(a * a for a in s)
    snr = 10 * math.log10(sig / max(err, 1))
    assert snr > 20, snr
    print(f"selftest ok (ADPCM SNR {snr:.1f} dB)")


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "expand":
        expand(sys.argv[2], sys.argv[3])
    elif len(sys.argv) == 4 and sys.argv[1] == "encode":
        rate, pcm = read_wav(sys.argv[2])
        with open(sys.argv[3], "wb") as f:
            f.write(ima_encode(pcm))
        print(f"rate={rate} frames={len(pcm)} audio_bytes={(len(pcm) + 1) // 2} ({len(pcm) / rate:.2f} s)")
    elif len(sys.argv) == 5 and sys.argv[1] == "decode":
        data = open(sys.argv[2], "rb").read()
        write_wav(sys.argv[4], int(sys.argv[3]), ima_decode(data, len(data) * 2))
    elif len(sys.argv) == 4 and sys.argv[1] == "icon":
        with open(sys.argv[3], "wb") as f:
            f.write(image_to_icon(sys.argv[2]))
    elif len(sys.argv) == 4 and sys.argv[1] == "unicon":
        icon_to_image(open(sys.argv[2], "rb").read()).save(sys.argv[3])
    elif len(sys.argv) == 2 and sys.argv[1] == "selftest":
        selftest()
    else:
        print(__doc__)
        sys.exit(2)
