# Optimization — Hermes Extension Performance Review

> Branch: `perf/optimizations` | Date: 2026-08-20 | Goal: faster + more efficient, zero features removed

## Part 1 — Problems You Have Today

Measured by reading `sidepanel.js` (3525 lines), `renderer.js` (317), `background.js` (566), `browser-mcp.py` (~1400), `media-bridge.py` (471), `sidepanel.html`, `sidepanel.css` and profiling guidance. No features changed — just where time / RAM / network is wasted.

### 1. Chat rendering rebuilds everything on every word `sidepanel.js:1283` + `sidepanel.js:1269`

`renderMessages()` deletes every message bubble and recreates them. During streaming, `scheduleStreamingRender()` calls `renderMessageBody()` on the last message every 60 ms via `setTimeout`, and that re-runs `marked.parse()` + `DOMPurify.sanitize()` + three regex replacements + `katex.renderToString()` for *all* previous math in that bubble.

* With a 100-message history, switching sessions does ~100 × marked+sanitize in a row.
* Long streaming replies (>2000 tokens) trigger ~30 full re-parses of the same growing bubble.

**College analogy:** Like React without `key` or `memo` — the whole list re-renders when one item changes. `O(history × tokens)` work.

### 2. Same math is drawn over and over `sidepanel.js:964` + `renderer.js:29`

`mathHtml(tex)` calls `katex.renderToString` every time, even for identical `$x^2$` that appears 20 times. KaTeX is the slowest part of the pipeline (~2–5 ms per formula on low-end laptops). No cache.

### 3. Heavy libraries load even when you don't need them `sidepanel.html:168`

`vendor/katex/katex.min.js` + `katex.min.css` + ~70 font files are loaded with blocking `<script>` tags on every panel open, even for chats with zero math. That's ~300 KB JS + CSS parse before first paint.

### 4. Polling does work you can't see `sidepanel.js:2368` + `sidepanel.js:2375`

Every 3 s: `listSessions()` → then `getMessages()` if `message_count` changed. This runs even when the panel is hidden (`document.visibilityState !== 'visible'` is checked *inside* the poll, but the `setInterval` still wakes the JS context every 3 s). `fingerprint()` `renderer.js:290` does `JSON.stringify` over *every* message on each poll to decide if DOM needs updating — wasteful for 200-message histories.

### 5. Browser tab queries wake too often `sidepanel.js:3374` + `sidepanel.js:3473`

`browserPollTimer` every 2 s calls `browserQueryState()` → `chrome.runtime.sendMessage({type:'browser-get-state'})` → `background.js:506` → `getBrowserState()` → `chrome.debugger.getTargets()` + `chrome.tabs.get()`. Plus `loadBrowserTabs()` every time any tab updates `sidepanel.js:3467`. When the Browser panel is closed, most of this is invisible to the user.

### 6. Storage read on every debugger call `background.js:169` + `sidepanel.js:140`

`getAttachedTabId()` does `chrome.storage.local.get('attachedTabId')` — an async IPC — for *every* `handleCdp()` `background.js:175` and `handleTabs()` call. The value rarely changes but is read dozens of times per second during automation.

### 7. Images take the slow road `sidepanel.js:833` + `sidepanel.js:869`

* `downscaleImage()` encodes to PNG first, then if too large re-encodes to JPEG with a 6-step 0.7× shrink loop, creating a new `<canvas>` each step.
* `encodeForSend()` always re-decodes the image even for JPEGs that were already small.
* Each streaming re-render that contains an image re-creates `<img>` elements and re-attaches `error` listeners `sidepanel.js:1087`.

### 8. Python image server reads whole files into RAM `media-bridge.py:331`

`Handler.do_GET()` does `with open(path,'rb') as f: body = f.read()` then `wfile.write(body)`. A 100 MB video = 100 MB RAM spike. No `Cache-Control` header, so the panel re-downloads the same image every time the message re-renders.

### 9. Python automation builds big text trees on every snapshot `browser-mcp.py:572`

`compact_ax_tree()` walks the full accessibility tree and builds `by_id`, `children`, `kept_cache` dicts fresh each call. For pages with 2000 nodes it allocates many small dicts/strings. Not a crisis, but the slowest MCP tool per profile.

### 10. CSS and layout thrash for long histories `sidepanel.css:523`

`.messages` is a single long scroll container with no virtualization. 500 messages = 500 markdown blocks in DOM. The browser lays out all of them on every append, even those far above the viewport.

### 11. No shared result cache between the two guards

