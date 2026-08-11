#!/usr/bin/env python3
"""
browser-mcp.py — Hermes browser-use layer, Phase B1.

MCP server (stdio, FastMCP) that doubles as a loopback WebSocket hub for the
Hermes extension (background.js). The extension connects OUT to
ws://127.0.0.1:8644, pairs with a token, and relays chrome.debugger CDP
traffic. The MCP tool surface (server "live_browser" -> mcp__live_browser__*)
drives the USER'S REAL browser — existing tabs, cookies, logins.

Run (stdio transport — Hermes launches it; see README):
    python browser-mcp.py
    requires: pip install fastmcp websockets

Pairing token: TOFU (trust-on-first-use), one slot PER BROWSER — the first
hello from each browser (e.g. Chrome, Edge) pins that browser's token to
`.live-browser-token` next to this script (JSON map; legacy single-token
files are migrated to a '*' slot). No manual sync needed. A browser's slot
only re-pins on a hello carrying `rotate: true` (sidepanel "Reset pairing");
a legacy '*' pin migrates to a named slot only for a token that matches it,
and is pruned afterwards. Override/pin all browsers with env
LIVE_BROWSER_TOKEN (no TOFU while set); `--reset-pairing` clears the file
(run `python browser-mcp.py --print-token` for the current pin map, or
`(tofu)` when unpinned).

Protocol: see PROTOCOL.md
"""
import asyncio
import concurrent.futures
import itertools
import json
import os
from pathlib import Path
import secrets
import sys
import threading

# TOFU pairing: the FIRST extension hello pins the token (persisted here), so
# no manual token sync is ever needed. Set LIVE_BROWSER_TOKEN to override/pin.
PAIRING_FILE = Path(__file__).resolve().with_name('.live-browser-token')

# Never write __pycache__/.pyc — Chrome/Edge refuse to load an unpacked
# extension whose root contains a name starting with "_" (see README).
sys.dont_write_bytecode = True

try:
    import websockets
    from fastmcp import FastMCP
except ImportError as err:
    print('browser-mcp: missing dependency %r — run: pip install fastmcp websockets'
          % err.name, file=sys.stderr)
    sys.exit(1)

serve = websockets.serve  # asyncio server entry (top-level in 15+ and 17+)


HOST, PORT = '127.0.0.1', 8644  # loopback ONLY — bound, not just checked
HEARTBEAT_INTERVAL = 15.0       # server pings every 15 s...
PONG_TIMEOUT = 10.0             # ...and marks the bridge down if no pong
STATUS_TIMEOUT = 5.0            # status round-trip budget (MCP tool)

# Connection states (chrome.debugger is a singleton per tab; B1 attaches to
# at most one tab at a time).
TAB_BUSY = 'TAB_BUSY'


def log(msg):
    print('browser-mcp: %s' % msg, file=sys.stderr, flush=True)


class Bridge:
    """Thread-safe shared state between the MCP side (main thread) and the
    WS hub (background thread). Pending requests are keyed by id; the WS
    thread resolves the futures when the extension replies."""

    def __init__(self):
        self.pins = {}            # browser name -> pinned token (per-browser TOFU)
        self.env_pin = False      # pins came from LIVE_BROWSER_TOKEN (no TOFU)
        self.paired_browser = ''  # browser that holds the current pairing
        self._loop = None
        self._conn = None
        self.paired = False
        self.attached = None      # {id, title, url, incognito} or None
        self.browser = 'Chrome'
        self.ext_version = ''
        self._lock = threading.Lock()
        self._pending = {}
        self._ids = itertools.count(1)

    def is_connected(self):
        with self._lock:
            return self.paired and self._conn is not None

    def send(self, obj):
        """Thread-safe best-effort send on the current WS connection."""
        with self._lock:
            loop, conn = self._loop, self._conn
        if loop is None or conn is None or not conn.active:
            return False
        try:
            asyncio.run_coroutine_threadsafe(conn.send(obj), loop)
            return True
        except Exception:
            return False

    def request(self, cmd, payload, timeout):
        """Send a request to the extension and wait for its reply.
        Returns (ok, result_or_error)."""
        msg_id = next(self._ids)
        fut = concurrent.futures.Future()
        with self._lock:
            if not self.paired or self._conn is None:
                return False, 'BRIDGE_DOWN'
            self._pending[msg_id] = fut
        if not self.send({'id': msg_id, 'cmd': cmd, **payload}):
            with self._lock:
                self._pending.pop(msg_id, None)
            return False, 'BRIDGE_DOWN'
        try:
            return fut.result(timeout=timeout)
        except concurrent.futures.TimeoutError:
            with self._lock:
                self._pending.pop(msg_id, None)
            return False, 'TIMEOUT'

    def _resolve(self, msg):
        fut = None
        with self._lock:
            fut = self._pending.pop(msg.get('id'), None)
        if fut is not None and not fut.done():
            ok = msg.get('ok') is True
            fut.set_result((ok, msg.get('result') if ok else msg.get('error')))


