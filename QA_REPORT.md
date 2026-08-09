# QA_REPORT — Hermes Minimal (markdown / math / images / live updates)

Scope: single commit `0b4f1df` ("feat: markdown/math/image rendering and live updates"). Methods used: `node --check` on all JS, `node test_renderer.js`, reading the full implementation (sidepanel.js 861 lines, renderer.js, test_renderer.js, css/html/manifest/README), node probes of `extractTokens` edge cases, vendor-file integrity checks (version banners, 60/60 CSS font refs resolve, all pinned URLs real). No browser session was available; DOM behavior (DOMPurify/KaTeX/marked integration, T7 CSP check) was verified by static analysis only.

## Requirement-by-requirement verdicts

### R1 Markdown rendering — VERIFIED
Pipeline (sidepanel.js:370–391): `renderer.extractTokens` → `marked.parse(scrubbed, {gfm:true, breaks:true})` → `DOMPurify.sanitize` → sentinel replacement. GFM tables, task lists, fences, blockquotes all styled in sidepanel.css:316–401. Applied to **all** messages (user, assistant, error, `(empty reply)`) via `renderMessageBody` (sidepanel.js:418). `node --check` clean; 39/39 unit tests pass.

### R2 LaTeX math — VERIFIED
`$…$` / `\(…\)` inline, `$$…$$` / `\[…\]` display, escaped `\$` and no-space-around-`$` heuristics correctly implemented (renderer.js:47–93) — the CRITIQUE #1 regex/prose mismatch is fixed and pinned by tests (test_renderer.js:116–134). KaTeX 0.16.11 vendored (version banner verified), `renderToString` with `throwOnError:false, displayMode, output:'html'` (sidepanel.js:346–358). Known limitation (math inside backtick code spans) documented and pinned as a test. Two minor edge bugs found — see BUG-2, BUG-3.

### R3 IMAGE:/image:/MEDIA: lines — VERIFIED (with doc gap)
Fence-aware AND 4-space-indented-code-aware pass-1 (renderer.js:115–192) — CRITIQUE #3 fixed and tested. Case-insensitive regex (CRITIQUE #2 fixed). Windows/POSIX/http URL normalization + `#`/space encoding in `mediaUrl` (renderer.js:199–212). Post-sanitize `<img>` construction with escaped attrs; `error`-listener fallback to a clickable path link; failed indices cached per message so streaming re-renders don't churn (CRITIQUE #11 fixed). Blockquote/list-prefixed lines deliberately left literal (pinned test).
**Gap:** the README never documents the required "Allow access to file URLs" toggle (see BUG-4) — without it, images silently degrade to fallback links.

