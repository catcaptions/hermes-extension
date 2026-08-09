<div align="center">

# ⚡ Hermes Minimal

**A bare-minimum ChatGPT-style side panel for your local [Hermes Agent](https://github.com/abundantbeing/hermes-browser-extension) gateway.**

No build step · No frameworks · No content scripts

[![Manifest](https://img.shields.io/badge/Manifest_V3-google_chrome-blue?style=flat-square&logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/develop/migrate)
[![Min Chrome](https://img.shields.io/badge/Chrome-114%2B-4285F4?style=flat-square&logo=googlechrome&logoColor=white)](https://www.google.com/chrome/)
[![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat-square)](CONTRIBUTING.md)

</div>

---

## What is this?

A tiny Chrome/Edge extension that puts a ChatGPT-clean chat panel in your browser's side panel and talks to a **local Hermes Agent gateway** over plain HTTP + SSE.

The whole extension is **vanilla HTML/CSS/JS with no build step** — the client is `sidepanel.js` plus a small, node-testable `renderer.js`. It was intentionally kept minimal so it's easy to read, audit, and maintain (even for weaker coding models 😉).

## Features

| Feature | Status |
|---------|--------|
| Side panel chat UI (ChatGPT-clean) | ✅ |
| Paste gateway URL + API key | ✅ |
| Create session on first message | ✅ |
| **`+` creates the session server-side immediately** | ✅ |
| Stream replies via SSE | ✅ |
| Markdown rendering (marked + DOMPurify) | ✅ |
| LaTeX math (KaTeX: `$…$`, `$$…$$`, `\(…\)`, `\[…\]`) | ✅ |
| Local media (`IMAGE:` / `MEDIA:` / `@image:` / `@media:` lines; img/audio/video) | ✅ |
| Image paste + click-to-preview + downscale (`@image:data:…`) | ✅ |
| `@url:` link attachments | ✅ |
| Media bridge (local files, zero browser config) | ✅ |
| Version badge in footer | ✅ |
| Live updates from other clients (~3 s polling) | ✅ |
| Session list + switch | ✅ |
| Load message history | ✅ |
| New chat | ✅ |
| Browser-use toggle | 🔜 UI only (disabled) |
| Model picker / tools / themes | ❌ later |

Only **4 gateway endpoints** are used:

1. `POST /api/sessions` — create
2. `POST /api/sessions/{id}/chat/stream` — SSE stream
3. `GET /api/sessions/{id}/messages` — history
4. `GET /api/sessions` — list

Plus `GET /v1/health` for the connection test.

## Prerequisites

1. **Hermes Agent** installed and gateway running:

   ```bat
   hermes gateway status
   ```

   API server must be on (default `http://127.0.0.1:8642`).

2. **API key** from either:
   - `~/.hermes/.env` → `API_SERVER_KEY=…`
   - or `config.yaml` top-level `api_server.key`
     (there is a second `platforms.api_server` block that is usually `enabled: false` — ignore it)

## Install (Chrome / Edge)

1. Make sure the Hermes gateway is up:

   ```bat
   hermes gateway status
   hermes gateway start
   ```

2. Open `chrome://extensions` (or `edge://extensions`)
3. Enable **Developer mode**
4. **Load unpacked** → select this folder
5. Pin **Hermes Minimal**, click the icon (or `Alt+H`)
6. **Local media**: Edge cannot load `file://` subresources from extension pages — even with "Allow access to file URLs" on (Chrome tolerates it, Edge does not). The reliable path is the **media bridge** in step 7; the toggle is no longer required for images.
7. **Media bridge (recommended, zero browser config):** double-click `media-bridge.bat` (keep the console window open; Python 3 required) — the panel probes `http://127.0.0.1:8643` at boot and serves local media through it directly. See "Media bridge" below.
8. Get your API key — on Windows, double-click `Copy_API_Key.cmd` → paste into Settings → **Test connection** → **Save**

## Layout (no build)

```
manifest.json       MV3 — sidePanel + storage only
background.js       open panel on toolbar click
sidepanel.html      shell
sidepanel.css       light ChatGPT-like theme + markdown styles
sidepanel.js        client: SSE parser, rendering pipeline, polling, paste
renderer.js         pure markdown/media/math extraction (node-testable)
test_renderer.js    unit tests — run: node test_renderer.js
media-bridge.py     optional local media server (127.0.0.1:8643, stdlib-only)
media-bridge.bat    launcher for media-bridge.py
vendor/             pinned: marked 12.0.2, DOMPurify 3.1.6, KaTeX 0.16.11 (+ fonts)
icons/              16/32/48/128
Copy_API_Key.cmd    copies API_SERVER_KEY to clipboard
README.md
```

## How the gateway works (short)

Hermes ships a plain **HTTP REST + SSE** server. The extension is only an HTTP client.

**Auth:** `Authorization: Bearer <API_SERVER_KEY>`

**Streaming contract** (`POST …/chat/stream` → `text/event-stream`):

| Event | Meaning |
|-------|---------|
| `run.started` | turn began (`run_id`) |
| `assistant.delta` | text chunk (`data.delta`) |
| `assistant.completed` | final text (`data.content`) |
| `run.completed` | done (+ runtime metadata) |
| `tool.*` / `hermes.tool.progress` | tool activity (ignored in v1) |
| `error` | failure |
| `: keepalive` | ignore |

Request body used by v1:

```json
{ "message": "…" }
```

(The bulky extension also sends `model`, `provider`, `require_model_lock`, `selected_skills`. v1 lets the gateway use its default model.)

## Rendering & live updates

**Rendering** (applied to every message, user or assistant):

- Markdown via vendored [marked](https://github.com/markedjs/marked), sanitized with [DOMPurify](https://github.com/cure53/DOMPurify) before anything enters the DOM. GFM tables, task lists, fences, blockquotes, links, images, etc.
- LaTeX math: `$…$` / `\(…\)` inline, `$$…$$` / `\[…\]` display — typeset with vendored [KaTeX](https://katex.org). Escaped `\$` and money-like `$5` stay literal; math inside fenced/indented code blocks is never touched.
- **Local images**: content lines like `IMAGE:C:\Users\...\image.png`, `MEDIA:…` and the desktop app's `@image:…` / `@media:…` attachment lines become media in the chat — images (`png/jpg/gif/webp/bmp/avif/svg`) as inline `<img>`, audio (`mp3/ogg/wav/m4a/aac/flac/opus`) and video (`mp4/webm/mov/mkv`) as inline players. Windows/POSIX absolute paths are loaded **bridge-first** (`http://127.0.0.1:8643` when the bridge is up), falling back to `file://`, then to a clickable path link with an actionable hint. `data:` (pasted) and `http(s)` URLs bypass the bridge entirely.
- **Pasted images**: paste (or drag-drop) an image into the composer → thumbnail chips → click to preview (`Esc`/backdrop closes). On send each image is downscaled (longest side ≤1024 px, JPEG q0.80 / PNG for transparency) and **saved to a temp file via the media bridge**, which is sent as an `@image:C:\...` path line — the agent's vision reads the file itself, so there's no data-URL size limit to hit. If the bridge isn't running, the fallback is a capped (~100 KB) `@image:data:image/...` URL instead. Either way the message renders back as an inline image via the bridge. The bridge must be running for the primary path (see "Media bridge").
- **`@url:` link attachments** (desktop "Attached Context", e.g. `@url:`https://example.com/``, backticks optional) become clickable links, inline or standalone.
- Streaming deltas re-render only the last message, throttled to ~60 ms, and autoscroll while the reply grows.

**New chat** — the `+` button creates the session server-side immediately (it shows up in the session dropdown), instead of silently waiting for the first message. If creation fails, the panel says so and falls back to creating on first send.

**Version badge** — the footer shows `v<manifest version> · <build stamp>` so you can confirm the loaded build (unpacked extensions only pick up code changes after a reload).

## Media bridge

`media-bridge.py` (stdlib-only) is the **primary** way local media reaches the panel — Edge can't load `file://` subresources from extension pages (verified on Edge 151, even with the file-URL toggle on). It serves files at `http://127.0.0.1:8643/media?path=<abs>`:

- Run it: double-click `media-bridge.bat` (or `python media-bridge.py`) — keep the window open. Auto-start via the Windows **Startup** folder is recommended (`shell:startup` → shortcut to `media-bridge.bat`); the panel probes the bridge at boot and uses it directly when it's up.
- Serves only files under `%APPDATA%\Hermes`, your home directory, and `/tmp`; everything else gets a `403`.
- Fallback chain per item: **bridge** → `file://` → hint block ("start media-bridge.bat…"). Nothing breaks if the bridge isn't running — `file://` then kicks in (works in Chrome; in Edge you'll see the hint block instead).

## Browser use — later

**Live updates** — the gateway has no push endpoint for sessions other clients wrote to, so the panel polls while it is visible and idle:

- Every **3 s**, a cheap session-list request compares the active session's `message_count`; only when it changes is the full history fetched and reconciled by content fingerprint.
- Polling pauses while the panel is hidden, while settings are open, or while a stream is in progress, and never drops local messages (a 6 s post-stream grace plus a 30 s stale-limit guard a just-streamed message from blinking out).
- Chat in the desktop app and the message appears in the panel within ~3 s, no reload needed.

## Browser use — later

The settings checkbox is a placeholder. Plan:

- Toggle on → include page context in the chat body
- Driving side = Hermes companion plugin / `hermes mcp serve` + browser toolset / CDP
- Not in v1

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| "Invalid gateway API key" | Copy `API_SERVER_KEY` from `~/.hermes/.env`, not a random key |
| Connection refused | `hermes gateway start` (or restart the scheduled task) |
| Health OK but sessions 401 | Key mismatch between `.env` and running process — restart gateway after changing key |
| Empty replies | Check Hermes logs; model backend may be down |
| Local images render as path links | Run `media-bridge.bat` (or `python media-bridge.py`) and reload the panel — Edge can't load `file://` from extension pages |

Probe from a terminal (replace `KEY`):

```bat
curl -s -H "Authorization: Bearer KEY" http://127.0.0.1:8642/v1/health
curl -s -H "Authorization: Bearer KEY" http://127.0.0.1:8642/api/sessions?limit=1
```

## License

MIT — see [LICENSE](LICENSE).
