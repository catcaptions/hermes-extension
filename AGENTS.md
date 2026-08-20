# Hermes Extension

Vanilla MV3 side-panel for a local Hermes gateway. No build step. README.md
is the documentation — read it before changing anything.

## What must not change

1. **No build step, no frameworks.** Dependencies are pinned files in
   `vendor/` (marked, DOMPurify, KaTeX) loaded via `<script>` tags. Don't add
   a build step, framework, or new vendored library without saying why the
   current setup can't do it.
2. **Chrome loads this folder as-is.** A `_`-prefixed name in the root (e.g.
   `__pycache__`) makes Chrome/Edge refuse to load the whole extension.
   New files at root become part of the extension — keep the root clean.
3. **Rendering is a pipeline.** Every message flows marked → DOMPurify →
   KaTeX → media expansion. Bypassing DOMPurify is an XSS hole in the user's
   real browser.

## A note from the dev

Keep it small and readable. Preferences (from the taste file):

- Compact UI: single-line rows, dot status. Never render `[object Object]`.
- Tool status inferred from actual output, not stale fields.
- Consult official docs (CDP, Chrome extension) before fixing, not just code.
- Root-cause work: plan first with parallel subagent exploration, then fix.
- Panel UX mirrors the desktop client.
- Gateway model-lock mismatches: non-blocking (muted toast, not a red banner).
- Composer stays enabled while streaming — queue/steer depend on it.

These are defaults, not law.

## Hurt yourself

1. **`__pycache__` in the root.** Never compile-check Python with
   `py_compile` in-repo. Syntax-check with `python -B -c "import ast;
   ast.parse(open('media-bridge.py', encoding='utf-8').read())"`.
2. **Two hubs on 8644.** Hermes spawns `browser-mcp.py` itself when the MCP
   registration is active; `browser-mcp.bat` is standalone-only. Never run
   both. A shadow listener on 8644 → extension waits for the hub's
   `hello-ack`. Diagnose: `netstat -ano | findstr :8644`.
3. **Hardcoding the API key or gateway URL.** Key is in `~/.hermes/.env`
   (`API_SERVER_KEY`), entered at runtime in Settings.
4. **Hand-editing `.live-browser-token`.** Recover a 4401 lockout via
   sidepanel → Browser → Reset pairing, never by editing the file.

## Hit every surface

- **Renderer vs client.** Pure logic in `renderer.js` (node-testable);
  `sidepanel.js` is the browser client.
- **Hub protocol vs PROTOCOL.md.** Wire changes in `browser-mcp.py` /
  `background.js` must update `PROTOCOL.md` in the same change.
- **User-visible vs README.** Behavior the user notices goes in `README.md`.
- **Python logic vs tests.** `browser-mcp.py` changes carry a focused test in
  `test_browser_mcp.py`.
- **Manifest vs reality.** Manifest changes need a reload in
  `chrome://extensions`; the footer version badge confirms the loaded build.
- **Bridge fallback.** Media degrades bridge → `file://` → hint block.

## Tests

- Renderer: `node test_renderer.js`
- Browser-mcp: `py -3.14 -B test_browser_mcp.py`, not `python` (venv
  PYTHONPATH breaks 3.14)
- Smallest proof: the focused test for the touched surface. No CI, no
  full-suite ritual. Live checks need the gateway up (`hermes gateway
  start`) and a reloaded panel.

## Commits

Conventional, matching history (`fix(B1): …`, `docs(B1): …`). Commit when
the change is done and verified — don't wait to be asked.

## Where code lives

- `manifest.json` — MV3: sidePanel + storage + debugger + tabs + alarms
- `background.js` — service worker: sidePanel, WS client, debugger relay
- `sidepanel.html/.css/.js` — panel UI and client
- `renderer.js` — pure markdown/media/math extraction
- `browser-mcp.py` — browser-use hub (MCP stdio + WS on 8644)
- `media-bridge.py` — local media server on 8643 (stdlib-only)
- `test_renderer.js`, `test_browser_mcp.py` — the two test files
- `PROTOCOL.md` — live-browser wire protocol
- `vendor/` — pinned marked/DOMPurify/KaTeX. Read-only, never edit.
- `*.bat` / `*.cmd` — launchers. Don't rename; README links them.