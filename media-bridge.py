#!/usr/bin/env python3
"""
Hermes Minimal media bridge — serves local media files to the extension so
images/audio/video show up without the browser's "Allow access to file
URLs" toggle (the gateway itself serves no media over HTTP).

Run:  python media-bridge.py   (or double-click media-bridge.bat)
Serves: http://127.0.0.1:8643/media?path=<absolute path>
        http://127.0.0.1:8643/save  (POST raw image bytes -> temp file, returns path)

Only files under the allowed roots are served: %APPDATA%\\Hermes, the user
home directory, and /tmp. Everything else gets a 403. /save writes to
%TEMP%\\hm-media (inside the home root on Windows) and needs no extra access.
"""
import http.server
import json
import os
import secrets
import sys
import tempfile
import urllib.parse

# Never write __pycache__/.pyc — Chrome/Edge refuse to load an unpacked
# extension whose root contains a name starting with "_" (e.g. __pycache__).
sys.dont_write_bytecode = True

HOST, PORT = '127.0.0.1', 8643

SAVE_DIR = os.path.join(tempfile.gettempdir(), 'hm-media')
MAX_SAVE_BYTES = 5 * 1024 * 1024

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
        if parsed.path != '/save':
            return self._send(404, b'not found')
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
