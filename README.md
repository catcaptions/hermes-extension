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

The whole extension is **vanilla HTML/CSS/JS with no build step** — the entire client is one ~450-line file. It was intentionally kept minimal so it's easy to read, audit, and maintain (even for weaker coding models 😉).

## Features

| Feature | Status |
|---------|--------|
| Side panel chat UI (ChatGPT-clean) | ✅ |
| Paste gateway URL + API key | ✅ |
| Create session on first message | ✅ |
| Stream replies via SSE | ✅ |
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
6. Get your API key — on Windows, double-click `Copy_API_Key.cmd` → paste into Settings → **Test connection** → **Save**

## Layout (no build)

```
manifest.json       MV3 — sidePanel + storage only
background.js       open panel on toolbar click
sidepanel.html      shell
sidepanel.css       light ChatGPT-like theme
sidepanel.js        client + SSE parser (~450 lines)
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

Probe from a terminal (replace `KEY`):

```bat
curl -s -H "Authorization: Bearer KEY" http://127.0.0.1:8642/v1/health
curl -s -H "Authorization: Bearer KEY" http://127.0.0.1:8642/api/sessions?limit=1
```

## License

MIT — see [LICENSE](LICENSE).
