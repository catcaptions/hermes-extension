#!/usr/bin/env python3
"""
browser-mcp.py — Hermes browser-use layer: B1 transport + B2–B4 tools.

MCP server (stdio, FastMCP, server name "live_browser") that doubles as a
loopback WebSocket hub for the Hermes extension (background.js). The
extension connects OUT to ws://127.0.0.1:8644, pairs with a token, and
relays chrome.debugger CDP traffic for the user's real tabs. The tool
surface (mcp_live_browser_*) drives the USER'S LIVE BROWSER — existing
tabs, cookies, logins — never a headless instance.

Run (stdio transport — Hermes launches it; see README):
    python browser-mcp.py
    requires: pip install fastmcp websockets

Pairing token: TOFU (trust-on-first-use), one slot PER BROWSER — the first
hello from each browser (e.g. Chrome, Edge) pins that browser's token to
`.live-browser-token` next to this script (JSON map; legacy single-token
files are migrated to a '*' slot). A browser's slot only re-pins on a hello
carrying `rotate: true` (sidepanel "Reset pairing"). A legacy '*' pin
migrates to a named slot only for a token that matches it, and is pruned
afterwards. Override/pin all browsers with env LIVE_BROWSER_TOKEN (no TOFU
while set); `--reset-pairing` clears the file; `--print-token` prints the
current pin map.

Protocol: see PROTOCOL.md
"""
import asyncio
import base64
import collections
import concurrent.futures
import json
import os
from pathlib import Path
import re
import secrets
import sys
import tempfile
import threading
import time

# TOFU pairing: the FIRST extension hello pins the token (persisted here), so
# no manual token sync is ever needed. Set LIVE_BROWSER_TOKEN to override/pin.
PAIRING_FILE = Path(__file__).resolve().with_name('.live-browser-token')

# Screenshots land here (never inside the extension root — Chrome/Edge refuse
# to load an unpacked extension containing underscore-prefixed directories,
# and the temp dir is wiped by the OS anyway).
SHOT_DIR = Path(tempfile.gettempdir()) / 'hermes-browser-shots'

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
CDP_TIMEOUT = 20.0              # per-CDP-command budget (tools)
NAV_TIMEOUT = 15.0              # navigation settle budget
POLL_MS = 0.25                  # wait-poll interval

# Uniform description prefix: the agent must know these drive the USER'S
# LIVE BROWSER, not a headless instance (DESIGN_BROWSER_USE.md §10.5).
LIVE = (
    "Drives the USER'S LIVE BROWSER — the real open tab via the Hermes "
    "extension (actual profile, cookies, logins). NOT headless. "
    "Prefer this whenever the user refers to their own open browser, tabs, "
    "or a logged-in site (portals, school/university apps, email). "
    "YOU attach tabs yourself with browser_attach / browser_tabs — NEVER "
    "ask the user to click Attach in the sidepanel."
)

def log(msg):
    print('browser-mcp: %s' % msg, file=sys.stderr, flush=True)


class ToolError(Exception):
    """Agent-facing failure (error code + hint)."""


# ── Hub-side page state (fed by extension events, read by MCP tools) ─────

class HubState:
    """What the hub knows about the attached tab. Written by the WS thread
    (attach/detach/CDP events), read by MCP worker threads (tools)."""

    def __init__(self):
        self._lock = threading.Lock()
        self.tab = None            # {id, title, url, incognito} or None
        self.refs = {}             # 'eN' -> backendNodeId (cleared on nav)
        self._next_ref = 0
        self.console = collections.deque(maxlen=200)
        self.network = collections.deque(maxlen=200)
        self._seq = 0
        self._req_urls = {}        # requestId -> url (bounded below)
        self.domains_done = False  # CDP domains enabled for the current tab

    def _reset(self):
        with self._lock:
            self.tab = None
            self.refs = {}
            self._next_ref = 0
            self.console.clear()
            self.network.clear()
            self._req_urls.clear()
            self.domains_done = False

    def on_attach(self, tab):
        self._reset()
        with self._lock:
            self.tab = dict(tab or {})

    def on_detach(self):
        self._reset()

    def on_navigated(self):
        # Main frame navigated: every backendNodeId from the old document is
        # gone. Refs die here; actions re-validate anyway (STALE_REF safety).
        with self._lock:
            self.refs = {}
            self._next_ref = 0

    def refresh_tab(self, url=None, title=None):
        """Keep the tab dict's url/title current across in-page navigation
        (frameNavigated/titleChanged) without touching refs/buffers."""
        with self._lock:
            if self.tab is None:
                return
            if url is not None:
                self.tab['url'] = str(url)[:1000]
            if title is not None:
                self.tab['title'] = str(title)[:1000]

    def add_ref(self, backend_node_id):
        with self._lock:
            self.refs['e%d' % (self._next_ref + 1)] = backend_node_id
            self._next_ref += 1
            return 'e%d' % self._next_ref

    def ref_for(self, backend_node_id):
        """Existing ref for this node, or a fresh one (refs stay stable for
        live nodes across snapshots — epoch semantics come free because a
        dead node fails validation with STALE_REF)."""
        with self._lock:
            for name, bid in self.refs.items():
                if bid == backend_node_id:
                    return name
        return self.add_ref(backend_node_id)

    def get_ref(self, name):
        with self._lock:
            return self.refs.get(name)

    def _next_seq(self):
        with self._lock:
            self._seq += 1
            return self._seq

    def push_console(self, level, text):
        self.console.append({'seq': self._next_seq(), 'level': level,
                             'text': str(text)[:500]})

    def note_request(self, request_id, url):
        if len(self._req_urls) > 2000:
            self._req_urls.clear()
        self._req_urls[request_id] = url

    def push_network(self, url, status, mime=''):
        self.network.append({'seq': self._next_seq(), 'url': str(url)[:500],
                             'status': status, 'mime': mime})

    def since(self, buf, since_seq):
        return [e for e in buf if e['seq'] > since_seq]


hub_state = HubState()


# ── Bridge: MCP threads <-> WS thread ────────────────────────────────────

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
        msg_id = secrets.randbelow(2 ** 53)  # unguessable (spoofing, first-writer-wins)
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
        with self._lock:
            fut = self._pending.pop(msg.get('id'), None)
        if fut is not None and not fut.done():
            ok = msg.get('ok') is True
            fut.set_result((ok, msg.get('result') if ok else msg.get('error')))


bridge = Bridge()


# ── WS connection handling ───────────────────────────────────────────────

