#!/usr/bin/env python3
"""Press buttons through the bridge like a phone would: padtest.py <player> <button>[,<button>...] [hold seconds]"""
import base64, hashlib, hmac, os, socket, sys, time
from pathlib import Path
secret = (Path.home() / 'arcade' / 'secret').read_bytes().strip()
raw = f'{sys.argv[1]}.{int(time.time()) + 300}.test'
tok = base64.urlsafe_b64encode(raw.encode()).decode().rstrip('=') + '.' + hmac.new(secret, raw.encode(), hashlib.sha256).hexdigest()
s = socket.create_connection(('127.0.0.1', 8097))
key = base64.b64encode(os.urandom(16)).decode()
s.sendall(f'GET /ws?t={tok} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n'.encode())
assert b'101' in s.recv(1024).split(b'\r\n')[0], 'handshake failed'
def send(t):
    m = os.urandom(4); b = t.encode()
    s.sendall(bytes([0x81, 0x80 | len(b)]) + m + bytes(c ^ m[i % 4] for i, c in enumerate(b)))
hold = float(sys.argv[3]) if len(sys.argv) > 3 else 0.15
for b in sys.argv[2].split(','):
    send(b + '1'); time.sleep(hold); send(b + '0'); time.sleep(0.4)
print('sent', sys.argv[2], 'as player', sys.argv[1])
