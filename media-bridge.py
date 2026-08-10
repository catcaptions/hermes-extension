#!/usr/bin/env python3
"""
Hermes Minimal media bridge — serves local media files to the extension so
images/audio/video show up without the browser's "Allow access to file
URLs" toggle (the gateway itself serves no media over HTTP).

Run:  python media-bridge.py   (or double-click media-bridge.bat)
Serves: http://127.0.0.1:8643/media?path=<absolute path>
        http://127.0.0.1:8643/save  (POST raw image bytes -> temp file, returns path)
        http://127.0.0.1:8643/fetch (POST {"url": ...} -> {ok, title, content};
                                     SSRF-guarded: no file://, loopback, or
                                     gateway-port targets; every redirect hop
                                     and the connected address are re-checked)
        http://127.0.0.1:8643/list  (POST {"path": ...} -> {ok, entries} for a
                                     directory's children; allowlist roots +
                                     sensitive-path blocklist, 200-entry cap)
        http://127.0.0.1:8643/git   (POST {"op": diff|staged|recent|show, ...}
                                     -> {ok, output}; read-only git ops in the
                                     repo containing the bridge's cwd, no shell)

Only files under the allowed roots are served: %APPDATA%\\Hermes, the user
home directory, and /tmp. Everything else gets a 403. /save writes to
%TEMP%\\hm-media (inside the home root on Windows) and needs no extra access.
"""
import http.client
import http.server
import json
import os
import re
import secrets
import socket
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request

# Never write __pycache__/.pyc — Chrome/Edge refuse to load an unpacked
# extension whose root contains a name starting with "_" (e.g. __pycache__).
sys.dont_write_bytecode = True

HOST, PORT = '127.0.0.1', 8643

SAVE_DIR = os.path.join(tempfile.gettempdir(), 'hm-media')
MAX_SAVE_BYTES = 5 * 1024 * 1024

# /fetch (TASK_BRIEF_10): plain urllib fetch with a curl-ish UA. The URL is
# SSRF-guarded: http(s) only, no loopback hosts (string + DNS-resolved),
# and never the gateway ports (8642/8643/8644).
FETCH_UA = 'HermesMinimal/1.0 (media-bridge)'
FETCH_TIMEOUT = 60
MAX_FETCH_BYTES = 1024 * 1024
BLOCKED_HOSTS = ('localhost', '0.0.0.0', '::1')
BLOCKED_PORTS = (8642, 8643, 8644)

SAVE_EXT = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
    'image/gif': 'gif',
}

ROOTS = []
if os.environ.get('APPDATA'):
    ROOTS.append(os.path.join(os.environ['APPDATA'], 'Hermes'))
ROOTS.append(os.path.expanduser('~'))
ROOTS.append('/tmp')
ROOTS.append(r'C:\projects')  # TASK_BRIEF_12: folder-browsed files live here
ROOTS = [os.path.normcase(os.path.realpath(r)) for r in ROOTS if os.path.isdir(r)]

# TASK_BRIEF_12: /list sensitive-path blocklist (per official Hermes docs):
# ~/.ssh, ~/.aws, ~/.config, AppData, any .env, OneDrive, and component names
# containing secret/credential/token. Applied to the requested path and to
# every entry in a listing.
SENSITIVE_PARTS = ('.ssh', '.aws', '.config', 'appdata', 'onedrive')
SENSITIVE_RE = re.compile(r'(^|[\\/])\.env$|secret|credential|token', re.I)
LIST_CAP = 200
MAX_GIT_BYTES = 100 * 1024
GIT_REF_RE = re.compile(r'^[A-Za-z0-9._/\-^~]+$')

MIME = {
    'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg',
    'gif': 'image/gif', 'webp': 'image/webp', 'bmp': 'image/bmp',
    'avif': 'image/avif', 'svg': 'image/svg+xml',
    'mp3': 'audio/mpeg', 'ogg': 'audio/ogg', 'wav': 'audio/wav',
    'm4a': 'audio/mp4', 'aac': 'audio/aac', 'flac': 'audio/flac',
    'opus': 'audio/opus',
    'mp4': 'video/mp4', 'webm': 'video/webm', 'mov': 'video/quicktime',
    'mkv': 'video/x-matroska',
}