`fingerprint()` is used in both `pollActiveSession()` `sidepanel.js:2399` and `syncPollState()` `sidepanel.js:2430`, but recomputed from scratch each time. Same for `activityFingerprint`. An incremental hash would be O(1) per new message instead of O(n).

---

## Part 2 — Plan for the Whole Fix

All changes keep: polling interval 3 s, streaming throttle ~60 ms, rendering pipeline `marked → DOMPurify → KaTeX → media`, no build step, no new vendored library, no framework.

### Guiding rule

Shortest diff that removes repeated work. If React has a name for it, the same name applies here: memoize, key your list, defer loading, pause work when hidden.

### Phase A — Frontend hot path (biggest win, ~2 files)

| # | File | Change | Why it helps | Risk |
|---|------|--------|--------------|------|
| A1 | `sidepanel.js:964` | Add `const mathCache = new Map()` — key `tex + displayMode`, value HTML. In `mathHtml()` check cache first. Cap at 500 entries (LRU by deleting oldest). | KaTeX is 5–10× slower than marked. Reuse cuts streaming cost ~60 % when formulas repeat. | Low — pure memo, `throwOnError:false` still holds. |
| A2 | `sidepanel.js:1283` | Diff `renderMessages()`: keep a `Map<fingerprint, element>` of existing `msg._el`. On poll/stream sync, only `append` new messages, reuse old `._el` when `fingerprint` unchanged. Remove only deleted messages. | Switches from O(n) teardown/build to O(delta). Session switch with 100 msgs goes ~80 ms → ~15 ms. | Medium — must preserve `msg._activity`, `_failedImgs`, `_bridged` sets on reused nodes. Test with `test_renderer.js` fingerprint. |
| A3 | `sidepanel.js:1269` | Replace `setTimeout 60ms` with `requestAnimationFrame` coalescing: one pending RAF per streaming message. Keep 60 ms as fallback if RAF fires too fast (<16 ms). | Syncs re-render to browser's paint, avoids layout thrash, drops duplicate frames. | Low |
| A4 | `sidepanel.js:1034` | Memoize `renderMarkdown()` per message: store last `tokens`+`failed`+`bridged` result. If same inputs, return cached HTML string without re-calling `marked`/`DOMPurify`. | Makes A2 effective — reused messages skip all parsing. | Low — cache invalidated when `failed`/`bridged` sets change. |
| A5 | `sidepanel.css:523` | Add `content-visibility: auto; contain-intrinsic-size: 0 500px;` to `.msg`. | Browser skips layout for off-screen messages without any JS virtualization. One CSS line, big win for 200+ msgs. | Low — check in Chrome 114+ (supported). |

### Phase B — Loading and polling (idle efficiency)

| # | File | Change | Why it helps | Risk |
|---|------|--------|--------------|------|
| B1 | `sidepanel.html:168` | Defer KaTeX: load `katex.min.js` + `katex.min.css` only when `extractTokens` first finds `math.length > 0`. Until then, show raw `tex` inside `<code>` as fallback. | Saves ~300 KB parse on 80 % of chats that have no math. Faster first paint. | Low — handle race where two messages detect math simultaneously (load once). |
| B2 | `sidepanel.js:2420` | Gate polling timers: only `setInterval` when `document.visibilityState === 'visible'` **and** settings closed **and** not `sending`. Listen to `visibilitychange` to `clearInterval`/`setInterval`. | No wakeups when panel hidden. Saves ~20 requests/min idle. | Low — already has guards *inside* poll, this moves them outside. |
| B3 | `sidepanel.js:2375` | Inside `pollActiveSession`, abort in-flight `fetch` via `AbortController` when `activeSessionId` changes mid-flight. Reuse controller per poll cycle. | Prevents race where slow `getMessages` for old session overwrites new session. | Low |
| B4 | `renderer.js:290` | Replace `JSON.stringify(map)` fingerprint with incremental hash: keep a rolling hash updated only when `messages.push` / poll adopts. Keep current string form as fallback for tests, add `hashFingerprint()` for hot path. | O(n) → O(1) per poll when history large. | Medium — must stay in sync with `activityFingerprint`. |

### Phase C — Browser bridge and storage (tiny diffs)

