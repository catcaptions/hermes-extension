# CRITIQUE — PLAN.md (Hermes Minimal: Markdown / Math / Images / Live Updates)

Reviewer: senior engineering red team. Scope: PLAN.md against TASK_BRIEF.md, with spot-checks of the actual repo (sidepanel.js, sidepanel.html, sidepanel.css, manifest.json, README.md) and of the pinned vendor URLs. No source files were modified.

## A. Verified claims (checked, not assumed)

| Plan claim | Verdict |
|---|---|
| `marked@12.0.2`, `dompurify@3.1.6`, `katex@0.16.11` js+css URLs exist and are pinning-able | ✅ All four jsdelivr URLs return HTTP 200 |
| "KaTeX 0.16 default builds are CSP-safe (no `unsafe-eval`)" | ✅ **Verified against the actual dist file**: `katex.min.js` 0.16.11 contains zero `eval(` / `new Function` / `Function(` occurrences. (MV3 extension pages may not use `unsafe-eval` at all, so this was the highest-risk claim in the plan — it holds. T7 is still worth keeping as a regression check.) |
| KaTeX CSS references fonts relatively (`fonts/…`) so the `vendor/katex/fonts/` layout is required | ✅ Verified; the vendored layout requirement is correct |
| MV3 default CSP is `script-src 'self'` (no `style-src` restriction) → KaTeX's inline-style output is fine; no manifest CSP change needed | ✅ Correct. Also correct that `file:` images need only the user-side "Allow access to file URLs" toggle, not a manifest permission |
| "No `file:` URI ever passes through DOMPurify" | ✅ Sound — and note DOMPurify's default allowlist strips `file:`/`data:` URI schemes anyway, so the post-sanitize construction of `<img>`/`<a>` is not just safe, it is *required* for `file:///` images to survive at all |
| Line refs (sidepanel.js:320/332/312/509/408/396/623, css:310/318/326) | ✅ All accurate |
| Sanitize-after-markdown, KaTeX-after-sanitize ordering | ✅ Correct and standard; no remaining XSS hole found in the pipeline as designed (LLM content, user content, error bodies, `(empty reply)` all flow through the sanitizer) |

## B. Findings

### 1. MAJOR — §2.2/§2.4 (`renderer.js`): the math regexes do not implement the guarantees the prose promises
Prose claims an escaped-`$` guard ("`(?<!\\)` guard") and "no-space-around-`$` heuristics"; the regex as written has neither: `/\$((?:[^$\n\\]|\\.)+?)\$/g`.
- `price \$5 and $x$` → the escaped `$` *opens* a span, rendering math `5 and` and leaving `x` + a stray `$` as text.
- `$5 and $10` → renders math `5 and` (a sentence about money becomes garbage math).
Both are realistic in LLM chat output and directly corrupt requirement #2.
**Fix:** make the code match the prose — `/(?<!\\)\$((?:[^$\n\\]|\\.)+?)\$([^\w$])/g`-style guard (or consume `\$` in the same pass), and decide the no-space rule explicitly. Encode both cases as T1 fixtures *before* writing the implementation.

### 2. MAJOR — §2.4: media regex is not case-insensitive despite the claim
`/^\s*(?:IMAGE|image|MEDIA)\s*:\s*(.+?)\s*$/` has no `i` flag. The brief's verified variants (`IMAGE:`, `image:`, `MEDIA:`) do match, but `media:`/`Media:` do not, and the prose ("case-insensitive covers `image:`") is false as written.
**Fix:** add the `i` flag (or enumerate variants) and fix the prose. Add `media:` to T1.

### 3. MAJOR — §2.3/§5: "IMAGE: inside code blocks" is only handled for *fenced* code
The pass-1 scanner tracks fences only. The regex accepts arbitrary leading whitespace (`^\s*`), so a 4-space-indented `IMAGE:C:\…` line inside an **indented code block** — common in LLM output — is extracted and rendered as an image, violating requirement #5 ("only text lines outside code"). The plan's §5 claim ("media lines … inside fences are left untouched" — fences, not code blocks generally) overstates coverage.
**Fix:** track indented-code state (≥4 leading spaces at top level, per GFM) or refuse `\s*` beyond line-leading; add an indented-code case to T1.

