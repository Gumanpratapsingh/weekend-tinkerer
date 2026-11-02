#!/usr/bin/env python3
"""Adds a WiFi network from a pendrive, because this laptop has no screen.

Plug in a USB drive holding wifi.txt (line 1 the WiFi name, line 2 the password).
The network joins the saved ones, the password file is deleted, and the outcome
(including the new IP) is written to wifi-result.txt on the drive.
Started by udev for every USB filesystem. A drive without wifi.txt is left alone.
"""
import glob, os, shutil, subprocess, sys, tempfile, time
import yaml

WAIT_SECONDS = 90


def run(*cmd):
    return subprocess.run(cmd, capture_output=True, text=True)


def netplan_file():
    for path in sorted(glob.glob("/etc/netplan/*.yaml")):
        with open(path) as f:
            conf = yaml.safe_load(f) or {}
        if conf.get("network", {}).get("wifis"):
            return path, conf
    raise SystemExit("no netplan file with a wifis section")


def read_request(path):
    with open(path, encoding="utf-8-sig") as f:
        lines = f.read().splitlines()
    name = lines[0] if lines else ""
    password = lines[1] if len(lines) > 1 else ""
    if not name or len(name.encode()) > 32:
        raise ValueError("line 1 must be the WiFi name (1-32 bytes)")
    if password and not 8 <= len(password) <= 63:
        raise ValueError("line 2 must be the password (8-63 characters), or empty for an open network")
    return name, password


def save_network(name, password, apply_later=False):
    path, conf = netplan_file()
    iface, wifi = next(iter(conf["network"]["wifis"].items()))
    wifi.setdefault("access-points", {})[name] = {"password": password} if password else {}
    shutil.copy2(path, path + ".bak")
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), suffix=".tmp")
    with os.fdopen(fd, "w") as f:
        yaml.safe_dump(conf, f, allow_unicode=True, sort_keys=False)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)
    check = run("netplan", "generate")
    if check.returncode:
        shutil.copy2(path + ".bak", path)
        raise ValueError("netplan rejected it: " + check.stderr.strip())
    if apply_later:
        # Over SSH: applying can drop the very connection we are on, so let it outlive the session.
        run("systemd-run", "--on-active=3", "netplan", "apply")
    else:
        run("netplan", "apply")
    return iface, list(wifi["access-points"])


def link_state(iface):
    out = run("iw", "dev", iface, "link").stdout
    ssid = next((l.split("SSID:", 1)[1].strip() for l in out.splitlines() if "SSID:" in l), "")
    addr = run("ip", "-4", "-br", "addr", "show", iface).stdout.split()
    return ssid, addr[2].split("/")[0] if len(addr) > 2 else ""


def wait_for(iface, name):
    ssid, ip = "", ""
    for _ in range(WAIT_SECONDS // 3):
        time.sleep(3)
        ssid, ip = link_state(iface)
        if ssid == name and ip:
            break
    return ssid, ip


def handle(mnt):
    request = os.path.join(mnt, "wifi.txt")
    result = []
    try:
        name, password = read_request(request)
        iface, saved = save_network(name, password)
        os.remove(request)
        os.sync()
        ssid, ip = wait_for(iface, name)
        if ssid == name and ip:
            result.append(f"OK: connected to {name}")
        elif ssid:
            result.append(f"SAVED: {name} added, but still connected to {ssid}. "
                          "Turn that one off and it should move over.")
        else:
            result.append(f"NOT CONNECTED: {name} saved, but it did not connect in {WAIT_SECONDS}s. "
                          "Check the password and the name, then try again.")
        result += [f"IP: {ip or 'none'}", f"Current WiFi: {ssid or 'none'}", "Saved WiFi: " + ", ".join(saved)]
    except Exception as e:
        result.append(f"FAILED: {e}")
    result.append("Time: " + time.strftime("%F %T %z"))
    with open(os.path.join(mnt, "wifi-result.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(result) + "\n")
    print(result[0])


def add_over_ssh():
    """--add: same as wifi.txt, but the two lines arrive on stdin (see add-wifi.sh)."""
    with tempfile.NamedTemporaryFile("w+", encoding="utf-8") as f:
        f.write(sys.stdin.read())
        f.flush()
        name, password = read_request(f.name)
    _, saved = save_network(name, password, apply_later=True)
    print("Saved WiFi: " + ", ".join(saved))


def main():
    if sys.argv[1] == "--add":
        return add_over_ssh()
    dev = sys.argv[1]
    mnt = tempfile.mkdtemp(prefix="wifi-drop-", dir="/run")
    try:
        if run("mount", "-o", "ro,nosuid,nodev,noexec", dev, mnt).returncode:
            return
        if os.path.exists(os.path.join(mnt, "wifi.txt")) and \
                not run("mount", "-o", "remount,rw", mnt).returncode:
            handle(mnt)
    finally:
        os.sync()
        run("umount", mnt)
        os.rmdir(mnt)


if __name__ == "__main__":
    main()
