# Mission Control wall

A fullscreen page for a monitor plugged into the S20 (USB-C → HDMI, Samsung DeX).
Clock, rotating wallpapers, both job agents' counts for today, the agent's browser live,
laptop/phone gauges, and a ticker of the agent log.

- `server.mjs` runs on the phone at `127.0.0.1:8099` and reads the agents (8083/8093) and
  laptop-api (8095) through the tunnels the laptop keeps open to the phone.
- `./deploy.sh [host] [--open]` copies it to the phone, restarts it, and with `--open` opens it on the monitor.
- Preview on the Mac: `ssh -f -N -L 18099:127.0.0.1:8099 s20phone`, then open http://localhost:18099.