class _Blocked(Exception):
    """A fetch target (or redirect hop / connected peer) failed the guards."""


def _norm_addr(addr):
    """IPv4-mapped IPv6 ('::ffff:127.0.0.1') -> the embedded IPv4 address."""
    return addr[7:] if addr.startswith('::ffff:') else addr


def _guard_addr(addr):
    """None if addr is a safe public address, else a short error string.
    Blocks loopback (incl. IPv4-mapped IPv6), the link-local block that
    hosts cloud metadata (169.254.169.254), the RFC1918 private ranges
    (10/8, 172.16/12, 192.168/16), and IPv6 link-local (fe80::/10)."""
    a = _norm_addr(addr)
    if a.startswith('127.') or a == '::1':
        return 'blocked'
    if a.startswith('169.254.') or a.startswith('fe80:'):
        return 'blocked'
    if a.startswith('10.') or a.startswith('192.168.'):
        return 'blocked'
    if a.startswith('172.'):
        try:
            octet = int(a.split('.', 2)[1])
        except ValueError:
            octet = -1
        if 16 <= octet <= 31:
            return 'blocked'
    return None


def _guard_url(url):
    """None if the URL may be fetched, else a short error string. Re-run on
    every redirect hop — the initial check alone is bypassable via a 302."""
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ('http', 'https'):
        return 'unsupported scheme'
    try:
        host = (parsed.hostname or '').lower()
        port = parsed.port or (443 if parsed.scheme == 'https' else 80)
    except ValueError:
        return 'unsupported scheme'  # malformed port
    if host in BLOCKED_HOSTS or _guard_addr(host):
        return 'blocked'
    if port in BLOCKED_PORTS:
        return 'blocked'
    try:
        addrs = {a[4][0] for a in socket.getaddrinfo(host, port)}
    except OSError:
        return 'dns failed'
    if any(_guard_addr(a) for a in addrs):
        return 'blocked'
    return None


class _GuardRedirectHandler(urllib.request.HTTPRedirectHandler):
    # urllib already caps redirect chains (max_redirections, default 10);
    # this override re-runs the SSRF guards on every hop before following.
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        error = _guard_url(newurl)
        if error:
            raise _Blocked(error)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class _GuardHTTPConnection(http.client.HTTPConnection):
    def connect(self):
        super().connect()
        self._guard_peer()

    def _guard_peer(self):
        # Re-validate the address actually connected: closes the DNS-rebinding
        # (TOCTOU) gap — whatever peer the OS resolved to must be public.
        error = _guard_addr(self.sock.getpeername()[0])
        if error:
            self.sock.close()
            raise _Blocked(error)


class _GuardHTTPSConnection(http.client.HTTPSConnection):
    def connect(self):
        super().connect()
        self._guard_peer()  # inherited: verified after the TLS handshake
        # (super().connect() wraps the socket first); no request bytes are
        # sent either way — the peer check still closes the rebinding gap.


class _GuardHTTPHandler(urllib.request.HTTPHandler):
    def http_open(self, req):
        return self.do_open(_GuardHTTPConnection, req)


class _GuardHTTPSHandler(urllib.request.HTTPSHandler):
    def https_open(self, req):
        return self.do_open(_GuardHTTPSConnection, req,
                            context=self._context,
                            check_hostname=self._check_hostname)