class Connection:
    """One paired WS connection. All state lives on the server; the reader
    task and the heartbeat task share the connection under a send lock."""

    def __init__(self, ws):
        self.ws = ws
        self.active = True
        self.pong_event = asyncio.Event()
        self._send_lock = asyncio.Lock()
        self.reader_task = None
        self.heartbeat_task = None

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
            # Clear BEFORE sending: a pong that lands between send() and a
            # post-send clear() would be wiped and falsely time us out.
            self.pong_event.clear()
            await self.send({'cmd': 'ping'})
            try:
                await asyncio.wait_for(self.pong_event.wait(), PONG_TIMEOUT)
            except asyncio.TimeoutError:
                log('heartbeat timeout — bridge marked down')
                await self.shutdown('heartbeat timeout')

    async def handle(self, msg):
        cmd = msg.get('cmd')
        if cmd == 'hello':
            self._handle_hello(msg)
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
        elif cmd == 'ping':
            await self.send({'cmd': 'pong'})
        elif cmd == 'attach':
            tab = msg.get('tab') or {}
            tab['id'] = msg.get('tabId', tab.get('id'))
            bridge.attached = tab
            hub_state.on_attach(tab)
            log('attached to tab %s (%s)' % (tab.get('id'), tab.get('title') or tab.get('url') or '?'))
        elif cmd == 'detach':
            bridge.attached = None
            hub_state.on_detach()
        elif cmd == 'event':
            self._handle_event(msg)
        else:
            await self.send({'id': msg.get('id'), 'ok': False, 'error': 'unknown cmd'})

    def _handle_hello(self, msg):
        # Pairing/TOFU decisions only — no awaits inside (single lock hold).
        with bridge._lock:
            browser_name = str(msg.get('browser') or '*')[:64]
            incoming = str(msg.get('token') or '')
            if not incoming:
                # Soft unpaired: no token, nothing to pin, socket stays open
                # (an empty token is not a bad-token reject).
                bridge.paired = False
                return
            # Exact slot first; a legacy '*' pin is only a migration source,
            # never a pair-by-value master credential.
            pin = bridge.pins.get(browser_name)
            wildcard = bridge.pins.get('*') if pin is None else None
            if pin is None and wildcard is not None and incoming == wildcard:
                if bridge.env_pin:
                    # Env token pins every browser: pair under '*' with no
                    # slot bookkeeping (and no pin-file write).
                    self._adopt(msg, browser_name, env=True)
                else:
                    # Legacy '*' pin: migrate to a named slot and prune the
                    # master key so it can't mint other slots.
                    bridge.pins[browser_name] = incoming
                    del bridge.pins['*']
                    _save_pins()
                    self._adopt(msg, browser_name)
                    log('TOFU paired (migrated from legacy pin) — token pinned to %s'
                        % PAIRING_FILE.name)
            elif pin is None and wildcard is not None:
                # A legacy '*' pin exists but this token isn't it — a local
                # process that only knows the port must not mint a slot.
                bridge.paired = False
            elif pin is None:
                # TOFU: pin whatever token this browser's extension sends.
                bridge.pins[browser_name] = incoming
                _save_pins()
                self._adopt(msg, browser_name)
                log('TOFU paired with extension (%s) — token pinned to %s'
                    % (browser_name, PAIRING_FILE.name))
            elif incoming == pin:
                self._adopt(msg, browser_name)
            elif msg.get('rotate'):
                # Explicit user-initiated token rotation (sidepanel
                # "Reset pairing" -> one-shot rotate:true hello).
                bridge.pins[browser_name] = incoming
                _save_pins()
                self._adopt(msg, browser_name)
                log('rotate paired (%s) — token re-pinned to %s'
                    % (browser_name, PAIRING_FILE.name))
            else:
                bridge.paired = False

    @staticmethod
    def _adopt(msg, browser_name, env=False):
        bridge.paired = True
        bridge.paired_browser = browser_name
        bridge.browser = browser_name
        bridge.ext_version = str(msg.get('version') or '')[:64]
        log('paired with extension %s v%s (%s%s)'
            % (str(msg.get('extId') or '?')[:64], bridge.ext_version,
               browser_name, ' via env token' if env else ''))

    def _handle_event(self, msg):
        """Forwarded chrome.debugger events for the attached tab. Consumed
        for navigation epochs and the console/network buffers."""
        method = str(msg.get('method') or '')
        params = msg.get('params') or {}
        try:
            if method == 'Page.frameNavigated':
                if not params.get('frame', {}).get('parentId'):
                    hub_state.on_navigated()
                    hub_state.refresh_tab(
                        url=(params.get('frame') or {}).get('url'))
            elif method == 'Page.titleChanged':
                hub_state.refresh_tab(title=params.get('title'))
            elif method == 'Runtime.consoleAPICalled':
                parts = []
                for a in params.get('args') or []:
                    parts.append(str(a.get('value', a.get('description', '')) or ''))
                hub_state.push_console(str(params.get('type') or 'log'),
                                       ' '.join(p for p in parts if p))
            elif method == 'Log.entryAdded':
                e = params.get('entry') or {}
                hub_state.push_console(str(e.get('level') or 'info'), e.get('text') or '')
            elif method == 'Network.requestWillBeSent':
                hub_state.note_request(params.get('requestId'),
                                       (params.get('request') or {}).get('url') or '')
            elif method == 'Network.responseReceived':
                r = params.get('response') or {}
                hub_state.push_network(
                    hub_state._req_urls.get(params.get('requestId'), r.get('url') or ''),
                    r.get('status'), r.get('mimeType') or '')
            elif method == 'Network.loadingFailed':
                hub_state.push_network(
                    hub_state._req_urls.get(params.get('requestId'), '(request)'),
                    'FAIL', params.get('errorText') or '')
        except Exception as err:  # event handling must never kill the reader
            log('event %s dropped: %s' % (method, err))

    async def shutdown(self, reason):
        if not self.active:
            return
        self.active = False
        self.pong_event.set()
        with bridge._lock:
            if bridge._conn is not self:
                # Superseded by a newer connection (takeover) — do NOT clear
                # shared state that the healthy connection owns.
                return
            bridge._conn = None
            bridge.paired = False
            bridge.attached = None
            pending = bridge._pending
            bridge._pending = {}
        hub_state.on_detach()
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
    old = None
    with bridge._lock:
        old = bridge._conn
        if old is not None and old is not conn:
            old.active = False
            old.pong_event.set()
        bridge._conn = conn
    if old is not None and old is not conn:
        # Takeover (last-writer-wins): the previous connection is superseded
        # — cancel its tasks so its shutdown() cannot poison the new pairing.
        # (A 4403 reject would make the extension back off forever while the
        # other browser holds the slot.)
        old.reader_task.cancel()
        old.heartbeat_task.cancel()
    reader_task = asyncio.create_task(conn.reader())
    heartbeat_task = asyncio.create_task(conn.heartbeat())
    conn.reader_task = reader_task
    conn.heartbeat_task = heartbeat_task
    await reader_task
    heartbeat_task.cancel()
    await conn.shutdown('connection closed')


def _ws_thread():
    async def _main():
        bridge._loop = asyncio.get_running_loop()
        async with serve(ws_handler, HOST, PORT):
            await asyncio.Future()  # serve forever

    asyncio.run(_main())


def _save_pins():
    """Persist the pin map. Callers MUST already hold bridge._lock (the
    threading.Lock is NOT reentrant — acquiring it again here deadlocks
    the event loop). Falls back to a single plain-text token file when
    only the legacy '*' slot exists (keeps the file human-readable)."""
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


# ── Snapshot compaction (pure — unit-tested) ─────────────────────────────

# Roles that get a ref (actionable targets).
INTERACTIVE_ROLES = {
    'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'switch',
    'combobox', 'listbox', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
    'option', 'tab', 'slider', 'spinbutton', 'treeitem', 'textbox multiline',
}
# Roles kept only to give the tree structure (emitted when their subtree has
# at least one kept node).
STRUCTURAL_ROLES = {
    'heading', 'dialog', 'alertdialog', 'article', 'section', 'region',
    'main', 'navigation', 'complementary', 'contentinfo', 'banner', 'form',
    'group', 'list', 'listitem', 'table', 'row', 'cell', 'grid', 'gridcell',
    'tablist', 'menubar', 'menu', 'toolbar', 'tree', 'treegrid',
}
EXTRA_PROPS = ('checked', 'disabled', 'expanded', 'focused', 'required',
               'selected', 'invalid', 'pressed', 'level')


