#!/usr/bin/env python3
"""Generate autoinstall.yaml for the headless Dell G3 server.

usage: make_autoinstall.py <password> <ssh-pubkey-file> <out.yaml> [wifi-name wifi-password]
"""
import base64
import hashlib
import json
import os
import sys

ITOA64 = "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"


def sha512_crypt(password, salt, rounds=5000):
    """SHA-512 crypt ($6$), since macOS crypt() can't do it."""
    pw, salt = password.encode(), salt.encode()[:16]
    b = hashlib.sha512(pw + salt + pw).digest()
    a = hashlib.sha512(pw + salt)
    n = len(pw)
    a.update(b * (n // 64) + b[: n % 64])
    while n:
        a.update(b if n & 1 else pw)
        n >>= 1
    c = a.digest()
    p = (hashlib.sha512(pw * len(pw)).digest() * (len(pw) // 64 + 1))[: len(pw)]
    s = (hashlib.sha512(salt * (16 + c[0])).digest() * (len(salt) // 64 + 1))[: len(salt)]
    for i in range(rounds):
        h = hashlib.sha512(p if i & 1 else c)
        if i % 3:
            h.update(s)
        if i % 7:
            h.update(p)
        h.update(c if i & 1 else p)
        c = h.digest()
    order = [(0, 21, 42), (22, 43, 1), (44, 2, 23), (3, 24, 45), (25, 46, 4),
             (47, 5, 26), (6, 27, 48), (28, 49, 7), (50, 8, 29), (9, 30, 51),
             (31, 52, 10), (53, 11, 32), (12, 33, 54), (34, 55, 13), (56, 14, 35),
             (15, 36, 57), (37, 58, 16), (59, 17, 38), (18, 39, 60), (40, 61, 19),
             (62, 20, 41)]
    out = ""

    def enc(w, k):
        r = ""
        for _ in range(k):
            r += ITOA64[w & 0x3F]
            w >>= 6
        return r

    for x, y, z in order:
        out += enc((c[x] << 16) | (c[y] << 8) | c[z], 4)
    out += enc(c[63], 2)
    return "$6$%s$%s" % (salt.decode(), out)


assert sha512_crypt("Hello world!", "saltstring") == (
    "$6$saltstring$svn8UoSVapNtMuq1ukKS4tPQd8iKwSMHWjl/O817G3uBnIFNjnQJuesI68u4OTLiBFdcbYEdFCoEOfaS35inz1")

# Files written into the installed system.
FILES = {
    # Closing the lid must not sleep or power off the server.
    "/etc/systemd/logind.conf.d/10-server.conf": """[Login]
HandleLidSwitch=ignore
HandleLidSwitchExternalPower=ignore
HandleLidSwitchDocked=ignore
HandleSuspendKey=ignore
HandleHibernateKey=ignore
IdleAction=ignore
""",
    # Power off cleanly during a long power cut instead of dying at 0%.
    "/usr/local/bin/battery-guard": """#!/bin/sh
for b in /sys/class/power_supply/BAT*; do
  [ -r "$b/capacity" ] || continue
  if [ "$(cat "$b/status")" = "Discharging" ] && [ "$(cat "$b/capacity")" -le 10 ]; then
    logger -t battery-guard "on battery at $(cat "$b/capacity")%, powering off"
    systemctl poweroff
  fi
done
""",
    "/etc/systemd/system/battery-guard.service": """[Unit]
Description=Power off cleanly when the battery runs low

[Service]
Type=oneshot
ExecStart=/usr/local/bin/battery-guard
""",
    "/etc/systemd/system/battery-guard.timer": """[Unit]
Description=Check battery every minute

[Timer]
OnBootSec=2min
OnUnitActiveSec=1min

[Install]
WantedBy=timers.target
""",
    # Never sit at the GRUB menu waiting for a key (nobody can see it).
    "/etc/default/grub.d/99-headless.cfg": """GRUB_TIMEOUT=2
GRUB_TIMEOUT_STYLE=hidden
GRUB_RECORDFAIL_TIMEOUT=2
""",
}


def main():
    password, keyfile, out = sys.argv[1:4]
    wifi = sys.argv[4:6]
    pubkey = open(os.path.expanduser(keyfile)).read().strip()
    salt = base64.b64encode(os.urandom(12), b"./").decode()[:16]

    late = []
    for path, body in FILES.items():
        b64 = base64.b64encode(body.encode()).decode()
        late.append("mkdir -p /target%s && echo %s | base64 -d > /target%s"
                    % (os.path.dirname(path), b64, path))
    late += [
        "chmod 755 /target/usr/local/bin/battery-guard",
        "curtin in-target -- systemctl enable battery-guard.timer",
        "curtin in-target -- systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target",
        "curtin in-target -- update-grub",
        # Best effort: lets the Mac find it as laptop-server.local (needs internet).
        "curtin in-target -- sh -c 'apt-get update && apt-get install -y avahi-daemon' || true",
    ]

    q = json.dumps  # JSON strings are valid YAML scalars
    wifis = ""
    if wifi:
        wifis = f"""    wifis:
      WIFI_IFACE:
        dhcp4: true
        optional: true
        access-points:
          {q(wifi[0])}:
            password: {q(wifi[1])}
"""
    # Optional: stream install progress to the Mac, and let the Mac SSH into the installer.
    report = ""
    url = os.environ.get("REPORT_URL")
    if url:
        key_cmd = ("mkdir -p /home/installer/.ssh && echo '%s' >> /home/installer/.ssh/authorized_keys"
                   " && chown -R installer: /home/installer/.ssh" % pubkey)
        # Blink Caps Lock (and keyboard backlight) while the installer runs: a sign you can see.
        blink = """while :; do
  for v in 1 0; do
    for l in /sys/class/leds/*capslock*/brightness /sys/class/leds/*kbd_backlight*/brightness; do
      [ -w "$l" ] && echo $v > "$l"
    done
    sleep 0.5
  done
done
"""
        b64 = base64.b64encode(blink.encode()).decode()
        blink_cmd = ("echo %s | base64 -d > /tmp/blink.sh && "
                     "(setsid sh /tmp/blink.sh </dev/null >/dev/null 2>&1 &)" % b64)
        # netplan can't match wifi by pattern: put the real WiFi card name in
        # /autoinstall.yaml, which the installer re-reads after early-commands.
        wifi_sh = """for i in $(seq 1 60); do
  w=$(ls /sys/class/net | grep '^wl' | head -n1)
  [ -n "$w" ] && break
  sleep 1
done
sed -i "s/WIFI_IFACE/${w:-wlan0}/" /autoinstall.yaml
"""
        wifi_cmd = "echo %s | base64 -d > /tmp/wifi.sh && sh /tmp/wifi.sh" % (
            base64.b64encode(wifi_sh.encode()).decode())
        report = f"""  reporting:
    mac:
      type: webhook
      endpoint: {q(url)}
  early-commands:
    - {q("sh -c '%s' || true" % wifi_cmd)}
    - {q('sh -c "%s" || true' % key_cmd)}
    - {q("sh -c '%s' || true" % blink_cmd)}
"""
    y = f"""autoinstall:
  version: 1
  interactive-sections: []
{report}  locale: en_US.UTF-8
  keyboard:
    layout: us
  timezone: Asia/Kolkata
  refresh-installer:
    update: false
  network:
    version: 2
    ethernets:
      lan:
        match:
          name: "e*"
        dhcp4: true
        optional: true
        wakeonlan: true
{wifis}  storage:
    layout:
      name: lvm
      sizing-policy: all
      match:
        size: smallest
  identity:
    hostname: laptop-server
    realname: GP Singh
    username: gpsingh
    password: {q(sha512_crypt(password, salt))}
  ssh:
    install-server: true
    allow-pw: false
    authorized-keys:
      - {q(pubkey)}
  late-commands:
"""
    # Extras must never abort the install: a failure here is fixed later over SSH.
    y += "".join("    - %s\n" % q(c if c.endswith("|| true") else "(%s) || true" % c) for c in late)
    y += "  shutdown: poweroff\n"
    open(out, "w").write(y)


if __name__ == "__main__":
    main()