def fetch_url(url):
    """Fetch a public http(s) page as text. Returns (error, title, content);
    error is None on success. Refuses file://, loopback/link-local targets
    (by string, by resolved address, and by connected peer), URLs pointed at
    the gateway ports, and any redirect hop that fails the same checks."""
    error = _guard_url(url)
    if error:
        return error, '', ''
    req = urllib.request.Request(url, headers={
        'User-Agent': FETCH_UA,
        'Accept': 'text/html,text/markdown,text/plain,application/json,*/*',
    })
    opener = urllib.request.build_opener(
        _GuardRedirectHandler, _GuardHTTPHandler, _GuardHTTPSHandler)
    try:
        with opener.open(req, timeout=FETCH_TIMEOUT) as resp:
            body = resp.read(MAX_FETCH_BYTES + 1)
            if len(body) > MAX_FETCH_BYTES:
                return 'content too large (max 1 MB)', '', ''
            text = body.decode('utf-8', errors='replace')
    except _Blocked:
        return 'blocked', '', ''
    except urllib.error.HTTPError as err:
        return 'http error %s' % err.code, '', ''
    except (urllib.error.URLError, OSError, ValueError):
        return 'fetch failed', '', ''
    title = ''
    m = re.search(r'<title[^>]*>(.*?)</title>', text, re.I | re.S)
    if m:
        title = re.sub(r'\s+', ' ', m.group(1)).strip()[:200]
    return None, title, text


def _blocked_path(path):
    """Short error string if path (or any component) hits the sensitive
    blocklist, else None."""
    p = os.path.normcase(os.path.realpath(path))
    if any(part in SENSITIVE_PARTS for part in re.split(r'[\\/]', p)):
        return 'blocked'
    if SENSITIVE_RE.search(p):
        return 'blocked'
    return None


def list_dir(path):
    """(error, entries, truncated) for the immediate children of path.
    Blocks '..' components, paths resolving outside the allowlist roots, and
    sensitive paths; caps the listing at LIST_CAP entries (dirs first, then
    name)."""
    p = str(path or '').strip().strip('"')
    if not p or any(part == '..' for part in re.split(r'[\\/]', p)):
        return 'blocked', None, False
    try:
        rp = os.path.realpath(p)
    except OSError:
        return 'blocked', None, False
    rn = os.path.normcase(rp)
    if not any(rn == root or rn.startswith(root + os.sep) for root in ROOTS):
        return 'blocked', None, False
    if _blocked_path(rp):
        return 'blocked', None, False
    if not os.path.isdir(rp):
        return 'not a directory', None, False
    try:
        names = os.listdir(rp)
    except OSError:
        return 'read failed', None, False
    entries = []
    for n in sorted(names, key=str.lower):
        full = os.path.join(rp, n)
        if _blocked_path(full):
            continue
        try:
            is_dir = os.path.isdir(full)
            size = None if is_dir else os.path.getsize(full)
        except OSError:
            continue
        entries.append({'name': n, 'path': full, 'is_dir': is_dir, 'size': size})
    entries.sort(key=lambda e: (not e['is_dir'], e['name'].lower()))
    truncated = len(entries) > LIST_CAP
    return None, entries[:LIST_CAP], truncated


def _repo_root():
    """The git repo containing the bridge's cwd (walking up), or None."""
    d = os.getcwd()
    while True:
        if os.path.isdir(os.path.join(d, '.git')):
            return d
        parent = os.path.dirname(d)
        if parent == d:
            return None
        d = parent
    return None