def _ax_field(node, key):
    v = node.get(key)
    if isinstance(v, dict):
        return v.get('value')
    return v


def compact_ax_tree(nodes, max_items=80, ref_name=None):
    """Flatten an Accessibility.getFullAXTree result into compact text lines.

    Pure function — no CDP, no state. Returns (lines, refs, truncated) where
    refs maps 'eN' -> backendDOMNodeId for interactive nodes only, in tree
    order, and truncated is True when the item cap kicked in. ref_name(bid)
    customizes ref naming (the hub passes one that keeps refs stable for
    unchanged nodes across snapshots).
    """
    by_id = {}
    children = collections.defaultdict(list)
    for n in nodes:
        if not isinstance(n, dict) or 'nodeId' not in n:
            continue
        by_id[n['nodeId']] = n
        children[n.get('parentId')].append(n['nodeId'])
    roots = sorted(nid for nid in by_id if by_id[nid].get('parentId') not in by_id)

    def role_of(n):
        return str(_ax_field(n, 'role') or 'generic').lower()

    # Keep a node if interactive, or structural-with-kept-descendant.
    kept_cache = {}

    def subtree_kept(nid):
        if nid in kept_cache:
            return kept_cache[nid]
        n = by_id.get(nid)
        if n is None:
            return False
        r = role_of(n)
        keep = r in INTERACTIVE_ROLES
        if not keep and r in STRUCTURAL_ROLES:
            keep = any(subtree_kept(c) for c in children.get(nid, ()))
        kept_cache[nid] = keep
        return keep

    lines = []
    refs = {}
    truncated = False
    counter = [0]

    def default_ref_name(bid):
        counter[0] += 1
        return 'e%d' % counter[0]

    ref_name = ref_name or default_ref_name

    def emit(nid, depth):
        nonlocal truncated
        if truncated:
            return
        n = by_id.get(nid)
        if n is None:
            return
        r = role_of(n)
        if not subtree_kept(nid):
            for c in children.get(nid, ()):
                emit(c, depth)
            return
        if r in INTERACTIVE_ROLES and len(lines) >= max_items:
            truncated = True
            return
        name = str(_ax_field(n, 'name') or '')
        parts = [' ' * depth + '- ' + r]
        if name:
            parts.append(' "%s"' % name.replace('"', "'")[:80])
        value = _ax_field(n, 'value')
        if value is not None and r in ('textbox', 'searchbox', 'combobox',
                                       'spinbutton', 'slider'):
            parts.append(' = "%s"' % str(value).replace('"', "'")[:60])
        props = {str(p.get('name')): p.get('value')
                 for p in n.get('properties') or [] if isinstance(p, dict)}
        for prop in EXTRA_PROPS:
            v = props.get(prop)
            if v is True or (prop == 'level' and isinstance(v, int)):
                parts.append(' [%s=%s]' % (prop, v if v is not True else 'true'))
        bid = n.get('backendDOMNodeId')
        if r in INTERACTIVE_ROLES and bid is not None:
            ref = ref_name(bid)
            refs[ref] = bid
            parts.append(' [%s]' % ref)
        lines.append(''.join(parts))
        for c in children.get(nid, ()):
            emit(c, depth + 1)

    for nid in roots:
        emit(nid, 0)
    return lines, refs, truncated


def normalize_ref(target):
    """Accept 'e5', '@e5', '[e5]', 'E5' -> 'e5'; anything else is a selector."""
    t = str(target or '').strip().strip('@[]').strip().lower()
    return t if len(t) >= 2 and t[0] == 'e' and t[1:].isdigit() else None


# Viewport-coordinate target: '350,120' / '-10.5, 0' -> (x, y), else None.
COORD_RE = re.compile(r'^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$')


def parse_xy(target):
    """Parse a 'x,y' coordinate target; anything else returns None."""
    m = COORD_RE.match(str(target or ''))
    return (float(m.group(1)), float(m.group(2))) if m else None


# Scroll direction -> sign vector (px deltas = sign * amount).
_SCROLL_DELTAS = {
    'up': (0, -1), 'down': (0, 1), 'left': (-1, 0), 'right': (1, 0),
}


def _scroll_deltas(direction, amount):
    """Direction + px amount -> (dx, dy) scroll deltas. Raises BAD_DIRECTION."""
    d = str(direction or '').lower()
    if d not in _SCROLL_DELTAS:
        raise ToolError("BAD_DIRECTION: use up/down/left/right, got %r" % direction)
    dx, dy = _SCROLL_DELTAS[d]
    return dx * int(amount), dy * int(amount)


# Key event modifiers (CDP modifiers bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8).
KEY_MODIFIERS = {
    'ctrl': 2, 'control': 2, 'shift': 8, 'alt': 1,
    'meta': 4, 'cmd': 4, 'command': 4,
}


# Key events (friendly name -> (key, code, windowsVirtualKeyCode)).
KEY_EVENTS = {
    'enter': ('Enter', 'Enter', 13), 'return': ('Enter', 'Enter', 13),
    'tab': ('Tab', 'Tab', 9),
    'escape': ('Escape', 'Escape', 27), 'esc': ('Escape', 'Escape', 27),
    'backspace': ('Backspace', 'Backspace', 8),
    'delete': ('Delete', 'Delete', 46),
    'arrowup': ('ArrowUp', 'ArrowUp', 38), 'up': ('ArrowUp', 'ArrowUp', 38),
    'arrowdown': ('ArrowDown', 'ArrowDown', 40), 'down': ('ArrowDown', 'ArrowDown', 40),
    'arrowleft': ('ArrowLeft', 'ArrowLeft', 37), 'left': ('ArrowLeft', 'ArrowLeft', 37),
    'arrowright': ('ArrowRight', 'ArrowRight', 39), 'right': ('ArrowRight', 'ArrowRight', 39),
    'home': ('Home', 'Home', 36), 'end': ('End', 'End', 35),
    'pageup': ('PageUp', 'PageUp', 33), 'pagedown': ('PageDown', 'PageDown', 34),
    'space': (' ', 'Space', 32),
}

# JS: set a <select>'s value safely (native setter + input/change events so
# React/Vue see it), matching values by value OR label.
JS_SELECT = """
function(values) {
  const el = this;
  const desc = Object.getOwnPropertyDescriptor(
    el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : Object.getPrototypeOf(el), 'value');
  let matched = 0;
  for (const v of values) {
    for (const o of el.options) {
      if (o.value === v || o.label === v || o.text === v) {
        if (desc && desc.set) desc.set.call(el, o.value); else el.value = o.value;
        matched++;
        break;
      }
    }
  }
  el.dispatchEvent(new Event('input', {bubbles: true}));
  el.dispatchEvent(new Event('change', {bubbles: true}));
  return matched;
}
"""

JS_SET_CHECKED = """
function(want) {
  if (this.checked !== want) {
    this.scrollIntoView({block: 'center'});
    this.click();
  }
  return this.checked;
}
"""