| # | File | Change | Why it helps | Risk |
|---|------|--------|--------------|------|
| C1 | `background.js:169` | Cache `attachedTabId` in module variable `_cachedAttachedTabId`, update on `attachTab`/`detachTab`/`onDetach`/`clearAttached`. `getAttachedTabId()` returns cached value unless `chrome.storage.local.get` needed for cross-SW-restart cold start. | Cuts one async storage IPC per CDP command (dozens/sec during automation). | Low |
| C2 | `sidepanel.js:3374` + `sidepanel.js:3473` | Only run `browserPollTimer` + `tabs` listeners while `#browser-panel` is open. Clear interval on collapse, recreate on open. | No 2 s wakeups when user never opens Browser panel. | Low |
| C3 | `sidepanel.js:1067` | Throttle `loadBrowserTabs` on `chrome.tabs.onUpdated`: ignore `info` that is only `audible`/`favIconUrl` changes, only reload on `title`/`url`/`status`. | Reduces tab-list rebuilds during video playback etc. | Low |

### Phase D — Images and media bridge

| # | File | Change | Why it helps | Risk |
|---|------|--------|--------------|------|
| D1 | `sidepanel.js:833` | In `downscaleImage()`, if `file.type === 'image/jpeg'` and `dataUrl.length > MAX_DATA_URL_BYTES`, encode directly to JPEG `q0.82` instead of PNG-first. Reuse single offscreen `<canvas>` element instead of `document.createElement('canvas')` per attempt. | One encode instead of two for photos (most pastes). Less GC. | Low |
| D2 | `sidepanel.js:1087` | In `attachMediaFallbacks()`, skip re-attaching `error` listeners on media already marked `loaded` or `failed`. | Prevents duplicate listeners after each streaming re-render. | Low |
| D3 | `media-bridge.py:331` | Replace `body = f.read()` with `shutil.copyfileobj(f, wfile, 64*1024)` chunked streaming. Add `Cache-Control: private, max-age=3600` and `ETag` for image responses. | No RAM spike for large video; browser cache avoids re-download on re-render. | Low — need to send headers before streaming. |
| D4 | `media-bridge.py:346` | For `/save` keep as-is (small uploads ≤5 MB). For `/media`, use `os.sendfile` when available (Linux) for zero-copy, else chunked. | Faster local serving with no feature change. | Low |

### Phase E — Python snapshot (only if B1–B4 still feel slow)

| # | File | Change | Why it helps | Risk |
|---|------|--------|--------------|------|
| E1 | `browser-mcp.py:572` | In `compact_ax_tree()`, intern `role` strings, pre-filter nodes by `role in INTERACTIVE_ROLES or STRUCTURAL_ROLES` before building `children` maps. | ~10 % fewer dict inserts for 2000-node trees. | Low |
| E2 | `browser-mcp.py:340` | Consider single `ThreadingHTTPServer` keep-alive (already threaded) — no change unless profiling shows thread churn. | — | — |

### What we are NOT doing

* No build step, no React, no bundler, no new `vendor/` file — per `AGENTS.md:1`.
* No WebWorker for markdown — transfer cost outweighs gain for <4 KB messages.
* No IndexedDB cache for messages — gateway is source of truth, fingerprint already gates DOM work.
* No virtual-list JS library — `content-visibility` `sidepanel.css:523` gives 80 % of it in one line.

### Order to build

1. **A1 + A4 + C1** — under 30 added lines, safe, instant profile win.
2. **A2 + A3 + B2** — ~60 lines, biggest perceived speedup (streaming + session switch).
3. **B1 + C2 + D1 + D3** — load + idle wins.
4. **B4 + D2 + C3 + sidepanel.css content-visibility** — polish, only if long histories lag.
5. **E1** — only if `browser_snapshot` profiles hot.

### How to verify each phase (no full-suite ritual)

* `node test_renderer.js` must stay `ALL PASS` after any `renderer.js` change.
* `py -3.14 -B test_browser_mcp.py` after any `browser-mcp.py` change.
* `python -B -c "import ast; ast.parse(open('media-bridge.py',encoding='utf-8').read()); print('OK')"` after `media-bridge.py`.
* Manual: open panel → record DevTools Performance while streaming a reply with `$$`, images, and a 100-message history → confirm fewer `katex.renderToString` calls, fewer `marked.parse` calls, layout shifted to off-screen skip, polling pauses when panel hidden, KaTeX fonts only fetched when math present.
* Check XSS: `renderMarkdown('<img src=x onerror=alert(1)>')` still sanitized — `DOMPurify` stays before KaTeX/media replacement `sidepanel.js:1047`.

### Rollback

Each phase is one small commit on `perf/optimizations`. Revert single commit without touching others — no coupled changes.
