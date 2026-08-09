# TASK_BRIEF_2 — session-creation UX, image paste + preview, image resilience

Repo: `C:\projects\browser-extensions\hermes-minimal-extension` (git; HEAD `aa69cd6`; 57 renderer tests green).
Implement ALL of the below. Commit when done. Reply exactly `PASTE_DONE` + a short summary.

## Orchestrator findings (verified read-only; trust these)

1. **The gateway API surface works**: `POST /api/sessions` → 201 (honors client-supplied id, returns `{object, session:{id,...}}`); `GET /api/sessions`, `GET /api/sessions/{id}/messages`, and `POST /api/sessions/{id}/chat/stream` (SSE: `run.started` → `message.started` → `tool.progress` → `assistant.delta` / `assistant.completed` → `run.completed` → `done`) all work. A Node simulation of the extension's exact create→send→SSE-parse flow completed with the final reply — **the current code is functionally correct**.
2. Extension fetches bypass the gateway's CORS/Origin gate (manifest `host_permissions` covers `http://127.0.0.1/*` and `http://localhost/*`; extension fetches are same-origin-like). **Do not touch the manifest host_permissions.**
3. ⇒ The user's "session creation does not work" + "still no images" are most plausibly a **stale extension build in their browser** (unpacked extensions only pick up code changes after reload). We cannot verify in a browser (user self-verifies); make the build self-evident and the flows resilient.

## Task 1 — Session creation: tangible + verifiable

1. **`+` (btn-new) creates the session server-side immediately.** Current `beginNewChat()` only clears local state and lazily creates on first send. Change it: on click, call `createSession('New chat')` (keep existing createSession fn), store `activeSessionId` + `saveSettings`, show the new title. On failure: show the error banner (with status + short body — improve `errorMessage` for create failures) and fall back to the current lazy behavior. This makes "session creation" visible (the new session appears in the dropdown) instead of silent.
2. **Version badge in the footer** (composer-meta area): `v0.1.0 · <build date from commit>` — read `chrome.runtime.getManifest().version` and a hardcoded build string (e.g. `build 2026-08-09 aa69cd6`) so the user can instantly confirm they're running the latest build. Small, muted, unobtrusive.

## Task 2 — Image paste + click-to-preview (mirrors the desktop app the user screenshotted)

1. **Paste handler** on `#prompt`: on paste, scan `e.clipboardData.items` for `image/*`; for each, `FileReader.readAsDataURL` → attachment chip. (Also accept drag-and-drop of image files onto the composer — stretch, nice to have.)
2. **Chip strip** inside `#composer` above the textarea: row of thumbnails (~56–64px, `object-fit: cover`, rounded), truncated filename, and an **X button** per chip to remove it. Matches the desktop app UX.
3. **Click chip → preview**: full-viewport overlay (dimmed backdrop, centered image, `Esc` or backdrop click closes; X close button). Pure DOM/CSS; no libraries.
4. **Downscale before send** (critical): draw each image to a canvas, cap longest side at ~1280px, export PNG (or JPEG for photos), and keep the total per-image base64 ≤ ~350KB. Rationale: gateway (aiohttp) default POST body limit is ~1MB and vision providers reject oversized data URLs; keep the whole request comfortably under the limit.
5. **Send**: append one `@image:<dataURL>` line per chip to the message text before `sendMessage(clean)` (verified gateway convention — messages store cleanly and render back as `<img>`). Clear chips after send. Keep the chips' data in a module-level array; do not paste into the textarea.
6. **Renderer support (required, currently missing)**: `mediaUrl()` returns `null` and `mediaKind()` returns `'other'` for `data:image/*` — verified. Fix: `mediaKind('data:image/...')` → `'img'`; `mediaUrl()` → pass the data URL through unchanged (still `null` for other garbage). Then `@image:data:...` lines render as inline images with **no file-URL toggle needed**.
7. README: document the paste feature + the known limitation (agent's aux vision may 400 on large data URLs; the agent then works around it by saving to disk — desktop-app path attachments remain the reliable vision path).

## Task 3 — Local images: resilience + self-explanatory failures

1. **Upgrade the media fallback**: when a `file://` image/audio/video fails, replace with a compact element showing the path AND a hint: *"local file — enable 'Allow access to file URLs' in edge://extensions → Details, then reload the extension (see README)"*. Keep it small; the existing fallback anchor remains clickable.
2. **Optional media bridge (P2 — implement only if it stays small)**: `media-bridge.py` (Python stdlib `http.server`, bind `127.0.0.1:8643`, `GET /media?path=<abs>` serves the file, allowlist roots: `%APPDATA%\Hermes`, user home, `/tmp`; reject others with 403) + `media-bridge.bat` launcher. Extension fallback chain on media error: `file://` (current) → try `http://127.0.0.1:8643/media?path=<encoded>` once → final hint element. This makes local images show with **zero browser config** when the bridge is running. README section. (Recommended: do it — it directly kills the user's repeated "images not showing".)
   - Implementation hint: in `attachMediaFallbacks`, on first error try the bridge URL by creating a temp `<img>`/`<audio>`/`<video>` probe; on success replace the element's src (or swap in a fresh element); on failure show the hint. Keep the `failed` set semantics (CRITIQUE #11) — only mark failed after the bridge attempt also fails.

## Constraints

- Implementation via opencode in this pane ONLY. No browser automation (user self-verifies). No changes outside this repo.
- Keep the 57 existing tests green; ADD tests: `data:image` extraction via `@image:` line, `mediaKind('data:image/...') === 'img'`, `mediaUrl('data:...')` pass-through, plain `data:` garbage still null, and `@image:data:` inside fenced code NOT extracted.
- `node --check` on every changed JS file; `node test_renderer.js` all pass.
- Commit with a clear message; reply `PASTE_DONE` + summary + "how the user verifies" bullet list.
