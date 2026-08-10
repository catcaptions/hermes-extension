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
                                     gateway-port targets)

Only files under the allowed roots are served: %APPDATA%\\Hermes, the user
home directory, and /tmp. Everything else gets a 403. /save writes to
%TEMP%\\hm-media (inside the home root on Windows) and needs no extra access.
"""
import http.server
import json
import os
import re
import secrets
import socket
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
ROOTS = [os.path.normcase(os.path.realpath(r)) for r in ROOTS if os.path.isdir(r)]

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


def fetch_url(url):
    """Fetch a public http(s) page as text. Returns (error, title, content);
    error is None on success. Refuses file://, loopback targets (by string
    and by resolved address), and URLs pointed at the gateway ports."""
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ('http', 'https'):
        return 'unsupported scheme', '', ''
    host = (parsed.hostname or '').lower()
    port = parsed.port or (443 if parsed.scheme == 'https' else 80)
    if host in BLOCKED_HOSTS or host.startswith('127.'):
        return 'blocked', '', ''
    if port in BLOCKED_PORTS:
        return 'blocked', '', ''
    try:
        addrs = {a[4][0] for a in socket.getaddrinfo(host, port)}
    except OSError:
        return 'dns failed', '', ''
    if any(a.startswith('127.') or a == '::1' for a in addrs):
        return 'blocked', '', ''
    req = urllib.request.Request(url, headers={
        'User-Agent': FETCH_UA,
        'Accept': 'text/html,text/markdown,text/plain,application/json,*/*',
    })
    try:
        with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT) as resp:
            body = resp.read(MAX_FETCH_BYTES + 1)
            if len(body) > MAX_FETCH_BYTES:
                return 'content too large (max 1 MB)', '', ''
            text = body.decode('utf-8', errors='replace')
    except urllib.error.HTTPError as err:
        return 'http error %s' % err.code, '', ''
    except (urllib.error.URLError, OSError, ValueError):
        return 'fetch failed', '', ''
    title = ''
    m = re.search(r'<title[^>]*>(.*?)</title>', text, re.I | re.S)
    if m:
        title = re.sub(r'\s+', ' ', m.group(1)).strip()[:200]
    return None, title, text


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
        return self._send(404, b'not found')

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
