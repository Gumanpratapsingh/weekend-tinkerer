# Laptop server

A Dell G3 with a dead screen and HDMI, turned into a headless Ubuntu server that runs the job agents
(`job-agent/linux/`), with the S20 as a synced standby.

- `installer/`: a hands-free Ubuntu Server 24.04 install from a USB stick, with no screen and nothing typed.
  `make_autoinstall.py <password> <ssh-key.pub> autoinstall.yaml [wifi-name wifi-password]` writes the answers
  (user, SSH key only, WiFi, lid/sleep/battery settings). `build.py <iso> autoinstall.yaml` puts them into a copy
  of the official ISO in place: no xorriso needed. `patch_iso.py` edits ISO9660 files of the same size, and
  `grub.cfg` adds `autoinstall subiquity.autoinstallpath=…` plus a beep. Signs you can see without a screen: the
  beep (USB booted), Caps Lock blinking (installer running), `REPORT_URL=http://<mac-ip>:8765/` progress shown by
  `monitor.py` once WiFi is up, and power-off when the install is done.
  The generated autoinstall.yaml holds password hashes and WiFi passwords: never commit it.
- `server.mjs` + `laptop-api.service`: health API and heat guard on 127.0.0.1:8095 (hub `/laptop`). `deploy.sh` installs it.
- `find-phone`: prints the S20's current IP (it moves on WiFi reconnects), verified by its SSH host key.
- `watch-agents.sh [minutes]`: what both job agents do, every 2 minutes (from the Mac).

Turbo Boost is off (`/etc/tmpfiles.d/no-turbo.conf`). BIOS settings are changed from Linux with
`smbios-token-ctl`: AC Power Recovery is on, and the battery is set to "Primarily AC Use".
