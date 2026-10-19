# Arcade

A fighting game on the Dell laptop (no screen, no HDMI), streamed to the monitor by the S20, with two phones as the
controllers.

```
Dell: Ikemen GO on a virtual display :1, drawn by the Intel GPU (VirtualGL EGL)
  └─ Sunshine (Intel VA-API H.264/HEVC) ──Wi-Fi──▶ Moonlight on the S20 (DeX) ──HDMI──▶ monitor
Phones: Cupboard → Settings → Arcade & monitor → 🎮 Open gamepad
  └─ http://<laptop>:8097/pad?t=<signed link> ──WebSocket──▶ pad.py ──XTEST keys──▶ the game
```

- `pad.py`: the gamepad bridge (0.0.0.0:8097, home Wi-Fi only). It serves `pad.html` and turns each player's
  buttons into that player's keys from Ikemen's defaults. Links are HMAC-signed by Cupboard with `~/arcade/secret`
  and expire after 6 hours. The owner is Player 1; anyone else is Player 2.
- `run-ikemen.sh`: what Sunshine starts. Without VirtualGL, Mesa draws in software at about 6.5 cores; with it, the
  game uses about 1 core.
- `systemd/`: arcade-display (Xvfb :1 1920x1080), arcade-pad, arcade-sunshine. All run as the normal user.
- `deploy.sh`: installs and refreshes everything above on the laptop.
- `shot.py` / `padtest.py`: screenshot display :1, and press buttons through the bridge like a phone (for SSH checks).

One-time setup by the owner: install Moonlight on the S20, open `https://<laptop>:47990` to create the Sunshine
login, add the PC in Moonlight, and type its PIN into Sunshine's PIN page.

Games: Ikemen GO v1.0.0 (MIT) ships with Kung Fu Man. For Tekken 3, use a dump of a disc you own with RetroArch
(PCSX-ReARMed); never download ROMs.