JS_CLEAR_VALUE = """
function() {
  const proto = this instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
    : this instanceof HTMLInputElement ? HTMLInputElement.prototype
    : Object.getPrototypeOf(this);
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc && desc.set) desc.set.call(this, ''); else this.value = '';
  this.dispatchEvent(new Event('input', {bubbles: true}));
}
"""


# ── CDP helpers (MCP worker threads) ─────────────────────────────────────

def _tab(auto_attach=True):
    """The attached tab dict, adopting it from a status round-trip when the
    attach event hasn't landed yet (e.g. right after a hub restart).
    If still unattached and auto_attach, debugger-attach the focused tab
    so the agent never has to ask the user to click the sidepanel."""
    tab = hub_state.tab
    if tab is None:
        if not bridge.is_connected():
            raise ToolError(
                'BRIDGE_DOWN: bridge not connected — load the Hermes '
                'extension (and keep Hermes running with live_browser MCP)')
        ok, result = bridge.request('status', {}, STATUS_TIMEOUT)
        if not ok:
            raise ToolError('BRIDGE_DOWN: status request failed: %s' % result)
        if (result or {}).get('attached'):
            tab = (result or {}).get('tab') or {}
            hub_state.on_attach(tab)
            return tab
        if auto_attach:
            ok2, res2 = bridge.request(
                'tabs', {'action': 'attach'}, max(STATUS_TIMEOUT, 10.0))
            if ok2 and isinstance(res2, dict) and res2.get('attached') and res2.get('tab'):
                tab = res2['tab']
                hub_state.on_attach(tab)
                bridge.attached = tab
                return tab
            raise ToolError(
                'TAB_NOT_ATTACHED: auto-attach failed (%s) — call '
                'browser_tabs(action="list") then browser_attach(tabId=…)'
                % (res2 if not ok2 else 'no focused tab'))
        raise ToolError(
            'TAB_NOT_ATTACHED: call browser_attach() or '
            'browser_tabs(action="list") then browser_attach(tabId=…)')
    return tab


def _cdp(method, params=None, timeout=CDP_TIMEOUT, tab=None):
    tab = tab or _tab()
    ok, result = bridge.request(
        'cdp', {'tabId': tab.get('id'), 'method': method, 'params': params or {}},
        timeout)
    if not ok:
        raise ToolError('CDP %s failed: %s' % (method, result))
    return result


def _ensure_domains():
    """Enable the CDP domains the tools rely on (once per attach; cheap no-ops
    after that). Partial failures are tolerated — the tool that needs the
    domain will surface its own error."""
    if hub_state.domains_done:
        return
    for method in ('Page.enable', 'Runtime.enable', 'DOM.enable',
                   'Log.enable', 'Network.enable'):
        try:
            _cdp(method)
        except ToolError:
            pass
    try:
        _cdp('DOM.getDocument')  # materialize the doc or nodeIds come back 0
    except ToolError:
        pass
    hub_state.domains_done = True


def _evaluate_js(expression, await_promise=False):
    res = _cdp('Runtime.evaluate', {
        'expression': expression,
        'returnByValue': True,
        'awaitPromise': await_promise,
    })
    if res.get('exceptionDetails'):
        d = res['exceptionDetails']
        raise ToolError('JS error: %s'
                        % (d.get('exception', {}).get('description')
                           or d.get('text') or 'unknown'))
    return (res.get('result') or {}).get('value')


def _describe(bid):
    """Validate a backendNodeId still resolves — the STALE_REF gate."""
    try:
        return _cdp('DOM.describeNode', {'backendNodeId': bid})
    except ToolError as err:
        raise ToolError('STALE_REF: page changed since the snapshot — call '
                        'browser_snapshot again (%s)' % err)


def _node_id(bid):
    res = _cdp('DOM.pushNodesByBackendIdsToFrontend', {'backendNodeIds': [bid]})
    node_ids = res.get('nodeIds') or []
    if not node_ids:
        raise ToolError('STALE_REF: node no longer in the document — re-snapshot')
    return node_ids[0]


def _resolve_target(target):
    """target = ref ('e5' / '@e5' / '[e5]') or a unique CSS selector ->
    backendNodeId (registering a ref so the result line can echo it)."""
    ref = normalize_ref(target)
    if ref is not None:
        bid = hub_state.get_ref(ref)
        if bid is None:
            raise ToolError('STALE_REF: unknown ref %s — call browser_snapshot '
                            'to get fresh refs' % ref)
        return bid, ref
    # CSS selector path: DOM.performSearch matches selectors AND plain text.
    _cdp('DOM.getDocument')
    search = _cdp('DOM.performSearch', {'query': str(target)})
    count = search.get('resultCount') or 0
    if not count:
        raise ToolError('NOT_FOUND: no element matches %r' % target)
    try:
        results = _cdp('DOM.getSearchResults', {
            'searchId': search['searchId'], 'fromIndex': 0, 'toIndex': 1})
        node_ids = results.get('nodeIds') or []
        if not node_ids:
            raise ToolError('NOT_FOUND: no element matches %r' % target)
        desc = _cdp('DOM.describeNode', {'nodeId': node_ids[0]})
    finally:
        try:
            _cdp('DOM.discardSearch', {'searchId': search['searchId']})
        except ToolError:
            pass
    bid = desc.get('backendNodeId')
    if bid is None:
        raise ToolError('NOT_FOUND: element has no backend node id')
    return bid, hub_state.ref_for(bid)


def _box_center(bid):
    _describe(bid)
    res = _cdp('DOM.getBoxModel', {'backendNodeId': bid})
    content = (res.get('model') or {}).get('content') or \
              (res.get('model') or {}).get('border')
    if not content or len(content) < 8:
        raise ToolError('NOT_VISIBLE: element has no box (hidden or '
                        'zero-size) — re-snapshot')
    x = (content[0] + content[4]) / 2
    y = (content[1] + content[5]) / 2
    if x <= 0 and y <= 0:
        raise ToolError('NOT_VISIBLE: element box is zero-size')
    return x, y


def _mouse(x, y, mtype, **extra):
    _cdp('Input.dispatchMouseEvent', {'type': mtype, 'x': x, 'y': y, **extra})


def _wheel(x, y, dx, dy):
    """Mouse-wheel at a viewport point — scrolls the nearest scrollable
    container under it (use for scrollable divs, dropdown lists, modals)."""
    _cdp('Input.dispatchMouseEvent', {'type': 'mouseWheel', 'x': x, 'y': y,
                                      'deltaX': dx, 'deltaY': dy})


def _resolve_point(target):
    """target = 'x,y' coordinates, a snapshot ref, or a CSS selector ->
    a viewport point (x, y)."""
    pt = parse_xy(target)
    if pt is not None:
        return pt
    bid, _ref = _resolve_target(target)
    return _box_center(bid)


def _element_object_id(bid):
    res = _cdp('DOM.resolveNode', {'backendNodeId': bid})
    object_id = (res.get('object') or {}).get('objectId')
    if not object_id:
        raise ToolError('STALE_REF: could not resolve the element — re-snapshot')
    return object_id


