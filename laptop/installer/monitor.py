#!/usr/bin/env python3
"""Show live install progress sent by the laptop's installer (webhook reporting)."""
import json
import os
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

LOG = os.path.expanduser("~/laptop-server/install-events.jsonl")
STEPS = [  # (substring in event name, friendly text)
    ("Network", "Connecting to WiFi"),
    ("Filesystem", "Preparing the disk"),
    ("partitioning", "Erasing and partitioning the disk"),
    ("extract", "Copying Ubuntu onto the disk"),
    ("curthooks", "Setting up the system"),
    ("installing-kernel", "Installing the kernel"),
    ("install_bootloader", "Installing the boot loader"),
    ("SSH", "Setting up remote login"),
    ("Late", "Applying server settings (lid, sleep, battery)"),
    ("postinstall", "Final touches"),
    ("Shutdown", "Install finished, laptop is turning off"),
]
seen = set()
first = True


def say(msg, color="0"):
    print("\033[%sm%s  %s\033[0m" % (color, time.strftime("%H:%M:%S"), msg), flush=True)


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        global first
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        self.send_response(200)
        self.end_headers()
        with open(LOG, "ab") as f:
            f.write(body + b"\n")
        try:
            ev = json.loads(body)
        except ValueError:
            return
        if first:
            first = False
            say("Laptop is online and installing! (from %s)" % self.client_address[0], "1;32")
        name = ev.get("name", "")
        if ev.get("result") == "FAIL" or ev.get("level") == "ERROR":
            say("PROBLEM: %s %s" % (name, ev.get("description", "")), "1;31")
            return
        for key, text in STEPS:
            if key in name and text not in seen:
                seen.add(text)
                say(text, "1;36")

    def log_message(self, *args):
        pass


say("Waiting for the laptop... (start it with F12, then down arrow, Enter)", "1;33")
HTTPServer(("0.0.0.0", 8765), Handler).serve_forever()
