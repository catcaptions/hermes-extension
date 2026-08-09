# TASK_BRIEF_3 — bridge-first media loading (Edge file:// limitation)

Repo: `C:\projects\browser-extensions\hermes-minimal-extension` (HEAD `da41638`; 62 renderer tests green).

## Orchestrator findings (verified, read-only)

1. **User's Edge (v151) cannot load `file://` subresources from the extension page — even with "Allow access to file URLs" ON.** The user toggled it on, reloaded the extension, and `<img src="file:///C:/...">` still errors (known Edge limitation; Chrome tolerates it, Edge does not). The media bridge (`media-bridge.py`, `127.0.0.1:8643`) is **proven working** — the user confirmed images display when the bridge serves them.
2. Current chain: `file://` first → on error probe bridge → only then fallback hint. This makes every image error twice before rendering in Edge. **Flip the priority: bridge first, `file://` fallback.**
3. The gateway 403/CORS issue is FIXED (env `API_SERVER_CORS_ORIGINS` now includes the Edge extension origin; verified 201/200 with Origin, 403 for wrong origin). No extension code needed for that.

## Required changes (sidepanel.js only + README)

1. **Boot-time bridge probe**: at boot (inside `boot()`), `fetch(BRIDGE_BASE + '/media?path=probe', {method:'GET'})` — any HTTP response (200/403/404) means the bridge is UP; network error means DOWN. Store `bridgeUp` (module-level bool). Non-blocking (don't delay boot); timeout ~1.5s (`AbortController`).
2. **`mediaElementHtml(raw, idx, srcOverride)`**: when `bridgeUp && !srcOverride && bridgeUrl(raw)` → use the bridge URL as the src directly (local absolute paths only — `bridgeUrl` already returns null for data:/http(s)). Keep `data:image/*` and `http(s)` pass-through untouched.
3. **Keep the existing error chain** (file:// error → bridge probe → hint block) as the fallback for when the bridge is down mid-session — it already works; don't regress it.
4. **README**: document (a) Edge cannot do file:// in extension pages even with the toggle — bridge is the reliable path; (b) `media-bridge.bat` should be running (auto-start via Startup folder is being set up by the orchestrator); (c) toggle no longer required for images.
5. No changes to renderer.js tests needed unless something breaks; keep 62/62 green. `node --check sidepanel.js`. Commit; reply exactly `BRIDGE_FIRST_DONE`.
