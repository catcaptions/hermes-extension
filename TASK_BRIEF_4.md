# TASK_BRIEF_4 — paste-image transport: file-path via bridge, not mega data-URL

Repo: `C:\projects\browser-extensions\hermes-minimal-extension` (HEAD `406625c`; 62 renderer tests green).

## Orchestrator findings (from live gateway log, verified)

1. User pasted a screenshot → extension sent it as `@image:data:image/png;base64,<2-4MB>`. The gateway stored it, but the agent's `vision_analyze` tool call carried the full data URL as `image_url` → Hermes message sanitizer could NOT parse the giant arg → **`Unrepairable tool_call arguments for vision_analyze — replaced with empty object`** → model lost its vision call, looped, hit `finish_reason='length'`, stream stalled → user waited 12+ min with no reply. This is THE current bug.
2. Earlier probes: ~1 KB data URL (1×1) works end-to-end; ~11 KB data URL → vision-side 400. So the data-URL path has a tiny size envelope. **The robust transport is a local FILE PATH**: `vision_analyze` accepts local paths and reads the file itself — args stay tiny, sanitizer happy, no size cap.
3. The media bridge (`media-bridge.py`, 127.0.0.1:8643) allowlist already covers `~` (user home) → `%TEMP%` is servable. Extension fetch to the bridge works (bridge-first media already ships in `d2717df`).

## Required changes

### A. media-bridge.py — add `POST /save` (small, ~30 lines)
- Route: `POST /save` with raw image bytes in the body (`Content-Type: image/png|jpeg|webp|gif`). Loopback-only (same host check as /media).
- Write bytes to `%TEMP%\hm-media\<random>.png` (create dir; random name via `secrets.token_hex(8)`). Size cap ~5 MB (413 on exceed).
- Respond JSON `{"ok": true, "path": "C:\\Users\\lasis\\AppData\\Local\\Temp\\hm-media\\xxxx.png"}` (absolute Windows path).
- No auth beyond loopback (same trust model as /media).

### B. sidepanel.js — paste send uses file-path transport (primary)
- On send with pasted images: downscale each to **max dimension 1024px** (canvas, preserve aspect), encode **JPEG q0.80** (fall back PNG for transparency? — simpler: PNG only if source has alpha, else JPEG).
- `POST` the encoded blob to `BRIDGE_BASE + '/save'`. If 200 → use returned path in the message as `@image:C:\...` (append to text like the current `@image:data:` line).
- If bridge unreachable / /save fails → fall back to current `@image:data:...` BUT additionally cap: if the data URL exceeds ~100 KB, re-encode at lower quality/scale (e.g. 640px, q0.6) to stay inside the envelope.
- Keep chips + preview exactly as-is (they operate on the pre-send blob).
- The renderer already handles `@image:C:\...` via bridge-first (d2717df) — verify it does for `%TEMP%\hm-media` paths (bridge allowlist covers `~`, so yes).

### C. README — note the paste transport (file saved via bridge, shown via bridge; no data-URL size limits).

## Constraints
- Keep 62/62 renderer tests green; `node --check sidepanel.js`; `python -m py_compile media-bridge.py`.
- Do NOT change renderer.js unless a test fails.
- Commit; reply exactly `PATH_TRANSPORT_DONE` + 3-line summary.
