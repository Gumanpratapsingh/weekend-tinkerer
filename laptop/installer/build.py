#!/usr/bin/env python3
"""Put autoinstall.yaml into the patched ISO and fix md5sum.txt to match.

usage: build.py <iso> <autoinstall.yaml>
"""
import hashlib
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PAYLOAD = "/boot/memtest86+x64.bin"  # unused on UEFI; holds our autoinstall.yaml


def iso(*args):
    return subprocess.run([sys.executable, os.path.join(HERE, "patch_iso.py")] + list(args),
                          check=True, capture_output=True).stdout


def main():
    image, yaml_file = sys.argv[1:3]
    iso(image, "put", PAYLOAD, yaml_file)

    md5s = iso(image, "cat", "/md5sum.txt").decode()
    for path in ("/boot/grub/grub.cfg", PAYLOAD):
        digest = hashlib.md5(iso(image, "cat", path)).hexdigest()
        lines = md5s.split("\n")
        for i, line in enumerate(lines):
            if line.endswith("  ." + path):
                lines[i] = digest + line[32:]
        md5s = "\n".join(lines)
    tmp = os.path.join(HERE, "md5sum.txt.new")
    open(tmp, "w").write(md5s)
    iso(image, "put", "/md5sum.txt", tmp)
    os.remove(tmp)

    # Read back and check it parses as the installer will see it.
    import yaml
    cfg = yaml.safe_load(iso(image, "cat", PAYLOAD))["autoinstall"]
    print("ok:", cfg["identity"]["username"], "@", cfg["identity"]["hostname"],
          "| wifi:", [ap for w in cfg["network"].get("wifis", {}).values() for ap in w["access-points"]])


if __name__ == "__main__":
    main()