def run_git(op, n=None, ref=None):
    """(error, output) for a read-only git op in the repo containing the
    bridge's cwd. Arg lists only — never shell=True. Refs are validated
    against a strict allowlist before they reach git."""
    if op not in ('diff', 'staged', 'recent', 'show'):
        return 'unknown op', ''
    root = _repo_root()
    if not root:
        return 'not a git repo', ''
    if op == 'diff':
        args = ['diff']
    elif op == 'staged':
        args = ['diff', '--staged']
    elif op == 'recent':
        try:
            count = int(n or 10)
        except (TypeError, ValueError):
            count = 10
        args = ['log', '--oneline', '-n', str(max(1, min(count, 100)))]
    else:
        ref = str(ref or '').strip()
        if not ref or not GIT_REF_RE.match(ref):
            return 'blocked ref', ''
        args = ['show', '--stat', '--format=%h %s', ref]
    try:
        proc = subprocess.run(['git', *args], cwd=root, capture_output=True,
                              text=True, errors='replace', timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return 'git failed', ''
    if proc.returncode != 0:
        return (proc.stderr or 'git failed').strip()[:400], ''
    return None, proc.stdout[:MAX_GIT_BYTES]


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != '/media':
            return self._send(404, b'not found')
        raw = urllib.parse.parse_qs(parsed.query).get('path', [''])[0]
        path = os.path.normcase(os.path.realpath(raw))
        if not any(path == root or path.startswith(root + os.sep) for root in ROOTS):
            return self._send(403, b'path outside allowed roots')
        if not os.path.isfile(path):
            return self._send(404, b'file not found')
        try:
            with open(path, 'rb') as f:
                body = f.read()
        except OSError:
            return self._send(500, b'read failed')
        ext = os.path.splitext(path)[1].lstrip('.').lower()
        self.send_response(200)
        self.send_header('Content-Type', MIME.get(ext, 'application/octet-stream'))
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == '/save':
            return self._handle_save()
        if parsed.path == '/fetch':
            return self._handle_fetch()
        if parsed.path == '/list':
            return self._handle_list()
        if parsed.path == '/git':
            return self._handle_git()
        return self._send(404, b'not found')

    def _read_json_body(self, max_bytes):
        """Parsed JSON body, or None when empty/too large/not JSON."""
        try:
            size = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            size = 0
        if size <= 0 or size > max_bytes:
            return None
        try:
            return json.loads(self.rfile.read(size))
        except (ValueError, UnicodeDecodeError):
            return None

    def _send_json(self, obj):
        resp = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(resp)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(resp)

    def _handle_list(self):
        payload = self._read_json_body(4096)
        if payload is None:
            return self._send(400, b'bad json')
        error, entries, truncated = list_dir(str(payload.get('path') or ''))
        if error:
            return self._send_json({'ok': False, 'error': error})
        return self._send_json({'ok': True, 'entries': entries, 'truncated': truncated})

    def _handle_git(self):
        payload = self._read_json_body(4096)
        if payload is None:
            return self._send(400, b'bad json')
        op = str(payload.get('op') or '')
        kw = {k: payload[k] for k in ('n', 'ref') if k in payload}
        error, output = run_git(op, **kw)
        if error:
            return self._send_json({'ok': False, 'error': error})
        return self._send_json({'ok': True, 'output': output})

    def _handle_save(self):
        ctype = self.headers.get('Content-Type', '').split(';')[0].strip().lower()
        ext = SAVE_EXT.get(ctype, 'png')
        try:
            size = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            size = 0
        if size <= 0:
            return self._send(400, b'empty body')
        if size > MAX_SAVE_BYTES:
            # Drain (bounded) so the client finishes writing before we
            # reply — otherwise the connection resets mid-upload.
            self.rfile.read(min(size, MAX_SAVE_BYTES + 4096))
            return self._send(413, b'body too large (max 5 MB)')
        body = self.rfile.read(size)
        try:
            os.makedirs(SAVE_DIR, exist_ok=True)
            path = os.path.join(SAVE_DIR, secrets.token_hex(8) + '.' + ext)
            with open(path, 'wb') as f:
                f.write(body)
        except OSError:
            return self._send(500, b'write failed')
        resp = json.dumps({'ok': True, 'path': path}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(resp)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(resp)

    def _handle_fetch(self):
        try:
            size = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            size = 0
        if size <= 0 or size > 8192:
            return self._send(400, b'bad request')
        try:
            payload = json.loads(self.rfile.read(size))
        except (ValueError, UnicodeDecodeError):
            return self._send(400, b'bad json')
        url = str(payload.get('url') or '').strip()
        error, title, content = fetch_url(url)
        if error:
            resp = json.dumps({'ok': False, 'error': error}).encode()
        else:
            resp = json.dumps({'ok': True, 'title': title, 'content': content}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(resp)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(resp)

    def _send(self, code, msg):
        self.send_response(code)
        self.send_header('Content-Type', 'text/plain')
        self.send_header('Content-Length', str(len(msg)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(msg)

    def log_message(self, *args):  # keep the console quiet
        pass


if __name__ == '__main__':
    try:
        http.server.ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        sys.exit(0)
