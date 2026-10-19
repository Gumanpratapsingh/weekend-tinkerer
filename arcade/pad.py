#!/usr/bin/env python3
"""Phone gamepads for the arcade on the Dell.

Serves the gamepad page on the home Wi-Fi (0.0.0.0:8097) and turns button presses from each phone into
key presses on the game's X display (:1) through XTEST. Each player has their own keys, so two phones = two players.
A link only works with a token that Cupboard signs (HMAC with ~/arcade/secret), so strangers on the Wi-Fi can't play.
"""
import asyncio, base64, hashlib, hmac, json, os, struct, time
from pathlib import Path
from Xlib import X, XK, display
from Xlib.ext import xtest

HERE = Path(__file__).resolve().parent
SECRET = (Path.home() / 'arcade' / 'secret').read_bytes().strip()
PORT = int(os.environ.get('PAD_PORT', '8097'))
DISPLAY = os.environ.get('GAME_DISPLAY', ':1')

# Ikemen GO's default keyboard controls (save/config.ini [Keys_P1] / [Keys_P2]).
KEYS = {
    1: {'up': 'Up', 'down': 'Down', 'left': 'Left', 'right': 'Right', 'lp': 'a', 'mp': 's', 'hp': 'd',
        'lk': 'z', 'mk': 'x', 'hk': 'c', 'start': 'Return'},
    2: {'up': 'i', 'down': 'k', 'left': 'j', 'right': 'l', 'lp': 'r', 'mp': 't', 'hp': 'y',
        'lk': 'f', 'mk': 'g', 'hk': 'h', 'start': 'Shift_R'},
}

dpy = display.Display(DISPLAY)
CODES = {p: {b: dpy.keysym_to_keycode(XK.string_to_keysym(k)) for b, k in m.items()} for p, m in KEYS.items()}
held = {1: set(), 2: set()}
online = {1: 0, 2: 0}


def press(player, button, down):
    code = CODES[player].get(button)
    if not code:
        return
    if down and button not in held[player]:
        held[player].add(button)
        xtest.fake_input(dpy, X.KeyPress, code)
    elif not down and button in held[player]:
        held[player].discard(button)
        xtest.fake_input(dpy, X.KeyRelease, code)
    dpy.sync()


def release_all(player):
    for b in list(held[player]):
        press(player, b, False)


def check(token):
    """token = base64url("player.expiry.name") + "." + hex HMAC; returns (player, name) or None."""
    try:
        body, sig = token.rsplit('.', 1)
        raw = base64.urlsafe_b64decode(body + '=' * (-len(body) % 4)).decode()
        if not hmac.compare_digest(sig, hmac.new(SECRET, raw.encode(), hashlib.sha256).hexdigest()):
            return None
        player, exp, name = raw.split('.', 2)
        if int(exp) < time.time() or player not in ('1', '2'):
            return None
        return int(player), name
    except Exception:
        return None


async def ws_session(reader, writer, player):
    online[player] += 1
    try:
        while True:
            head = await reader.readexactly(2)
            op, ln = head[0] & 0x0F, head[1] & 0x7F
            if ln == 126:
                ln = struct.unpack('>H', await reader.readexactly(2))[0]
            elif ln == 127:
                ln = struct.unpack('>Q', await reader.readexactly(8))[0]
            mask = await reader.readexactly(4) if head[1] & 0x80 else b'\0\0\0\0'
            data = bytes(b ^ mask[i % 4] for i, b in enumerate(await reader.readexactly(ln)))
            if op == 8:                                   # close
                break
            if op == 9:                                   # ping -> pong
                writer.write(bytes([0x8A, len(data)]) + data)
                continue
            if op == 1:                                   # text: "lp1", "up0", ...
                msg = data.decode(errors='ignore')
                for part in msg.split(','):
                    if len(part) >= 2 and part[-1] in '01':
                        press(player, part[:-1], part[-1] == '1')
    except (asyncio.IncompleteReadError, ConnectionError):
        pass
    finally:
        release_all(player)
        online[player] -= 1
        writer.close()


async def handle(reader, writer):
    try:
        req = (await reader.readuntil(b'\r\n\r\n')).decode(errors='ignore')
    except Exception:
        writer.close(); return
    line, *hdrs = req.split('\r\n')
    path = line.split(' ')[1] if ' ' in line else '/'
    headers = {h.split(':', 1)[0].strip().lower(): h.split(':', 1)[1].strip() for h in hdrs if ':' in h}
    q = dict(p.split('=', 1) for p in path.partition('?')[2].split('&') if '=' in p)
    who = check(q.get('t', ''))

    def reply(code, body, ctype='text/plain; charset=utf-8'):
        b = body.encode() if isinstance(body, str) else body
        writer.write(f'HTTP/1.1 {code}\r\nContent-Type: {ctype}\r\nContent-Length: {len(b)}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n'.encode() + b)

    if path.startswith('/ws') and headers.get('upgrade', '').lower() == 'websocket':
        if not who:
            reply('403 Forbidden', 'expired link'); await writer.drain(); writer.close(); return
        accept = base64.b64encode(hashlib.sha1((headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
        writer.write(f'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n'.encode())
        await writer.drain()
        return await ws_session(reader, writer, who[0])
    if path.startswith('/pad'):
        if not who:
            reply('403 Forbidden', 'This gamepad link has expired. Open 🎮 Gamepad in Cupboard again.')
        else:
            page = (HERE / 'pad.html').read_text().replace('__PLAYER__', str(who[0])).replace('__NAME__', json.dumps(who[1]))
            reply('200 OK', page, 'text/html; charset=utf-8')
    elif path.startswith('/status'):
        reply('200 OK', json.dumps({'online': online}), 'application/json')
    else:
        reply('404 Not Found', 'not found')
    await writer.drain()
    writer.close()


async def main():
    server = await asyncio.start_server(handle, '0.0.0.0', PORT)
    print(f'gamepad bridge on :{PORT} -> X display {DISPLAY}', flush=True)
    async with server:
        await server.serve_forever()

asyncio.run(main())