def _call_on_element(bid, function, args=None):
    res = _cdp('Runtime.callFunctionOn', {
        'objectId': _element_object_id(bid),
        'functionDeclaration': function,
        'arguments': [{'value': a} for a in (args or [])],
        'returnByValue': True,
    })
    if res.get('exceptionDetails'):
        d = res['exceptionDetails']
        raise ToolError('element call failed: %s'
                        % (d.get('exception', {}).get('description')
                           or d.get('text') or 'unknown'))
    return (res.get('result') or {}).get('value')


def _is_password_field(bid):
    """Structural guard: typing into input[type=password] needs explicit
    user approval (DESIGN_BROWSER_USE.md §7.3)."""
    try:
        attrs = _cdp('DOM.getAttributes', {'nodeId': _node_id(bid)}).get('attributes') or []
    except ToolError:
        return False
    for i, a in enumerate(attrs):
        if a == 'type' and i + 1 < len(attrs) and str(attrs[i + 1]).lower() == 'password':
            return True
    return False


def _guard_typing(bid, confirm):
    if _is_password_field(bid) and confirm != 'user_approved':
        raise ToolError("SENSITIVE_ACTION: this is a password field. The "
                        "user must type credentials themselves — ask them, "
                        "don't automate it (pass confirm='user_approved' "
                        "only if the user explicitly typed approval).")


def _page_url_title():
    try:
        info = _evaluate_js(
            'JSON.stringify({url: location.href, title: document.title})')
        return json.loads(info or '{}')
    except (ToolError, ValueError):
        return {'url': hub_state.tab.get('url'), 'title': hub_state.tab.get('title')}


def _context_line():
    tab = hub_state.tab or {}
    return '[live: %s tab %s — "%s" (%s)]' % (
        bridge.browser, tab.get('id'), (tab.get('title') or '')[:60],
        (tab.get('url') or '')[:100])


def _press_key_cdp(key):
    """Press a key: 'a', 'enter', or a combo 'ctrl+a' / 'shift+tab' /
    'alt+e' / 'meta+x' (modifiers held for the press)."""
    k = str(key or '').strip()
    if not k:
        raise ToolError('KEY_EMPTY: no key given')
    mods = 0
    parts = [p.strip() for p in k.split('+') if p.strip()]
    if len(parts) > 1:
        for p in parts[:-1]:
            if p.lower() not in KEY_MODIFIERS:
                raise ToolError('KEY_UNKNOWN: %r — combos are ctrl/shift/alt/'
                                'meta + a single key (e.g. ctrl+a)' % k)
            mods |= KEY_MODIFIERS[p.lower()]
        k = parts[-1]
    if k.lower() in KEY_EVENTS:
        key_name, code, vk = KEY_EVENTS[k.lower()]
        text = None
    elif len(k) == 1:
        key_name, code, vk = k, k.upper(), ord(k.upper())
        text = None if mods else k  # modified presses select/command, not type
    else:
        raise ToolError('KEY_UNKNOWN: %r — use a single character, a combo '
                        '(ctrl/shift/alt/meta + key), or one of: %s'
                        % (k, ', '.join(sorted(KEY_EVENTS))))
    base = {'key': key_name, 'code': code, 'nativeVirtualKeyCode': vk,
            'windowsVirtualKeyCode': vk}
    if mods:
        base['modifiers'] = mods
    _cdp('Input.dispatchKeyEvent', {'type': 'keyDown', 'text': text, **base})
    _cdp('Input.dispatchKeyEvent', {'type': 'keyUp', **base})


def _save_screenshot(data_b64, ext):
    SHOT_DIR.mkdir(parents=True, exist_ok=True)
    path = SHOT_DIR / ('%s.%s' % (time.strftime('%Y%m%d-%H%M%S'), ext))
    path.write_bytes(base64.b64decode(data_b64))
    return str(path)


# ── MCP tool surface (server "live_browser" → mcp_live_browser_*) ────────

mcp = FastMCP('live_browser')


def _sync_attach_result(result):
    """Adopt an attach/activate/new tabs reply into hub_state."""
    if not isinstance(result, dict):
        return
    tab = result.get('tab')
    if result.get('attached') and tab:
        hub_state.on_attach(tab)
        bridge.attached = tab


def _tabs_action(action, tabId=0, url='', title=''):
    payload = {'action': action}
    if tabId:
        payload['tabId'] = int(tabId)
    if url:
        payload['url'] = url
    if title:
        payload['title'] = title
    timeout = STATUS_TIMEOUT if action == 'list' else max(STATUS_TIMEOUT, 10.0)
    ok, result = bridge.request('tabs', payload, timeout)
    if not ok:
        raise ToolError('TABS_FAILED: %s' % result)
    if action in ('attach', 'activate', 'new'):
        _sync_attach_result(result)
    if action == 'detach':
        hub_state.on_detach()
        bridge.attached = None
    return result


@mcp.tool()
def browser_attach_status() -> dict:
    """%s
    Call this FIRST whenever the user mentions an open browser, a tab, or a
    logged-in page. If nothing is attached yet but the bridge is up, this
    AUTO-ATTACHES the user's currently focused tab — do NOT ask them to use
    the sidepanel. To pick a different tab, call browser_tabs(action='list')
    then browser_attach(tabId=…) or browser_attach(url='…').
    Returns {live, browser, tab, incognito, debugger, bridge, hint}.""" % LIVE
    try:
        tab = _tab()
    except ToolError as err:
        return {'live': False, 'bridge': 'down' if not bridge.is_connected()
                else 'connected', 'hint': str(err)}
    return {
        'live': True,
        'browser': bridge.browser,
        'tab': {'id': tab.get('id'), 'title': tab.get('title'),
                'url': tab.get('url')},
        'incognito': bool(tab.get('incognito')),
        'debugger': 'attached',
        'bridge': 'connected',
    }


@mcp.tool()
def browser_attach(tabId: int = 0, url: str = '', title: str = '') -> dict:
    """%s
    Attach the debugger so other live_browser tools can drive a tab.
    - No args: attach the user's currently focused tab.
    - tabId: attach that tab (from browser_tabs list).
    - url / title: attach the first tab whose url/title contains the substring.
    NEVER ask the user to click Attach in the sidepanel — call this instead.
    Returns {attached, tab}.""" % LIVE
    if not bridge.is_connected():
        raise ToolError(
            'BRIDGE_DOWN: extension not connected — load the Hermes '
            'extension and keep Chrome/Edge open')
    result = _tabs_action('attach', tabId=tabId, url=url, title=title)
    if not (isinstance(result, dict) and result.get('attached')):
        raise ToolError('ATTACH_FAILED: %s' % result)
    return result


@mcp.tool()
def browser_navigate(url: str, wait: str = 'load') -> dict:
    """%s
    Navigate the attached tab to url, wait for the load (wait='load') or
    only domcontentloaded, and return {url, title}. Auto-attaches the
    focused tab if nothing is attached yet.""" % LIVE
    _tab()
    _ensure_domains()
    res = _cdp('Page.navigate', {'url': url}, timeout=NAV_TIMEOUT + CDP_TIMEOUT)
    if res.get('errorText'):
        raise ToolError('NAV_FAILED: %s (%s)' % (res['errorText'], url))
    deadline = time.time() + NAV_TIMEOUT
    ready_expr = "document.readyState === 'complete' ? 'complete' : document.readyState"
    if wait == 'domcontentloaded':
        ready_expr = "document.readyState !== 'loading' ? 'complete' : document.readyState"
    while time.time() < deadline:
        try:
            if _evaluate_js(ready_expr) == 'complete':
                break
        except ToolError:
            pass  # old context torn down mid-navigation — keep polling
        time.sleep(POLL_MS)
    time.sleep(0.3)  # settle: late layout/JS paints
    hub_state.on_navigated()
    info = _page_url_title()
    hub_state.refresh_tab(url=info.get('url'), title=info.get('title'))
    return {'url': info.get('url'), 'title': info.get('title')}