bridge = Bridge()


class Connection:
    """One paired WS connection. All state lives on the server; the reader
    task and the heartbeat task share the connection under a send lock."""

    def __init__(self, ws):
        self.ws = ws
        self.active = True
        self.pong_event = asyncio.Event()
        self._send_lock = asyncio.Lock()

    async def send(self, obj):
        try:
            async with self._send_lock:
                await self.ws.send(json.dumps(obj, default=str))
            return True
        except Exception:
            return False

    async def reader(self):
        try:
            async for raw in self.ws:
                try:
                    msg = json.loads(raw)
                except ValueError:
                    continue
                if not isinstance(msg, dict):
                    continue
                await self.handle(msg)
        except Exception:
            pass

    async def heartbeat(self):
        while self.active:
            await asyncio.sleep(HEARTBEAT_INTERVAL)
            if not self.active:
                return
            await self.send({'cmd': 'ping'})
            self.pong_event.clear()
            try:
                await asyncio.wait_for(self.pong_event.wait(), PONG_TIMEOUT)
            except asyncio.TimeoutError:
                log('heartbeat timeout — bridge marked down')
                await self.shutdown('heartbeat timeout')

    async def handle(self, msg):
        cmd = msg.get('cmd')
        if cmd == 'hello':
            with bridge._lock:
                browser_name = str(msg.get('browser') or '*')[:64]
                incoming = str(msg.get('token') or '')
                if not incoming:
                    # Soft unpaired: no token, nothing to pin, socket stays
                    # open (an empty token is not a bad-token reject).
                    bridge.paired = False
                    return
                # Exact slot first; a legacy '*' pin is only a migration
                # source, never a pair-by-value master credential.
                pin = bridge.pins.get(browser_name)
                wildcard = bridge.pins.get('*') if pin is None else None
                if pin is None and wildcard is not None and incoming == wildcard:
                    if bridge.env_pin:
                        # Env token pins every browser: pair under '*' with
                        # no slot bookkeeping (and no pin-file write).
                        bridge.paired = True
                        bridge.paired_browser = browser_name
                        bridge.browser = browser_name
                        bridge.ext_version = str(msg.get('version') or '')[:64]
                        log('paired with extension %s v%s (%s)'
                            % (str(msg.get('extId') or '?')[:64], bridge.ext_version,
                               browser_name))
                    else:
                        # Legacy '*' pin: migrate to a named slot and prune
                        # the master key so it can't mint other slots.
                        bridge.pins[browser_name] = incoming
                        del bridge.pins['*']
                        _save_pins()
                        bridge.paired = True
                        bridge.paired_browser = browser_name
                        bridge.browser = browser_name
                        bridge.ext_version = str(msg.get('version') or '')[:64]
                        ext_id = str(msg.get('extId') or '?')[:64]
                        log('TOFU paired (migrated from legacy pin) with extension '
                            '%s v%s (%s) — token pinned to %s'
                            % (ext_id, bridge.ext_version, browser_name,
                               PAIRING_FILE.name))
                elif pin is None and wildcard is not None:
                    # A legacy '*' pin exists but this token isn't it — a
                    # local process that only knows the port must not mint
                    # a slot (self-pin window closed).
                    bridge.paired = False
                elif pin is None:
                    # TOFU: pin whatever token this browser's extension sends.
                    bridge.pins[browser_name] = incoming
                    _save_pins()
                    bridge.paired = True
                    bridge.paired_browser = browser_name
                    bridge.browser = browser_name
                    bridge.ext_version = str(msg.get('version') or '')[:64]
                    ext_id = str(msg.get('extId') or '?')[:64]
                    log('TOFU paired with extension %s v%s (%s) — token pinned to %s'
                        % (ext_id, bridge.ext_version, browser_name, PAIRING_FILE.name))
                elif incoming == pin:
                    bridge.paired = True
                    bridge.paired_browser = browser_name
                    bridge.browser = browser_name
                    bridge.ext_version = str(msg.get('version') or '')[:64]
                    ext_id = str(msg.get('extId') or '?')[:64]
                    log('paired with extension %s v%s (%s)'
                        % (ext_id, bridge.ext_version, browser_name))
                elif msg.get('rotate'):
                    # Explicit user-initiated token rotation (sidepanel
                    # "Reset pairing" -> one-shot rotate:true hello).
                    bridge.pins[browser_name] = incoming
                    _save_pins()
                    bridge.paired = True
                    bridge.paired_browser = browser_name
                    bridge.browser = browser_name
                    bridge.ext_version = str(msg.get('version') or '')[:64]
                    ext_id = str(msg.get('extId') or '?')[:64]
                    log('TOFU paired with extension %s v%s (%s) — token pinned to %s'
                        % (ext_id, bridge.ext_version, browser_name, PAIRING_FILE.name))
                else:
                    bridge.paired = False
            if bridge.paired:
                await self.send({'cmd': 'hello-ack', 'ok': True,
                                 'browser': bridge.browser,
                                 'version': bridge.ext_version})
                return
            log('rejected hello: bad token (%s)' % str(msg.get('browser') or '?'))
            await self.send({'cmd': 'hello-ack', 'ok': False})
            await self.ws.close(code=4401, reason='bad token')
            return
        if cmd is None:
            # No cmd field -> a response to one of our requests.
            if 'id' in msg:
                bridge._resolve(msg)
            return
        if not bridge.is_connected():
            await self.send({'id': msg.get('id'), 'ok': False, 'error': 'not paired'})
            return
        if cmd == 'pong':
            self.pong_event.set()
        elif cmd == 'detach':
            with bridge._lock:
                bridge.attached = None
        elif cmd == 'event':
            pass  # consumed from B2 on (epoch invalidation, buffers)
        else:
            await self.send({'id': msg.get('id'), 'ok': False, 'error': 'unknown cmd'})

    async def shutdown(self, reason):
        if not self.active:
            return
        self.active = False
        self.pong_event.set()
        with bridge._lock:
            bridge._conn = None
            bridge.paired = False
            bridge.attached = None
            pending = bridge._pending
            bridge._pending = {}
        for fut in pending.values():
            if not fut.done():
                fut.set_result((False, 'BRIDGE_DOWN'))
        try:
            await self.ws.close()
        except Exception:
            pass


