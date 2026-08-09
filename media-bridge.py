#!/usr/bin/env python3
"""
Hermes Minimal media bridge — serves local media files to the extension so
images/audio/video show up without the browser's "Allow access to file
URLs" toggle (the gateway itself serves no media over HTTP).

Run:  python media-bridge.py   (or double-click media-bridge.bat)
Serves: http://127.0.0.1:8643/media?path=<absolute path>

Only files under the allowed roots are served: %APPDATA%\\Hermes, the user
home directory, and /tmp. Everything else gets a 403.
"""
import http.server
import os
import sys
import urllib.parse

HOST, PORT = '127.0.0.1', 8643

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
