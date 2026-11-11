#!/usr/bin/env python3
"""Generate the Browser Bridge icon set (pure stdlib: zlib + struct)."""

import os
import struct
import zlib

SIZES = (16, 32, 48, 128)
SS = 4  # supersampling factor
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "extension", "icons")

TOP = (139, 92, 246)   # violet-500
BOT = (76, 29, 149)    # violet-900


def rounded_alpha(x, y, size, radius):
    """Coverage of a rounded square at an (unscaled) pixel centre."""
    cx = min(max(x, radius), size - radius)
    cy = min(max(y, radius), size - radius)
    dx, dy = x - cx, y - cy
    return 1.0 if dx * dx + dy * dy <= radius * radius else 0.0


def render(size):
    n = size * SS
    radius = n * 0.22
    ring_r = n * 0.30
    ring_w = max(1.0, n * 0.075)
    dot_r = n * 0.085
    ccx = ccy = n / 2.0
    dot_x = n * 0.665
    dot_y = n * 0.665
    acc = [[[0.0, 0.0, 0.0, 0.0] for _ in range(n)] for _ in range(n)]

    for py in range(n):
        y = py + 0.5
        for px in range(n):
            x = px + 0.5
            a = rounded_alpha(x, y, n, radius)
            if a == 0.0:
                continue
            t = (x / n * 0.35) + (y / n * 0.65)
            r = TOP[0] + (BOT[0] - TOP[0]) * t
            g = TOP[1] + (BOT[1] - TOP[1]) * t
            b = TOP[2] + (BOT[2] - TOP[2]) * t

            # white ring
            d = ((x - ccx) ** 2 + (y - ccy) ** 2) ** 0.5
            if abs(d - ring_r) <= ring_w / 2:
                r, g, b = 255.0, 255.0, 255.0
            # white dot
            if ((x - dot_x) ** 2 + (y - dot_y) ** 2) ** 0.5 <= dot_r:
                r, g, b = 255.0, 255.0, 255.0

            acc[py][px] = [r, g, b, 255.0 * a]

    # box-downsample
    rows = []
    for oy in range(size):
        row = bytearray()
        for ox in range(size):
            sr = sg = sb = sa = 0.0
            for dy in range(SS):
                for dx in range(SS):
                    p = acc[oy * SS + dy][ox * SS + dx]
                    sr += p[0] * p[3]
                    sg += p[1] * p[3]
                    sb += p[2] * p[3]
                    sa += p[3]
            if sa > 0:
                row += bytes((int(sr / sa), int(sg / sa), int(sb / sa), int(sa / (SS * SS))))
            else:
                row += bytes((0, 0, 0, 0))
        rows.append(bytes(row))
    return rows


def png(path, size, rows):
    raw = b"".join(b"\x00" + r for r in rows)

    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", ihdr))
        f.write(chunk(b"IDAT", zlib.compress(raw, 9)))
        f.write(chunk(b"IEND", b""))


def main():
    os.makedirs(OUT, exist_ok=True)
    for size in SIZES:
        png(os.path.join(OUT, f"icon{size}.png"), size, render(size))
        print(f"wrote icon{size}.png")


if __name__ == "__main__":
    main()