@mcp.tool()
def browser_snapshot(full: bool = False, max_items: int = 0) -> str:
    """%s
    Capture the accessibility tree of the attached tab as compact text with
    element refs ([eN] — clickable/typeable elements only). The default caps
    at 80 items (full=True -> 400). ALWAYS re-snapshot after navigation or a
    DOM mutation; old refs fail with STALE_REF (that is the contract).
    Returns the tree plus a truncated flag.""" % LIVE
    _ensure_domains()
    cap = 400 if full else 80
    if max_items and max_items > 0:
        cap = max(1, min(int(max_items), 2000))
    res = _cdp('Accessibility.getFullAXTree', {})
    # ref_for keeps refs stable for unchanged nodes across snapshots; new
    # nodes get fresh numbers (it also registers them in hub_state.refs).
    lines, refs, truncated = compact_ax_tree(res.get('nodes') or [], cap,
                                             ref_name=hub_state.ref_for)
    info = _page_url_title()
    out = ['- page: "%s" (%s)' % (info.get('title') or '', info.get('url') or '')]
    out.extend(lines)
    if truncated:
        out.append('… truncated at %d items — pass max_items or full=True '
                   'for more' % cap)
    out.append(_context_line())
    return '\n'.join(out)


@mcp.tool()
def browser_find(pattern: str, max_results: int = 10) -> str:
    """%s
    Find elements by text or CSS selector without a full snapshot. Returns
    up to max_results matches with refs ([eN]) — cheaper than
    browser_snapshot when you only need one element.""" % LIVE
    _ensure_domains()
    search = _cdp('DOM.performSearch', {'query': pattern})
    count = search.get('resultCount') or 0
    if not count:
        raise ToolError('NOT_FOUND: nothing matches %r' % pattern)
    n = max(1, min(int(max_results), count))
    try:
        results = _cdp('DOM.getSearchResults', {
            'searchId': search['searchId'], 'fromIndex': 0, 'toIndex': n})
        node_ids = results.get('nodeIds') or []
        lines = []
        for nid in node_ids:
            desc = _cdp('DOM.describeNode', {'nodeId': nid})
            bid = desc.get('backendNodeId')
            if bid is None:
                continue
            lines.append('- <%s> [%s]' % (str(desc.get('nodeName') or '?').lower(),
                                          hub_state.ref_for(bid)))
    finally:
        try:
            _cdp('DOM.discardSearch', {'searchId': search['searchId']})
        except ToolError:
            pass
    out = lines or ['- (no actionable elements matched)']
    out.append('(%d match%s total)' % (count, '' if count == 1 else 'es'))
    out.append(_context_line())
    return '\n'.join(out)


@mcp.tool()
def browser_click(target: str, button: str = 'left',
                  double_click: bool = False) -> str:
    """%s
    Click an element. target = a snapshot ref ('e5'), a unique CSS
    selector, or viewport coordinates '350,120' (canvas, charts, maps).
    double_click=True for a double click. Stale refs fail with
    STALE_REF — re-snapshot and retry.""" % LIVE
    pt = parse_xy(target)
    if pt is not None:
        x, y = pt
        ref = '@%d,%d' % (round(x), round(y))
    else:
        bid, ref = _resolve_target(target)
        x, y = _box_center(bid)
    count = 2 if double_click else 1
    btn = button if button in ('left', 'middle', 'right') else 'left'
    _mouse(x, y, 'mouseMoved', button=btn)
    _mouse(x, y, 'mousePressed', button=btn, clickCount=count)
    _mouse(x, y, 'mouseReleased', button=btn, clickCount=count)
    time.sleep(0.3)  # settle
    return 'clicked [%s]' % ref


@mcp.tool()
def browser_drag(source: str, target: str, steps: int = 10) -> str:
    """%s
    Drag from `source` to `target`: slider thumbs (range sliders, volume,
    price filters), custom drag-and-drop UIs (sortable lists, kanban
    cards, map panning). Each endpoint = a snapshot ref ('e5'), a unique
    CSS selector, or viewport coordinates '350,120'. Holds the mouse at
    source, moves in `steps` interpolated hops, releases at target — real
    mouse input, so JS/pointer-event drag libraries work. Pages using
    ONLY native HTML5 drag events (dragstart/drop) may not react: fall
    back to browser_evaluate for those.""" % LIVE
    sx, sy = _resolve_point(source)
    tx, ty = _resolve_point(target)
    n = max(1, min(int(steps), 60))
    _mouse(sx, sy, 'mouseMoved', button='none')
    _mouse(sx, sy, 'mousePressed', button='left', clickCount=1)
    time.sleep(0.1)  # let mousedown/pointerdown handlers run first
    for i in range(1, n):
        f = i / n
        _mouse(sx + (tx - sx) * f, sy + (ty - sy) * f,
               'mouseMoved', button='left', buttons=1)
    _mouse(tx, ty, 'mouseMoved', button='left', buttons=1)
    _mouse(tx, ty, 'mouseReleased', button='left', clickCount=1)
    time.sleep(0.2)  # settle
    return 'dragged (%d,%d) -> (%d,%d)' % (round(sx), round(sy),
                                           round(tx), round(ty))


@mcp.tool()
def browser_type(target: str, text: str, submit: bool = False,
                 confirm: str = '') -> str:
    """%s
    Type text into an element (appends; use browser_fill to replace).
    submit=True presses Enter after typing. SECURITY: typing into a password
    field requires confirm='user_approved' — otherwise ask the user to type
    credentials themselves.""" % LIVE
    bid, ref = _resolve_target(target)
    _guard_typing(bid, confirm)
    _describe(bid)
    _cdp('DOM.focus', {'backendNodeId': bid})
    _cdp('Input.insertText', {'text': text})
    if submit:
        _press_key_cdp('Enter')
    return 'typed into [%s]' % ref


@mcp.tool()
def browser_fill(target: str, text: str, confirm: str = '') -> str:
    """%s
    Replace an element's value (clear + type; React/Vue-safe native setter).
    SECURITY: password fields require confirm='user_approved'.""" % LIVE
    bid, ref = _resolve_target(target)
    _guard_typing(bid, confirm)
    _describe(bid)
    _call_on_element(bid, JS_CLEAR_VALUE)
    _cdp('DOM.focus', {'backendNodeId': bid})
    _cdp('Input.insertText', {'text': text})
    return 'filled [%s]' % ref


@mcp.tool()
def browser_press(key: str) -> str:
    """%s
    Press a keyboard key: a single character ('a', '3'), a name — enter,
    tab, escape, backspace, delete, space, up/down/left/right, home, end,
    pageup, pagedown — or a combo with ctrl/shift/alt/meta held
    ('ctrl+a', 'shift+tab', 'alt+f').""" % LIVE
    _tab()
    _press_key_cdp(key)
    return 'pressed %s' % key


