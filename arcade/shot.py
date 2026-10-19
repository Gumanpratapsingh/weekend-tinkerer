#!/usr/bin/env python3
"""Screenshot of the arcade display (:1) as PNG, for checking from SSH: shot.py out.png [scale]"""
import struct, sys, zlib
from Xlib import X, display
d = display.Display(':1'); root = d.screen().root
g = root.get_geometry(); w, h = g.width, g.height
raw = root.get_image(0, 0, w, h, X.ZPixmap, 0xffffffff).data
s = int(sys.argv[2]) if len(sys.argv) > 2 else 2
rows = []
for y in range(0, h, s):
    line = bytearray(b'\0')
    base = y * w * 4
    for x in range(0, w, s):
        i = base + x * 4
        line += bytes((raw[i + 2], raw[i + 1], raw[i]))
    rows.append(bytes(line))
def chunk(t, b): return struct.pack('>I', len(b)) + t + b + struct.pack('>I', zlib.crc32(t + b) & 0xffffffff)
png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w // s + (w % s > 0), h // s + (h % s > 0), 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(b''.join(rows), 6)) + chunk(b'IEND', b'')
open(sys.argv[1], 'wb').write(png)
