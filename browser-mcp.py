#!/usr/bin/env python3
"""
browser-mcp.py — Hermes browser-use layer, Phase B1.

MCP server (stdio, FastMCP) that doubles as a loopback WebSocket hub for the
Hermes extension (background.js). The extension connects OUT to
ws://127.0.0.1:8644, pairs with a token, and relays chrome.debugger CDP
traffic. The MCP tool surface (server "live_browser" -> mcp_live_browser_*)
drives the USER'S REAL browser — existing tabs, cookies, logins.

Run (stdio transport — Hermes launches it; see README):
    python browser-mcp.py
    requires: pip install fastmcp websockets

Pairing token: env LIVE_BROWSER_TOKEN. When unset a random token is
generated and printed to STDERR at startup (stdout is reserved for the MCP
protocol — run `python browser-mcp.py --print-token` for a copyable line).

Protocol: see PROTOCOL.md
"""
import asyncio
import concurrent.futures
import itertools
import json
import os
import secrets
import sys
import threading

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
        self.token = ''
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
                if not bridge.paired and msg.get('token') == bridge.token:
                    bridge.paired = True
                    bridge.browser = str(msg.get('browser') or 'Chrome')[:64]
                    bridge.ext_version = str(msg.get('version') or '')[:64]
                    ext_id = str(msg.get('extId') or '?')[:64]
                    log('paired with extension %s v%s' % (ext_id, bridge.ext_version))
                    return
                bridge.paired = False
            log('rejected hello: bad token')
            await self.send({'id': msg.get('id'), 'ok': False, 'error': 'bad token'})
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


def main():
    token = os.environ.get('LIVE_BROWSER_TOKEN', '').strip() or secrets.token_hex(16)
    if '--print-token' in sys.argv:
        print(token)
        return
    bridge.token = token
    if not os.environ.get('LIVE_BROWSER_TOKEN'):
        log('no LIVE_BROWSER_TOKEN in env — generated one (set it to pin):')
        log('LIVE_BROWSER_TOKEN=' + token)
    log('MCP stdio server "live_browser" up; WS hub on ws://%s:%d (loopback only)'
        % (HOST, PORT))
    threading.Thread(target=_ws_thread, name='ws-hub', daemon=True).start()
    mcp.run()  # stdio transport; blocks


if __name__ == '__main__':
    main()
