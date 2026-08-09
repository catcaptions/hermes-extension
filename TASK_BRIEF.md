# Task Brief — Hermes Minimal Extension Fix (Phase 1: PLAN ONLY)

You are a senior frontend engineer working on **Hermes Minimal**, a vanilla-JS Chrome extension (MV3) that provides a ChatGPT-style side panel for the local Hermes Agent gateway. Work autonomously — no questions. This phase is **planning only**: produce a thorough implementation plan. **Do NOT modify any source files** in this phase.

## Repo layout

- `manifest.json` — MV3, sidePanel + storage permissions only
- `background.js` — opens the panel on toolbar click
- `sidepanel.html` / `sidepanel.css` / `sidepanel.js` — the entire client (~650 lines, no build step, no frameworks)
- `icons/`, `README.md`

## User requirements (the bugs to fix)

1. **Markdown is not rendered.** Everything the assistant writes shows as raw escaped plain text — bold, italics, headers, lists, links, blockquotes, tables, code blocks, task lists, etc. must render like real markdown in the chat window.
2. **LaTeX math is not rendered.** `$...$` and `$$...$$` (and `\(...\)` / `\[...\]`) should render as math.
3. **`IMAGE:path` lines must become images.** Content lines starting with `IMAGE:` (also seen lowercase `image:` and `MEDIA:`) followed by a local absolute path (e.g. `IMAGE:C:\Users\lasis\AppData\Roaming\Hermes\composer-images\composer_2026-08-08_13-29-39-364_50bb75.png`) are meant to display as an image inside the chat window. Plain `http(s)` image URLs in markdown should also render.
4. **Live updates.** When the user chats in the Hermes **desktop app**, new messages do not appear in the extension side panel until the panel is reloaded. The panel must pick up messages created by other clients (desktop app) automatically, without a manual reload.

## Verified facts (do not re-research these)

- **Root cause of #1/#2/#3**: `renderMessages()` in `sidepanel.js` (around line 320) does `div.innerHTML = ... escapeHtml(msg.content) ...` — everything is HTML-escaped into a plain-text div. There is no markdown pipeline at all. Also `escapeHtml()` (line 312) is used in several places; keep it for plain-text contexts (role labels, session titles) but the message body needs a real renderer.
- **Streaming**: `readHermesSse()` (line 221) parses the SSE stream correctly (`assistant.delta` → `onAssistant` → `assistantMsg.content = content; renderMessages()`). It works, but `renderMessages()` rebuilds the entire DOM on **every** delta chunk — with a markdown renderer this becomes O(n) per token; plan for debouncing/incremental updates so streaming stays smooth.
- **Gateway API** (running at `http://127.0.0.1:8642`, auth `Authorization: Bearer <API_SERVER_KEY>`; the key lives in `C:\Users\lasis\AppData\Local\hermes\.env` — read it with `cat`/`grep` in terminal, e.g. `grep API_SERVER_KEY /c/Users/lasis/AppData/Local/hermes/.env`):
  - `GET /api/sessions?limit=50&offset=0&order=recent` — list; rows have `id`, `title`, `source` (e.g. `"desktop"`), `message_count`; **no `updated_at` field**
  - `GET /api/sessions/{id}/messages` — history; rows have `role` (`user`/`assistant`) and `content` (markdown text possibly containing `IMAGE:`/`MEDIA:` tags)
  - `POST /api/sessions/{id}/chat/stream` — SSE turn; events `assistant.delta`, `assistant.completed`, `run.completed`, `tool.*`, `error`
  - **There is NO server-side events/SSE endpoint for watching arbitrary sessions** (only `/v1/runs/{id}/events` for runs created via `POST /v1/runs`, which the extension does not use). → Live updates must be **client-side polling** of `/api/sessions` + `/api/sessions/{id}/messages` (compare `message_count` / message list hash), throttled and only while the panel is visible. Keep it cheap (e.g. 2–5 s interval, pause when document hidden, skip when a stream is active).
- **Real content examples** (from actual sessions): assistant content contains lines like `image:C:\Users\lasis\AppData\Roaming\Hermes\composer-images\composer_2026-08-08_13-29-39-364_50bb75.png` and markdown text. Desktop-app sessions appear in `/api/sessions` with `source: "desktop"` — the extension's session list/current session must keep working for those.
- **Local image constraint**: a `chrome-extension://` page cannot read `file://` resources unless the user enables **"Allow access to file URLs"** in `chrome://extensions` → Details. Plan must render `IMAGE:`/`MEDIA:` paths as `file:///C:/...` `<img>` URLs, and document the toggle in the README; include a graceful fallback when an image fails to load (show the path as a clickable link instead of a broken-image icon).

## Constraints

- **No build step** — plain HTML/CSS/JS, no bundler, no framework. Keep it minimal and auditable (repo ethos).
- **MV3 default CSP forbids remote scripts** (`script-src 'self'`) — you may NOT load markdown/math libraries from a CDN at runtime. Either **vendor** the library files into the repo (e.g. `vendor/marked.min.js`, `vendor/dompurify.min.js`, `vendor/katex/` + its CSS/fonts) or write a small self-contained renderer. State your choice in the plan with the exact files to vendor (and where to download them from, with pinned versions) or what you will implement by hand. KaTeX fonts/CSS must also be local.
- **XSS safety is mandatory**: assistant content comes from an LLM and can contain arbitrary text; user content is user-supplied. Any markdown → HTML pipeline must sanitize (DOMPurify or equivalent). Never inject raw HTML.
- Keep the existing look & feel (light ChatGPT-like theme in `sidepanel.css`); add the minimum CSS needed for markdown elements (tables, code blocks, blockquote, math) consistent with the theme.
- Manifest changes allowed (e.g. if a permission is needed), but keep the permission surface minimal; do not add remote-code permissions.

## Hermes formatting docs (consult these)

- API server (endpoints): https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server
- Image generation / `MEDIA:` convention: https://hermes-agent.nousresearch.com/docs/user-guide/features/image-generation
- Messaging gateway (MEDIA: extraction): https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/messaging/telegram.md

## Deliverable

Write **`PLAN.md`** in the repo root containing:
1. Problem analysis (what's broken, why).
2. Chosen architecture: markdown rendering approach (vendored libs vs hand-rolled — with exact files/versions/URLs if vendoring), math rendering approach, image-tag handling (regex + normalization + fallback), and live-update approach (polling design, state reconciliation, visibility handling).
3. Precise change list per file (function-level: what to add/change/remove in `sidepanel.js`, `sidepanel.html`, `sidepanel.css`, `manifest.json`, `README.md`, plus any new `vendor/` files).
4. Streaming performance plan (debounce / incremental DOM update so re-rendering per token doesn't lag).
5. Edge cases: partial markdown during streaming (unclosed fences/tables mid-stream must not break rendering), `IMAGE:` inside code blocks (should NOT become an image — only text lines outside code), Windows paths with backslashes, message normalization in `normalizeMessage()`, XSS.
6. Testing plan: how to verify each requirement (curl the gateway, load the extension, manual checklist), including a `node --check` syntax pass.
7. Risks + open questions.

When done, reply in the chat with the exact text: **PLAN_DONE** followed by a 3–5 line summary. You may run read-only terminal commands (git status, node --check) but do not edit any tracked source file in this phase.