@mcp.tool()
def browser_hover(target: str) -> str:
    """%s
    Hover an element (moves the mouse to its center).""" % LIVE
    bid, ref = _resolve_target(target)
    x, y = _box_center(bid)
    _mouse(x, y, 'mouseMoved', button='left')
    return 'hovered [%s]' % ref


@mcp.tool()
def browser_scroll(direction: str = '', amount: int = 600,
                   target: str = '') -> str:
    """%s
    Scroll, three ways:
    - page: direction up/down/left/right by amount px (direction defaults
      to 'down' when omitted);
    - target only: scroll that element into view;
    - target + direction: mouse-wheel scroll INSIDE the element's nearest
      scrollable container (dropdown lists, modal bodies, side panels).
      Wheel at the element's center — scroll the element into view first
      if it's off-screen.""" % LIVE
    if target:
        bid, ref = _resolve_target(target)
        if not direction:
            _call_on_element(
                bid, 'function() { this.scrollIntoView({block: "center", behavior: "instant"}); }')
            time.sleep(0.2)
            return 'scrolled [%s] into view' % ref
        dx, dy = _scroll_deltas(direction, amount)
        x, y = _box_center(bid)
        _wheel(x, y, dx, dy)
        return 'wheel-scrolled %s %dpx inside [%s]' % (
            str(direction).lower(), int(amount), ref)
    d = str(direction or 'down').lower()
    dx, dy = _scroll_deltas(d, amount)
    _evaluate_js('window.scrollBy(%d, %d)' % (dx, dy))
    return 'scrolled %s by %dpx' % (d, int(amount))


@mcp.tool()
def browser_select(target: str, values: list[str]) -> str:
    """%s
    Select option(s) of a <select> element by value or label (React/Vue-safe
    native setter + change event). values = list of strings.""" % LIVE
    if not values:
        raise ToolError('NO_VALUES: pass at least one option value/label')
    bid, ref = _resolve_target(target)
    matched = _call_on_element(bid, JS_SELECT, [list(values)])
    if not matched:
        raise ToolError('NOT_FOUND: none of %r match an option of the select '
                        '[%s]' % (values, ref))
    return 'selected %d option(s) in [%s]' % (matched, ref)


@mcp.tool()
def browser_check(target: str) -> str:
    """%s
    Check a checkbox/radio (no-op if already checked).""" % LIVE
    bid, ref = _resolve_target(target)
    state = _call_on_element(bid, JS_SET_CHECKED, [True])
    return 'checked [%s] (now %s)' % (ref, state)


@mcp.tool()
def browser_uncheck(target: str) -> str:
    """%s
    Uncheck a checkbox (no-op if already unchecked).""" % LIVE
    bid, ref = _resolve_target(target)
    state = _call_on_element(bid, JS_SET_CHECKED, [False])
    return 'unchecked [%s] (now %s)' % (ref, state)


@mcp.tool()
def browser_back() -> dict:
    """%s
    Go back one history entry; returns {url, title}.""" % LIVE
    _tab()
    _evaluate_js('history.back()')
    time.sleep(0.5)
    hub_state.on_navigated()
    info = _page_url_title()
    hub_state.refresh_tab(url=info.get('url'), title=info.get('title'))
    return info


@mcp.tool()
def browser_forward() -> dict:
    """%s
    Go forward one history entry; returns {url, title}.""" % LIVE
    _tab()
    _evaluate_js('history.forward()')
    time.sleep(0.5)
    hub_state.on_navigated()
    info = _page_url_title()
    hub_state.refresh_tab(url=info.get('url'), title=info.get('title'))
    return info


@mcp.tool()
def browser_evaluate(expression: str) -> object:
    """%s
    Evaluate JavaScript in the attached tab and return the JSON value. Use
    ONLY when snapshot/click/type can't do the job — this runs with the
    user's real session; never touch credentials or payments.""" % LIVE
    _ensure_domains()
    return _evaluate_js(expression)


@mcp.tool()
def browser_wait(condition: str = 'load', target: str = '', text: str = '',
                 timeout: float = 8.0) -> str:
    """%s
    Wait for: 'load' (document complete), 'visible' (target ref/selector has
    a box), 'text' (body contains text), 'text_gone' (body no longer
    contains text), or 'idle' (load + 0.5s settle). Raises on timeout.""" % LIVE
    _ensure_domains()
    deadline = time.time() + max(0.5, float(timeout))
    if condition == 'load':
        expr = "document.readyState === 'complete'"
    elif condition == 'idle':
        expr = "document.readyState === 'complete'"
    elif condition == 'visible':
        bid, _ = _resolve_target(target)
        while time.time() < deadline:
            try:
                _box_center(bid)
                return 'visible'
            except ToolError:
                pass
            time.sleep(POLL_MS)
        raise ToolError('TIMEOUT: %r never became visible within %ss'
                        % (target, timeout))
    elif condition in ('text', 'text_gone'):
        if not text:
            raise ToolError('NO_TEXT: pass text= for this condition')
        needle = json.dumps(text)
        expr = ('document.body && document.body.innerText.includes(%s)'
                % needle)
        if condition == 'text_gone':
            expr = '!(%s)' % expr
    else:
        raise ToolError('BAD_CONDITION: %r — use load, idle, visible, text, '
                        'text_gone' % condition)

    while time.time() < deadline:
        try:
            if _evaluate_js(expr):
                if condition == 'idle':
                    time.sleep(0.5)
                return condition
        except ToolError:
            pass
        time.sleep(POLL_MS)
    raise ToolError('TIMEOUT: condition %r not met within %ss' % (condition, timeout))


@mcp.tool()
def browser_screenshot(scope: str = 'viewport', target: str = '',
                       type: str = 'jpeg', quality: int = 60) -> str:
    """%s
    Screenshot the attached tab — scope: 'viewport' (visible area), 'full'
    (whole page), 'element' (needs target ref/selector). Saves to disk and
    returns the path (@image:/MEDIA: lines render inline in Hermes). Prefer
    browser_snapshot for reading content; screenshots are for visuals
    (canvas, charts, visual verification).""" % LIVE
    _ensure_domains()
    fmt = type if type in ('jpeg', 'png', 'webp') else 'jpeg'
    params = {'format': fmt}
    if fmt == 'jpeg':
        params['quality'] = max(10, min(int(quality), 100))
    if scope == 'element':
        if not target:
            raise ToolError('NO_TARGET: element scope needs target=')
        bid, _ = _resolve_target(target)
        _describe(bid)
        res = _cdp('DOM.getBoxModel', {'backendNodeId': bid})
        content = (res.get('model') or {}).get('content') or \
                  (res.get('model') or {}).get('border')
        if not content or len(content) < 8:
            raise ToolError('NOT_VISIBLE: element has no box')
        params['clip'] = {
            'x': min(content[0], content[2]),
            'y': min(content[1], content[3]),
            'width': abs(content[2] - content[0]),
            'height': abs(content[5] - content[1]),
            'scale': 1,
        }
    elif scope == 'full':
        params['captureBeyondViewport'] = True
    elif scope != 'viewport':
        raise ToolError('BAD_SCOPE: %r — use viewport, full, or element' % scope)
    res = _cdp('Page.captureScreenshot', params, timeout=CDP_TIMEOUT + 10)
    data = res.get('data')
    if not data:
        raise ToolError('CAPTURE_FAILED: empty screenshot payload')
    path = _save_screenshot(data, 'jpg' if fmt == 'jpeg' else fmt)
    return 'Screenshot saved: @image:%s\nMEDIA:%s' % (path, path)