### R4 Live updates — VERIFIED
3 s polling (sidepanel.js:507–554) with guards: apiKey, active session, `sending`, `visibilityState`, settings-closed, `pollInFlight`. Two-stage design: `listSessions` count compare (null count → always fetch, CRITIQUE #6 fixed) → fingerprint-gated full fetch. CRITIQUE #4/#7 fixed (adoption-time re-checks of `activeSessionId` + `sending`). CRITIQUE #5 fixed (6 s post-stream quiet period + 30 s stale-limit so a just-streamed message never blinks out; stopped-stream tradeoff documented in code). Deleted-session 404 → banner (CRITIQUE #20 fixed). `syncPollState` seeds fingerprint/count at boot, session select, and stream end (sidepanel.js:565–570).

### XSS mandate — VERIFIED (static)
Every message body flows through DOMPurify (default config) **before** any self-built HTML; media/math tags are constructed after sanitization with `escapeHtml`-escaped attributes; KaTeX output is trusted-by-construction (no `eval`/`new Function` in the vendored 0.16.11 build — verified against the dist). `src`/`href` values can only ever be `file:`/`http(s)` or escaped raw text. No script vector found. One integrity (non-execution) edge: BUG-3.

### Streaming performance — PARTIAL
Throttle (60 ms trailing, sidepanel.js:430–433) + scope-to-last-message are correct; completion flushes synchronously. **But** autoscroll is never invoked from the streaming path — see BUG-1 (MAJOR regression vs the pre-change behavior).

## Bugs found

- **BUG-1 (MAJOR) — no autoscroll while streaming.** `scrollToBottomIfNear` (sidepanel.js:435) is called only from `renderMessages()` (line 458); the streaming path (`scheduleStreamingRender` → `renderMessageBody`, lines 430–433/418) never calls it. The old code scrolled on every delta; now a reply longer than the viewport streams invisibly below the fold (caret included) and only jumps into view on completion. Repro: open panel at bottom, ask for a multi-screen answer → panel stays frozen while text accumulates off-screen. The `|| sending` clause in `scrollToBottomIfNear` is dead code. Fix: call it from `renderMessageBody` (or in `scheduleStreamingRender`).
- **BUG-2 (MINOR) — display math swallows inline math on the same line.** Verified: `text $$a$$ and $b$ here` → `$b$` left as literal text (line contains a `⟦` sentinel after the block pass, so the inline scan is skipped, renderer.js:142). Same for `$x$ and $$y$$`. Fix: run the inline scan before/independently of block replacement, or scan inline on the residual text per line.
- **BUG-3 (MINOR) — math inside a markdown link destination injects KaTeX HTML into the `href` attribute.** `[x]($y$)` → sentinel lands in the destination → after replacement the attribute becomes attribute soup (`<a href="<span class="katex">…">`). No script execution possible (KaTeX never emits event-handler attributes; browser reparses the rest as child elements), so this is an integrity/rendering issue, not an XSS hole. Fix options: accept + document, or exempt link destinations via a `walkTokens` pass.
- **BUG-4 (MAJOR) — README not updated at all.** The brief-mandated "Allow access to file URLs" install step (required for R3 to work at all), the features-table flips, the layout entries for `renderer.js`/`vendor/`/`test_renderer.js`, and the rendering/polling-behavior section are all absent. README still claims "the entire client is one ~450-line file" (now 861 lines). New users' images will silently render as path links.

## CRITIQUE.md findings — resolution status

| # | Finding | Status |
|---|---|---|
| 1 | Math regex vs prose guards | FIXED — `isEscaped`/`validInline`, tests pin behavior |
| 2 | Media regex not case-insensitive | FIXED — `/i` flag, all 5 variants tested |
| 3 | IMAGE inside indented code | FIXED — indented-code state machine, tested |
| 4 | Session-switch adoption race | FIXED — `sid` captured + re-checked at adoption |
| 5 | Post-stream flicker (server lag) | FIXED — 6 s quiet period + 30 s stale-limit |
| 6 | `message_count` null never triggers | FIXED — null → always fetch |
| 7 | Poll fetch vs stream start | FIXED — `sending` re-checked at adoption |
| 8 | lastSeenCount write point / wasted fetch | FIXED — written in stage 1; `syncPollState` seeds state |
| 9 | Font formats/count | FIXED — all 60 files vendored, 60/60 CSS refs resolve |
| 10 | IMAGE in blockquote/list | RESOLVED as decided — stays literal, pinned test |
| 11 | Failed-image churn while streaming | FIXED — per-message `_failedImgs` set |
| 12 | Scroll behavior under-specified | **PARTIAL** — function exists but never wired into the streaming path (BUG-1) |
| 13 | `test_renderer.js` missing from change list | FIXED — present, 39/39 pass |
| 14 | Fixture dependency for T4 | PARTIAL — synthetic unit coverage good; no DOM end-to-end harness |
| 15–19 | NITs (innerHTML claim, `$$` mid-line, KaTeX flash, bare URLs, media-vs-math priority) | #16/#19 FIXED + pinned; #18 bare-URL images unaddressed (only `![]()` renders — brief wording ambiguous, minor); #15/#17 acceptable as-is |
| 20 | Deleted session → silent stale view | FIXED — banner + poll stop |

No CRITIQUE.md BLOCKERS existed; all MAJORs are resolved except #12 (partial).

## Verdict: **SHIP-WITH-FIXES**

Fix list (in order):
1. **BUG-1:** call `scrollToBottomIfNear()` from the streaming render path (one line) — restores live streaming UX.
2. **BUG-4:** update README — "Allow access to file URLs" install step, features table, layout entries, rendering/polling section, correct the file-size claim.
3. **BUG-2 / BUG-3:** fix display-math-swallows-inline-math (per-line scan order); document or exempt math-in-link-destination (no security impact, but renders as attribute soup).

Everything else — R1/R2/R3/R4, XSS posture, polling reconciliation, vendored assets — verified sound.