def _is_loopback(addr):
    host = addr[0] if addr else ''
    return host in ('127.0.0.1', '::1', '::ffff:127.0.0.1')


async def ws_handler(ws):
    if not _is_loopback(getattr(ws, 'remote_address', None)):
        log('rejecting non-loopback peer %r' % (getattr(ws, 'remote_address', None),))
        try:
            await ws.close(code=4400, reason='non-loopback peer rejected')
        except Exception:
            pass
        return
    conn = Connection(ws)
    with bridge._lock:
        bridge._conn = conn
    reader_task = asyncio.create_task(conn.reader())
    heartbeat_task = asyncio.create_task(conn.heartbeat())
    await reader_task
    heartbeat_task.cancel()
    await conn.shutdown('connection closed')


def _ws_thread():
    async def _main():
        bridge._loop = asyncio.get_running_loop()
        async with serve(ws_handler, HOST, PORT):
            await asyncio.Future()  # serve forever

    asyncio.run(_main())


# ── MCP tool surface (server "live_browser") ─────────────────────

mcp = FastMCP('live_browser')


@mcp.tool()
def browser_attach_status() -> dict:
    """Drives the USER'S LIVE BROWSER — the real open tab attached via the
    Hermes extension sidepanel (actual profile, cookies, logins). NOT
    headless. Prefer this whenever the user refers to their own open
    browser, tabs, or a logged-in site. Call this first whenever the user
    mentions an open browser, tab, or logged-in page.

    Returns which tab is attached, the debugger state, and the bridge
    state: {live, browser, tab, incognito, debugger, bridge}."""
    if not bridge.is_connected():
        return {
            'live': False, 'bridge': 'down',
            'hint': 'bridge not connected — run `python browser-mcp.py` '
                    '(needs `pip install fastmcp websockets`, see README) '
                    'and reload the Hermes extension',
        }
    ok, result = bridge.request('status', {}, STATUS_TIMEOUT)
    if not ok:
        return {
            'live': False, 'bridge': 'down',
            'hint': 'status request failed: %s — is the Hermes extension '
                    'loaded and awake?' % result,
        }
    if not result.get('attached'):
        return {
            'live': False, 'bridge': 'connected', 'debugger': 'none',
            'hint': 'open the Hermes sidepanel → Browser → select a tab',
        }
    tab = result.get('tab') or {}
    return {
        'live': True,
        'browser': result.get('browser') or 'Chrome',
        'tab': {'id': tab.get('id'), 'title': tab.get('title'),
                'url': tab.get('url')},
        'incognito': bool(tab.get('incognito')),
        'debugger': 'attached',
        'bridge': 'connected',
    }