### 4. MAJOR — §2.5: session-switch race is unguarded at adoption time
`pollActiveSession()` checks `activeSessionId` only at tick start. `selectSession()` is async; a poll fetch for session A that resolves *after* the user switched to session B will adopt A's messages into B's view. The critique brief's "session switching race conditions" concern is real and unaddressed.
**Fix:** capture `const sid = activeSessionId` at tick start and abandon the fetch at adoption if `activeSessionId !== sid`. Same guard should also re-check `sending` (a stream can start while the poll fetch is in flight) — see #7.

### 5. MAJOR — §2.5: "server copy is authoritative and byte-identical" is a timing assumption
After a local stream, `lastFingerprint = fingerprint(messages)` is set from *local* state, but the plan never verifies the gateway persists the message before/at `run.completed`. If persistence lags, the next poll fetches a server copy missing the just-finished message → fingerprint differs → adoption **drops the message the user just watched stream in**, then a later tick re-adds it (visible blink-out-and-back, right after every turn).
**Fix:** verify persist timing in T8; if it lags, use a quiet period (skip adoption for ~2 ticks after stream end) or prefix/superset adoption (adopt only if server copy is a superset/prefix of local). Do not rely on "byte-identical" without a test.

### 6. MINOR — §2.5: `message_count` null/non-numeric never triggers the fetch stage
The cheap stage only fetches when a count *differs*; a row with a null/missing count (or the "count changed but content identical" miss window) means live updates silently stop, unless the row falls out of the top-50 fallback. The plan's own risk table concedes the semantics are unverified.
**Fix:** `typeof count !== 'number'` → treat as changed (always fetch). Keep the fingerprint gate as the real guard.