@mcp.tool()
def browser_tabs(action: str = 'list', tabId: int = 0, url: str = '',
                 title: str = '') -> object:
    """%s
    Manage REAL browser tabs. YOU attach tabs — never ask the user to click
    Attach in the sidepanel.

    Actions:
      list     — all tabs {id,title,url,active,incognito} plus attachedTabId
      attach   — debugger-attach; no args = focused tab; or tabId / url / title
                 substring (background OK; does not steal focus)
      activate — focus + attach (waits until debugger ready)
      detach   — release debugger (tabId optional = current)
      new      — open url (default about:blank), attach, return the tab
      close    — close tabId

    Typical flow: list → attach(tabId=…) → snapshot → click…
    Or just browser_attach() / browser_attach_status() to grab the focused tab.
    TAB_BUSY = DevTools open on that tab — pick another.""" % LIVE
    return _tabs_action(action, tabId=tabId, url=url, title=title)


@mcp.tool()
def browser_upload_file(target: str, paths: list[str]) -> str:
    """%s
    Set files on a file-input element (ref from browser_snapshot, or a CSS
    selector). paths = absolute local filesystem paths the browser can read.
    Uses CDP DOM.setFileInputFiles — the browser-protocol path that bypasses
    the page-JS FileList read-only restriction (browser_evaluate cannot assign
    input.files). If target is a wrapper (e.g. .dropify-wrapper) the tool
    auto-finds a descendant input[type=file]. Dispatches input/change so
    JS/dropify listeners update. Handles single and multiple file inputs.""" % LIVE
    if not paths:
        raise ToolError('UPLOAD_EMPTY: pass at least one absolute file path')
    abs_paths = []
    for p in paths:
        path = Path(str(p)).expanduser()
        if not path.is_file():
            raise ToolError('UPLOAD_MISSING: file not found: %s' % path)
        abs_paths.append(str(path.resolve()))
    _ensure_domains()
    bid, ref = _resolve_target(target)
    desc = _describe(bid)
    node = desc.get('node') if isinstance(desc.get('node'), dict) else desc
    node_name = str(node.get('nodeName') or '').lower() if isinstance(node, dict) else ''
    attrs = {}
    try:
        raw = _cdp('DOM.getAttributes', {'nodeId': _node_id(bid)}).get('attributes') or []
        for i in range(0, len(raw), 2):
            attrs[str(raw[i]).lower()] = str(raw[i + 1])
    except ToolError:
        attrs = {}
    is_file = node_name == 'input' and attrs.get('type', '').lower() == 'file'
    # Fallback: some CDP describeNode shapes omit nodeName — check via JS
    if not is_file:
        try:
            tag_type = _call_on_element(bid,
                "function(){ return (this.tagName||'') + '|' + (this.type||'') + '|' + (this.localName||''); }")
            low = str(tag_type or '').lower()
            if 'input' in low and 'file' in low:
                is_file = True
        except ToolError:
            pass
    file_bid = bid
    file_ref = ref
    if not is_file:
        # Wrapper case (dropify etc.): find nested input[type=file]
        found_bid = None
        found_ref = None
        try:
            nid = _node_id(bid)
            q = _cdp('DOM.querySelector', {'nodeId': nid, 'selector': 'input[type=file]'})
            qid = q.get('nodeId') or 0
            if qid:
                qdesc = _cdp('DOM.describeNode', {'nodeId': qid})
                qnode = qdesc.get('node') if isinstance(qdesc.get('node'), dict) else qdesc
                qb = qnode.get('backendNodeId') if isinstance(qnode, dict) else qdesc.get('backendNodeId')
                if qb is None:
                    qb = qdesc.get('backendNodeId')
                if qb is not None:
                    found_bid = qb
                    found_ref = hub_state.ref_for(qb)
        except ToolError:
            pass
        if found_bid is not None:
            file_bid = found_bid
            file_ref = found_ref
            is_file = True
        else:
            # Last resort: JS querySelector inside the element
            try:
                has_nested = _call_on_element(bid,
                    "function(){ return this.querySelector('input[type=\"file\"]') ? 1 : 0; }")
                if has_nested:
                    # The wrapper DOES contain a file input but CDP querySelector
                    # missed it (e.g. shadow DOM) — surface a hint
                    raise ToolError('NOT_FILE_INPUT: %r (%s) is a wrapper containing '
                                    'a file input that CDP could not resolve — try '
                                    'targeting the input directly (e.g. '
                                    'input#entry_sheet_entry_values_attributes_16_filename '
                                    'or input[type=file])' % (target, ref))
            except ToolError as e:
                if 'NOT_FILE_INPUT' in str(e):
                    raise
                pass
    if not is_file:
        raise ToolError('NOT_FILE_INPUT: %r (%s) is not an <input type=file> and no '
                        'descendant file input was found — target the input directly '
                        '(e.g. input#entry_sheet_entry_values_attributes_16_filename) '
                        'or its .dropify-wrapper ancestor' % (target, ref))
    _describe(file_bid)
    try:
        _cdp('DOM.setFileInputFiles', {
            'backendNodeId': file_bid,
            'files': abs_paths,
        })
    except ToolError as e:
        raise ToolError('UPLOAD_FAILED: DOM.setFileInputFiles failed for %s (%s): %s'
                        % (target, file_ref, e))
    try:
        count = _call_on_element(file_bid,
            "function(){ this.dispatchEvent(new Event('input',{bubbles:true})); "
            "this.dispatchEvent(new Event('change',{bubbles:true})); "
            "return this.files ? this.files.length : 0; }")
    except ToolError:
        count = len(abs_paths)
    return 'ok uploaded %d file(s) -> %s (files.length=%s)\n%s' % (
        len(abs_paths), file_ref or target, count, _context_line())


@mcp.tool()
def browser_console(level: str = 'info', since_seq: int = 0) -> list:
    """%s
    Buffered console messages of the attached tab (newest last, capped at
    200). level = 'error', 'warning', or 'info' (minimum severity to show);
    since_seq = seq of the last message you saw (0 = everything buffered).""" % LIVE
    order = {'error': 0, 'warning': 1, 'info': 2, 'log': 2, 'debug': 3}
    want = order.get(str(level).lower(), 2)
    out = []
    for e in hub_state.since(hub_state.console, since_seq):
        sev = {'error': 0, 'warning': 1, 'warn': 1}.get(e['level'], 2)
        if sev <= want:
            out.append(e)
    return out


@mcp.tool()
def browser_network(filter: str = '', since_seq: int = 0) -> list:
    """%s
    Buffered network responses of the attached tab (newest last, capped at
    200): {url, status, mime}. filter = substring URLs must contain;
    since_seq = seq of the last entry you saw (0 = everything buffered).""" % LIVE
    out = []
    for e in hub_state.since(hub_state.network, since_seq):
        if not filter or filter in e['url']:
            out.append(e)
    return out


# ── Entry point ──────────────────────────────────────────────────────────

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