def _save_pins():
    """Persist the pin map. Callers MUST already hold bridge._lock (the
    threading.Lock is NOT reentrant — acquiring it again here deadlocks
    the event loop). Falls back to a single plain-text token file when
    only one browser is pinned (keeps the file human-readable)."""
    try:
        if len(bridge.pins) == 1 and '*' in bridge.pins:
            PAIRING_FILE.write_text(bridge.pins['*'])
        else:
            PAIRING_FILE.write_text(json.dumps(bridge.pins, indent=2))
    except OSError as e:
        log('warning: could not write pairing file: %s' % e)


def _load_pins():
    """Read the pin map, migrating a legacy plain-token file to the map form."""
    if not PAIRING_FILE.exists():
        return {}
    raw = PAIRING_FILE.read_text().strip()
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else {'*': str(parsed)}
    except ValueError:
        return {'*': raw}


def main():
    if '--reset-pairing' in sys.argv:
        if PAIRING_FILE.exists():
            PAIRING_FILE.unlink()
            log('pairing reset — next extension hello will be re-pinned')
        else:
            log('no pairing file to reset')
        return
    env_token = os.environ.get('LIVE_BROWSER_TOKEN', '').strip()
    if env_token:
        bridge.pins = {'*': env_token}
        bridge.env_pin = True
        log('pairing: token pinned via env LIVE_BROWSER_TOKEN')
    else:
        bridge.pins = _load_pins()
        if bridge.pins:
            log('pairing: using pinned token map from %s (%s)'
                % (PAIRING_FILE.name, ', '.join(bridge.pins.keys())))
        else:
            log('pairing: TOFU — first extension hello per browser will be '
                'accepted and pinned to %s' % PAIRING_FILE.name)
    if '--print-token' in sys.argv:
        print(json.dumps(bridge.pins) if bridge.pins else '(tofu: unpaired)')
        return
    log('MCP stdio server "live_browser" up; WS hub on ws://%s:%d (loopback only)'
        % (HOST, PORT))
    threading.Thread(target=_ws_thread, name='ws-hub', daemon=True).start()
    mcp.run()  # stdio transport; blocks


if __name__ == '__main__':
    main()