### 7. MINOR — §2.5: `pollInFlight` guard is tick-start-only; adoption can clobber a stream that starts mid-fetch
Guards are checked at tick start, but the adoption (`messages = serverMsgs; renderMessages()`) happens later. If the user hits Send while the poll fetch is in flight, the adoption overwrites the freshly appended user+assistant bubbles.
**Fix:** re-check `sending === false` (and `activeSessionId`, per #4) immediately before adoption.

### 8. MINOR — §2.5: `lastSeenCount` write-point is ambiguous; first tick always wastes a fetch
The prose says it's "only written on success" but never says which stage writes it; if only the fetch stage writes it, the list stage's compare is useless and every tick does a full messages fetch. Also boot()/selectSession() leave `lastSeenCount = null` with history already loaded → first tick does a needless full fetch (harmless render-wise only because the fingerprint gate is equal — but it is still a wasted request every session switch/boot).
**Fix:** write `lastSeenCount` from the list stage on success; seed `lastFingerprint` at the end of selectSession/boot history load.

### 9. MINOR — §2.1: KaTeX font inventory is wrong; CSS references woff2 **and** woff **and** ttf
Verified: `katex.min.css` has 20 `@font-face` blocks × 3 formats = 60 files (`woff2`+`woff`+`ttf`), not "~70 woff2". If the implementer follows the plan literally and vendors only woff2, the woff/ttf rules 404 (harmless in Chrome 114+, but the T5 devtools check will flag it).
**Fix:** vendor the whole `dist/fonts/` directory (all formats) and fix the count in the plan; the `(whole dir)` parenthetical already implies this.

### 10. MINOR — §2.4: `IMAGE:`/`MEDIA:` lines inside blockquotes or list items are silently unhandled
`> IMAGE:C:\…` and `- IMAGE:C:\…` don't match the line-anchored regex and are not mentioned anywhere in the plan. The brief's verified examples are standalone lines, so this is acceptable for v1 — but it must be a *decision*, not an accident.
**Fix:** state it in §5 (with the reasoning: Hermes emits these as standalone lines) or strip leading `> ` / `- ` markers before the scan. Either way, add a T1 case so the behavior is pinned.

### 11. MINOR — §4/§2.3: failed-image churn during streaming
Each 60 ms re-render rebuilds the `<img>` elements; with "Allow access to file URLs" off, every rebuild fires a fresh `error` event and swap — dozens of failed loads per streamed message, plus a flickering img↔link toggle.
**Fix:** keep a per-message `Set` of failed indices in `renderMessageBody`/`attachMediaFallbacks` and render the fallback anchor directly for known-failed indices instead of re-attaching listeners.

### 12. MINOR — §3 (sidepanel.js): scroll behavior after the change is under-specified
`renderMessages()` today force-scrolls to bottom (sidepanel.js:335). The plan adds `scrollToBottomIfNear()` but never says *which callers* use it. If poll-adoption and full rebuilds keep the unconditional scroll, the plan's own goal ("polling updates must not yank the viewport") fails.
**Fix:** state explicitly: `renderMessages()` → `scrollToBottomIfNear()`; streaming path → autoscroll while streaming.

### 13. MINOR — §3: `test_renderer.js` is missing from the change list
It appears in §6 (T1) and the README layout section, but §3 "Precise change list per file" never lists it. An implementer working from §3 alone will skip the only automated tests.
**Fix:** add `test_renderer.js` (new file) to §3.

### 14. MINOR — §6/T4: fixture depends on live desktop content
T3/T4 assume a real desktop session containing `IMAGE:` lines; if none exists, requirement #3's acceptance test can't run.
**Fix:** also synthesize a fixture (a `node test_renderer.js` case plus a temporary session with a pasted sample) so the test doesn't depend on the user's actual history.

### 15. NIT — §2.3: "No `innerHTML` anywhere except step ④" is false
`renderMessages()` still uses `innerHTML` for the message shell (role label + body container, escaped content — safe, but the claim is inaccurate). Minor auditability sloppiness; fix the sentence.

### 16. NIT — §2.2/§2.4: `$$…$$` mid-line renders as `$` + math + `$`
Block math is line-anchored, so `text $$x$$ text` falls to the inline regex, which eats `$x$` and leaves stray `$`s. Fine to keep, but it's undocumented behavior; the brief's examples are standalone-line display math, so add a T1 case and a sentence.

### 17. NIT — §4: malformed-but-closed math flashes red mid-stream
A temporarily-malformed `$e^$` mid-stream renders a KaTeX error span (throwOnError:false) that corrects on the next delta. Cosmetic, inherent to streaming; acceptable — just note it so it isn't "fixed" by throwing.

### 18. NIT — §3/§2.4: bare `http(s)` image URLs without `![]()` syntax won't render
Requirement #3's "plain `http(s)` image URLs in markdown should also render" only works for standard `![alt](url)` syntax (marked doesn't autolink bare URLs into images). Confirm against a T3 fixture whether the gateway ever emits bare URLs; if it does, decide (accept `![]()`-only or add a tiny link-extension pass). Not blocking.

### 19. NIT — §5: media-vs-math scan priority per line is unspecified
A line like `IMAGE:C:\$$x$$.png` — media value taken verbatim (good), but the plan never states the per-line ordering. One sentence fixes it.

### 20. NIT — §2.5: poll errors are swallowed, but a 404 on a deleted active session leaves the panel stuck
If the active session is deleted server-side, every tick 404s silently and the panel shows stale content with a healthy badge. Out of scope for v1, but a "session deleted → show stale-session banner" hint would cost ~3 lines. Optional.

## C. Verdict

**APPROVE-WITH-CHANGES.** Architecture is right (vendored marked+DOMPurify+KaTeX, sanitize-after-parse, post-sanitize media/math construction, fence-aware pass 1, cheap 2-stage polling with fingerprint gating, scoped+throttled streaming renders, no manifest change). The risky claims I could verify from outside — KaTeX CSP-safety, vendor URL pins, relative font paths, MV3 CSP/permission posture — all check out. All findings above are fixable in the implementation phase; none invalidates the design. The three that must not be blown off are:

1. **Make the math/media regexes actually implement the documented guards** (escaped `\$`, no-space `$` heuristics, case-insensitive `IMAGE|MEDIA` variants) — encode each as a `test_renderer.js` case *first*.
2. **Extend the pass-1 scanner to indented (4-space) code blocks**, not just fences, so `IMAGE:`/math inside *any* code block stays literal (requirement #5).
3. **Guard poll adoption at adoption-time** (re-check `activeSessionId` + `sending`) and **do not assume server persistence is synchronous with `run.completed`** — verify in T8 and add a quiet period or superset-adoption so a just-streamed message never blinks out.
