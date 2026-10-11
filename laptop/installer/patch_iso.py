#!/usr/bin/env python3
"""Patch files inside an ISO9660 image in place (same size), no xorriso needed.

usage:
  patch_iso.py <iso> ls <dir>                 list a directory
  patch_iso.py <iso> cat <path>               print a file
  patch_iso.py <iso> put <path> <localfile>   overwrite a file's bytes (padded to
                                              its size with the given pad char)
"""
import hashlib
import struct
import sys

SECTOR = 2048


def records(f, lba, size):
    f.seek(lba * SECTOR)
    data = f.read(size)
    i = 0
    while i < len(data):
        n = data[i]
        if n == 0:  # records never cross a sector boundary
            i = (i // SECTOR + 1) * SECTOR
            continue
        rec = data[i:i + n]
        ext = struct.unpack("<I", rec[2:6])[0]
        sz = struct.unpack("<I", rec[10:14])[0]
        flags = rec[25]
        nl = rec[32]
        name = rec[33:33 + nl]
        # Rock Ridge NM entry gives the real (lowercase) name
        su = rec[33 + nl + (0 if nl % 2 else 1):]
        j = 0
        while j + 4 <= len(su):
            sig, ln = su[j:j + 2], su[j + 2]
            if ln == 0:
                break
            if sig == b"NM":
                name = su[j + 5:j + ln]
                break
            j += ln
        name = name.decode("latin-1").split(";")[0]
        if name not in ("\x00", "\x01"):
            yield name, ext, sz, bool(flags & 2)
        i += n


def lookup(f, path):
    f.seek(16 * SECTOR)
    pvd = f.read(SECTOR)
    assert pvd[1:6] == b"CD001"
    root = pvd[156:190]
    lba, size = struct.unpack("<I", root[2:6])[0], struct.unpack("<I", root[10:14])[0]
    for part in [p for p in path.strip("/").split("/") if p]:
        for name, ext, sz, isdir in records(f, lba, size):
            if name == part:
                lba, size = ext, sz
                break
        else:
            raise SystemExit("not found: " + path)
    return lba, size


def main():
    iso, cmd = sys.argv[1], sys.argv[2]
    mode = "r+b" if cmd == "put" else "rb"
    with open(iso, mode) as f:
        lba, size = lookup(f, sys.argv[3])
        if cmd == "ls":
            for name, ext, sz, isdir in records(f, lba, size):
                print("%s%-40s %10d" % ("d " if isdir else "  ", name, sz))
        elif cmd == "cat":
            f.seek(lba * SECTOR)
            sys.stdout.buffer.write(f.read(size))
        elif cmd == "put":
            new = open(sys.argv[4], "rb").read()
            if len(new) > size:
                raise SystemExit("too big: %d > %d" % (len(new), size))
            new += b"\n" * (size - len(new))
            f.seek(lba * SECTOR)
            f.write(new)
            print("wrote %s (%d bytes) md5 %s" % (sys.argv[3], size, hashlib.md5(new).hexdigest()))


if __name__ == "__main__":
    main()
