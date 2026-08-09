# PLAN — Hermes Minimal Extension Fix (Markdown / Math / Images / Live Updates)

## 1. Problem analysis

All four bugs share one root cause: **there is no render pipeline**. `renderMessages()` (sidepanel.js:320) writes every message body with `div.innerHTML = ... escapeHtml(msg.content) ...` (sidepanel.js:332), which HTML-escapes assistant output into a plain-text `pre-wrap` div. Consequences:

1. **Markdown never renders** — `*bold*`, `## headers`, tables, fences etc. all show as raw escaped text.
2. **LaTeX never renders** — `$...$` / `$$...$$` are just characters.
3. **`IMAGE:` lines never become images** — they render as escaped text lines (the escapeHtml pass also mangles Windows backslashes visually, but that's cosmetic).
4. **No live updates** — the panel fetches history only on session select / boot; the gateway has no server-push endpoint for arbitrary sessions, so nothing notices new messages written by the desktop app.

Secondary issue: `onAssistant` calls `renderMessages()` on **every** SSE delta (sidepanel.js:509–511), rebuilding the entire DOM list per token. With a markdown+KaTeX pipeline this becomes O(history × tokens) per token — unacceptably laggy. The renderer must be throttled and scoped to the streaming message only.

Constraints that shape the fix: MV3 CSP (`script-src 'self'`) forbids CDN scripts at runtime → markdown/math libraries must be **vendored locally**; a `chrome-extension://` page can read `file://` images only when the user enables **"Allow access to file URLs"** (user toggle, not a manifest permission) → graceful fallback required.

## 2. Chosen architecture

### 2.1 Markdown: vendored **marked** + **DOMPurify** (not hand-rolled)

Vendor `marked` (GFM tables/task lists out of the box, tiny, MIT, no deps) and `DOMPurify` (the mandatory XSS sanitizer). Hand-rolling a markdown parser is exactly the wrong trade here: GFM tables + task lists + nesting edge cases are precisely where hand-rolled parsers break, and the security requirement ("Never inject raw HTML") makes a sanitizer non-negotiable anyway.

| File to vendor | Version | Source URL (pinned) |
|---|---|---|
| `vendor/marked.min.js` | marked **12.0.2** | `https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js` |
| `vendor/dompurify.min.js` | DOMPurify **3.1.6** | `https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.min.js` |
| `vendor/katex/katex.min.js` | KaTeX **0.16.11** | `https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js` |
| `vendor/katex/katex.min.css` | KaTeX **0.16.11** | `https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css` |
| `vendor/katex/fonts/**` (~70 woff2 files) | KaTeX **0.16.11** | `https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/fonts/` (whole dir) |

Notes: all three are UMD, expose globals (`marked`, `DOMPurify`, `katex`) — no import/build needed. KaTeX `katex.min.css` references fonts **relatively** (`fonts/…`), so the vendored layout must keep `vendor/katex/fonts/` next to the css. KaTeX 0.16 default builds are CSP-safe (no `unsafe-eval`); verify at runtime (test step T7). marked@12 is the last line with the simple stable `marked.parse()` + GFM defaults; newer major versions churned defaults/APIs — pin 12.0.2. DOMPurify 3.x is the current major. Download with `curl -L` in a later (implementation) phase; commit the files (licenses: marked/DOMPurify MIT, KaTeX MIT — note them in README).

### 2.2 Math: vendored **KaTeX**

Real LaTeX typesetting (fractions, sums, Greek, align) is not feasible by hand — KaTeX is the smallest high-quality renderer. It runs fully client-side from local files, which satisfies the CSP constraint. Rendering mode: `katex.renderToString(tex, { throwOnError: false, output: 'html' })` for both inline (`$…$`/`\(…\)`) and display (`$$…$$`/`\[…\]`) math. `throwOnError: false` guarantees malformed/partial math never throws or breaks the DOM — it renders a red error span instead.

### 2.3 Rendering pipeline (one function, two extension points)

```
raw content
  │
  ▼ ① PASS 1 — fence-aware scan (renderer.js: pure functions, no DOM)
  │     · track fenced-code state line by line
  │     · outside fences only:
  │        - IMAGE:/image:/MEDIA: lines  → replaced by sentinel token ⟦HIMG:<i>⟧
  │        - block math $$…$$ / \[…\]    → replaced by ⟦HMTH:<i>⟧
  │        - inline math $…$ / \(…\)     → replaced by ⟦HMTH:<i>⟧
  │
  ▼ ② marked.parse(scrubbed, { gfm: true, breaks: true })
  │
  ▼ ③ DOMPurify.sanitize(html)   ← default config; file: NOT allowlisted here
  │
  ▼ ④ string-replace ⟦HMTH:<i>⟧ → katex.renderToString(...)  (trusted output)
  │     string-replace ⟦HIMG:<i>⟧ → <img class="hm-img" data-hm-idx="i" src="file:///…|http(s)…" alt="…">  (own construction, attr-escaped)
  │
  ▼ ⑤ caller sets el.innerHTML, then attachMediaFallbacks(el)
  │     · querySelectorAll('[data-hm-idx]') → img.addEventListener('error', …)
  │     · on error: replace img with <a class="hm-img-fallback" href="file:///…">original path text</a>
```

Design rules that make this safe:

- **No `file:` URI ever passes through DOMPurify.** Media `<img>` tags are constructed by us, after sanitization, with attribute values passed through `escapeHtml()` (sidepanel.js:312) — an LLM-supplied path can only end up as a `file:`/`http(s):` URL, never an executable attribute. `javascript:` etc. is structurally impossible in the constructed tag.
- **Sentinel tokens** are plain text (`⟦HIMG:0⟧`, `⟦HMTH:0⟧`), survive marked and DOMPurify untouched, and are replaced by string ops on the sanitized HTML. A per-render random nonce is folded into the sentinel prefix to defeat the (astronomically unlikely) case where user content contains the literal token.
- **KaTeX output is inserted after sanitization** — KaTeX escapes all input by construction and is a widely-trusted vector; standard practice.
- **Inline `onerror=` attributes are impossible anyway** under MV3 CSP — the error fallback is attached via `addEventListener` in step ⑤, not an attribute.

### 2.4 Media path normalization (`mediaUrl(path)` in renderer.js)

| Input | Output |
|---|---|
| `C:\Users\lasis\...\composer.png` (Windows drive) | `file:///C:/Users/lasis/.../composer.png` (`\` → `/`, prefix `file:///`) |
| `/home/u/.hermes/.../x.png` (POSIX abs) | `file:///home/u/.hermes/.../x.png` |
| `http(s)://…` | unchanged |
| anything else (relative, UNC, empty) | `null` → render as plain-text fallback link (no img) |

URL-encode with `encodeURI` plus `%23` for `#` (encodeURI leaves `#` unescaped, which would truncate the URL). Spaces/parens in Windows paths are handled by encoding; a literal `%` in a filename double-encodes — accepted edge case. The fallback `<a>` shows the **original raw path** (unencoded) as text so users can copy it; `href` uses the encoded file URL.

### 2.5 Live updates: client-side polling (the only option)

The gateway has **no** SSE endpoint for watching arbitrary sessions (only `/v1/runs/{id}/events` for runs the extension doesn't create). So: cheap polling, gated hard, fingerprint-reconciled.

**Design:**

- Interval `POLL_INTERVAL_MS = 3000` (within the brief's 2–5 s band), started at boot, one `setInterval`.
- Every tick, `pollActiveSession()` runs only when **all** guards pass:
  - `settings.apiKey` set, `activeSessionId` non-empty
  - `sending === false` (a local stream owns the DOM; polling during it could clobber the streaming bubble)
  - `document.visibilityState === 'visible'` (panel open; also Chrome throttles hidden-tab timers anyway)
  - settings panel closed (messages are hidden there; no point)
  - no poll already in flight (`pollInFlight` re-entrancy guard)
- **Cheap stage:** `listSessions()` (the existing 50-row call). Find the active session's row → compare `row.message_count` against `lastSeenCount`.
  - If the active session is **not** in the top-50 list (old session scrolled out of recency), fall back to skipping stage 1 and fetching messages directly each tick.
- **Fetch stage** (only when count changed / row missing): `getMessages(activeSessionId)` → compute `fingerprint(msgs)` = `JSON.stringify(msgs.map(m => m.role + '\0' + m.content))`.
  - `fingerprint !== lastFingerprint` → `messages = serverMsgs; lastFingerprint = fp; renderMessages();`
  - equal → no DOM work (guards against `message_count` semantics being noisy/unknown).
- Errors are swallowed silently per tick (gateway down → the connection badge already reports that; polling must not spam the banner). `lastSeenCount` is only written on success.
- `document.visibilitychange` → when visible, run an immediate poll (so reopening the panel shows desktop messages right away instead of waiting up to 3 s).
- Poll state resets (`lastSeenCount = null; lastFingerprint = null`) in `selectSession()` / `beginNewChat()`. After a local stream finishes, `lastFingerprint` is set from the local final state so the next tick doesn't do a pointless reconcile.

Reconciliation rule is deliberately brutal and simple: **server copy wins whenever not streaming.** Post-stream, the server copy is authoritative and byte-identical to what the panel showed (same `normalizeMessage` on both paths). There is no local-only state that polling can destroy — guarded by `sending === false`.

## 3. Precise change list per file

### `vendor/` (new files — download in implementation phase)

- `vendor/marked.min.js` — marked 12.0.2 (URL above)
- `vendor/dompurify.min.js` — DOMPurify 3.1.6 (URL above)
- `vendor/katex/katex.min.js`, `vendor/katex/katex.min.css`, `vendor/katex/fonts/**` — KaTeX 0.16.11 (URLs above)

### `sidepanel.html`

- `<head>`: add `<link rel="stylesheet" href="vendor/katex/katex.min.css" />` (after `sidepanel.css`).
- Before `<script src="sidepanel.js" type="module">`: add three classic `<script>` tags — `vendor/dompurify.min.js`, `vendor/marked.min.js`, `vendor/katex/katex.min.js` (order between them irrelevant; classic scripts execute during parse, module script runs after parsing → globals guaranteed available).
- **No other markup changes.**

### `renderer.js` (new file — pure, DOM-free, shared with node tests)

All non-trivial string/parsing logic lives here so it's unit-testable with plain node. Exposes via `globalThis.renderer` + `module.exports` guard (5-line UMD shim).

- `extractTokens(text)` → `{ scrubbed, math[], media[] }` — the fence-aware pass-1 scan:
  - Line state machine for fenced code (``` and ~~~, any language, no fence inside fence — standard rules: opening fence is ≥3 backticks/tildes, closes on a line with ≥ the same char and only trailing spaces).
  - Media line regex: `/^\s*(?:IMAGE|image|MEDIA)\s*:\s*(.+?)\s*$/` (case-insensitive covers `image:`; kept explicit per brief) — only outside fences. Whole-line value taken verbatim (paths may contain spaces).
  - Block math: `/^\s*\$\$[\s\S]*?\$\$\s*$/m` and `/^\s*\\\[[\s\S]*?\\\]\s*$/m`, matched **before** inline.
  - Inline math: `/\$((?:[^$\n\\]|\\.)+?)\$/g` and `/\\\(((?:[^\\]|\\.)+?)\\\)/g` — no-space-around-`$` heuristics; escaped `\$` left alone (`(?<!\\)` guard). Applied per line outside fences.
  - `ponytail:` limitation — `$` inside a backtick code span can be misread as math (same limitation as markdown-it-katex etc.). Refinement path if it ever bites: marked `walkTokens` to exempt `codespan` tokens; not needed for v1.
- `mediaUrl(path)` → normalized `file:///…` / `http(s)://…` / `null` per §2.4.
- `fingerprint(msgs)` → stable string per §2.5.
- Each extraction returns ordered arrays whose indices match the `⟦TOK:<i>⟧` sentinels (indices, not content, are embedded → no string-content assumptions).

### `sidepanel.js`

| Area | Change |
|---|---|
| Header constants | Add `POLL_INTERVAL_MS = 3000`, `STREAM_RENDER_MS = 60`, sentinel builder with per-render nonce. |
| New state | `lastSeenCount`, `lastFingerprint`, `pollTimer`, `pollInFlight`, `streamTimer`. |
| New `renderMarkdown(text)` | pipeline §2.3 steps ①–④ → sanitized HTML string. Uses `marked.parse`, `DOMPurify.sanitize`, `katex.renderToString`; `breaks: true` (single `\n` → `<br>`, chat-appropriate; double-newline still makes `<p>`). |
| New `renderMessageBody(msg)` | renders **one** message's `.msg-body` (markdown pipeline + `attachMediaFallbacks`) from `msg.content`; used by both full rebuild and streaming. Sets `msg._el` on first build. |
| New `attachMediaFallbacks(scope)` | `querySelectorAll('[data-hm-idx]')` → `addEventListener('error')` → swap to `.hm-img-fallback` anchor (raw path as text). |
| New `scheduleStreamingRender(msg)` | `clearTimeout(streamTimer); streamTimer = setTimeout(() => renderMessageBody(msg), STREAM_RENDER_MS)` — trailing-edge throttle for deltas. |
| New `scrollToBottomIfNear()` | autoscroll only when user is near bottom (threshold ~40 px) or the last message is streaming — polling updates must not yank the viewport while the user reads history. |
| **Change** `renderMessages()` (:320) | keep overall structure + empty-state handling + role labels (still `escapeHtml`-escaped), but per message: build the `.msg` shell once, store `msg._el`, populate `.msg-body` via `renderMessageBody` instead of `escapeHtml` inline-HTML. Streaming class on `.msg` stays. |
| **Change** `onAssistant` path in `sendMessage()` (:509) | replace `renderMessages()` with `scheduleStreamingRender(assistantMsg)`. On final completion (:514–516): clear timer, `renderMessageBody(assistantMsg)` synchronously, then `lastFingerprint = fingerprint(messages)`. |
| **Change** `selectSession()` (:408) | after load: `lastSeenCount = rowCountUnknown` (set from list at next poll — simply reset `lastSeenCount = null; lastFingerprint = fingerprint(messages)`); no other changes. |
| **Change** `beginNewChat()` (:396) | reset `lastSeenCount = null; lastFingerprint = null`. |
| **Change** `boot()` (:623) | after loadSettings: `pollTimer = setInterval(pollActiveSession, POLL_INTERVAL_MS)`; add `document.addEventListener('visibilitychange', …)` → immediate poll when visible. |
| New `pollActiveSession()` | §2.5 — guards, cheap stage (listSessions → count compare), fetch stage (getMessages → fingerprint → reconcile), silent error handling, `pollInFlight` guard. |
| **Change** `escapeHtml()` (:312) | unchanged — still used for role labels, session titles, dropdown rows, and attr-escapes inside our own constructed `<img>`/`<a>` tags. |
| **Unchanged** | `readHermesSse`, `parseSseBlock`, `reduceAssistantText`, `normalizeMessage`, HTTP client, settings, session list, connection badge. |

### `sidepanel.css`

- `.msg-body` (:310): remove `white-space: pre-wrap` (markdown output is block-level now); keep `word-break` for long tokens; add `.msg-body > :first-child { margin-top: 0 }` / `:last-child { margin-bottom: 0 }`.
- `.msg.user .msg-body` (:318): `display: inline-block` → `block` (markdown block children are invalid inside inline-block; the bubble becomes full-width with padding — visually same for single paragraphs).
- New markdown styles (scoped under `.msg-body`, using existing CSS vars, ChatGPT-consistent):
  - `p` margins (0.5em 0), `h1–h6` sizes/weights, `ul`/`ol` padding + task-list checkboxes (`input[type=checkbox]` — GFM output; small, accent color), `blockquote` (left 3px border + `--bg-soft` bg + muted color), `hr`, `del`/`mark` (mark: faint yellow).
  - `pre` (bg `--bg-soft`, padding 10–12px, radius `--radius-sm`, `overflow-x: auto`, mono) and inline `code` already exists (:45) — keep, ensure `pre code` overrides bg to transparent.
  - `table` (border-collapse, th/td padding 6–8px, borders `--border`, th bg `--bg-soft`), `thead` bold; `overflow-x: auto` wrapper is not possible without markup change — tables get `display: block; overflow-x: auto` on the table itself as a pragmatic wrapper (note: works since tables are block-level at the end of `.msg-body`).
  - `a` → accent underline color; `.hm-img` (max-width 100%, `border-radius: 10px`, `display: block`, `margin: 6px 0`); `.hm-img-fallback` (muted, dashed underline, mono, word-break).
- Streaming caret `::after` (:326) — keep; it appends after the last block; acceptable for v1 (could move to `> :last-child` if it looks wrong — note as tweakable).

### `manifest.json`

**No changes.** No new permissions: `file://` images are gated by the user-side "Allow access to file URLs" toggle, not a manifest permission (and adding `file:///*` to `host_permissions` still requires that toggle while adding a scary "read all data on your computer" warning — strictly worse). Vendored scripts are `'self'`, allowed by the default CSP. `http://127.0.0.1/*` host permissions already cover the polling traffic.

### `README.md`

- Features table: flip markdown/math/images/live-updates entries to ✅; add a row for "Live updates from other clients (polling)".
- Install section: new step — after loading the extension, enable **Details → Allow access to file URLs** (required for `IMAGE:`/`MEDIA:` local files; without it, images degrade to clickable path links).
- Layout section: add `renderer.js`, `vendor/` (marked/DOMPurify/KaTeX, MIT, pinned versions), `test_renderer.js`.
- New short section: rendering pipeline (markdown → marked+DOMPurify, math → KaTeX, `IMAGE:`/`MEDIA:` → `<img>` with fallback) and live-update behavior (3 s polling while the panel is visible; pauses while streaming/hidden).

## 4. Streaming performance plan

Today: `renderMessages()` per delta = O(all messages) DOM rebuild + (soon) full markdown/KaTeX re-parse of history. Fix has three levers:

1. **Scope:** deltas re-render **only the last message's `.msg-body`** (`renderMessageBody`), never the list — history size stops mattering.
2. **Throttle:** `scheduleStreamingRender` trailing-edge `setTimeout(60 ms)` — at most ~16 renders/s even with a flood of deltas; KaTeX/marked work on a few-KB string is sub-ms, so this stays smooth. Timer is cleared and flushed synchronously on `assistant.completed`/end.
3. **Scroll:** autoscroll only if already near the bottom (or while streaming), so polling-inserted messages / user reading history don't get yanked.

Full rebuilds (`renderMessages`) remain for: history load, session switch, new chat, and the rare poll-reconcile (fingerprint-gated — normally zero DOM work per tick). Worst case mid-stream is one message re-parsed per 60 ms — well within budget for the panel.

## 5. Edge cases

- **Partial markdown mid-stream:** marked never throws on malformed input — an unclosed fence renders as literal text until the closing fence arrives (then it snaps into a code block); an unclosed table stays paragraphs; unclosed `$…$` fails the inline regex and stays literal `$`-text until the closer lands. `throwOnError: false` keeps KaTeX from ever throwing. No try/catch surface area except a defensive wrapper around the whole `renderMarkdown` that falls back to `escapeHtml` text on any unexpected error.
- **`IMAGE:` inside code blocks:** the pass-1 scanner tracks fenced-code state, so media lines (and math) inside fences are left untouched and render as literal code text. Requirement #5 satisfied at the source-scan level, not by post-hoc rules.
- **Windows backslashes:** handled entirely by `mediaUrl()` normalization (`\` → `/`, `file:///C:/…`). Backslash-heavy content elsewhere is ordinary text — no interference. Trailing period on a media line (`IMAGE:path.png.`) — whole-line value is used verbatim; if the file doesn't exist the `error` fallback shows the raw path (documented).
- **`message_count` semantics are unverified** (may count tool rows / system turns differently than visible messages) → the count is only a *trigger* for a fetch; the fingerprint gates actual DOM changes, so false positives cost one wasted request and false negatives are impossible (count change with identical content is the only miss window, and that's benign).
- **Message normalization:** `normalizeMessage()` (sidepanel.js:155) stays as-is — array-content flattening, role mapping, empty-content handling all already correct; desktop rows flow through the same path. `\r\n` content is handled by marked. No change needed.
- **XSS:** every path to the DOM is sanitize-gated: markdown via DOMPurify (default config blocks `javascript:`/`data:` etc.), media/math via self-constructed post-sanitize tags with `escapeHtml`-escaped attributes, KaTeX output trusted-by-construction. Error/`(empty reply)` bodies also pass through the same pipeline (sanitizer makes them safe). No `innerHTML` anywhere except the sanitized/reconstructed output of step ④.
- **User messages:** rendered through the same markdown pipeline (`breaks: true` makes multi-line user input readable, not collapsed).
- **Panel hidden / settings open:** polling skips (guards), timers keep running cheaply.
- **Session list regression:** `renderSessionList` untouched; desktop `source: "desktop"` sessions already appear and remain selectable — live updates are what make them useful.
- **Fallback when file access is off / file missing:** `.hm-img-fallback` anchor (raw path text, clickable `file:///` href) replaces the broken `<img>` via the `error` listener.

## 6. Testing plan

**Static / syntax**
- T0: `node --check sidepanel.js renderer.js` (both files must pass; vendored minified files are skipped).
- T1: `node test_renderer.js` — tiny assert-based runner (no frameworks, plain `node:assert`) covering: media-line extraction (uppercase/lowercase `IMAGE:`/`MEDIA:`, inside-fence → NOT extracted), block/inline math extraction incl. `\(…\)`, `$$…$$`, escaped `\$`, mediaUrl normalization (`C:\…`, `/…`, `http(s)://…`, garbage → null), sentinel round-trip indices, fingerprint stability/change.

**Gateway probes (terminal)** — the API key at `C:\Users\lasis\AppData\Local\hermes\.env` (`grep API_SERVER_KEY …`), gateway on `http://127.0.0.1:8642`:
- T2: `curl -s -H "Authorization: Bearer $KEY" "http://127.0.0.1:8642/api/sessions?limit=50&offset=0&order=recent"` — confirm the desktop session(s) appear with `source: "desktop"` and a `message_count`.
- T3: `curl -s -H "Authorization: Bearer $KEY" "http://127.0.0.1:8642/api/sessions/<id>/messages"` — capture real content containing `IMAGE:` lines + markdown; use it as the fixture for T4/T5 (this is also the acceptance fixture for requirement #3).
- T4: T3 output piped into `node test_renderer.js`-style probe or pasted into the panel via a temporary session — verify every `IMAGE:`/`image:`/`MEDIA:` line produces exactly one `<img>` and that no `<img>` is produced for paths inside fenced code.

**Manual checklist (loaded extension, developer mode)**
- T5: Open the desktop session from T2 → history renders: headers/bold/lists/tables/blockquotes/code blocks/task lists as styled markdown; `IMAGE:` lines render as images; math `$…$`/`$$…$$` typeset via KaTeX (fonts load — check devtools network for `vendor/katex/fonts/…`).
- T6: New chat → prompt: *"Reply with a markdown table, a fenced code block, a task list, a blockquote, inline math `$e^{i\pi}+1=0$`, display math `$$\int_0^1 x\,dx$$`, and an `IMAGE:`-style local png path"* → stream renders smoothly (no jank during token-by-token; caret visible; final flush correct), all four constructs correct.
- T7 (CSP): panel console shows no CSP violation errors; `renderMarkdown('<img src=x onerror=alert(1)> <script>alert(2)</script> [x](javascript:alert(3))')` via devtools → no dialogs, sanitized output. Also test `katex.renderToString('\\frac{', …)` → red error span, no throw.
- T8 (live updates): with the panel open on a session, send a message from the **desktop app** → appears in panel within ≤3 s without reload. Then: switch to another tab (panel hidden) → send in desktop → reopen → appears immediately. Start a stream from the panel → confirm no poll requests during it (devtools Network). Verify server copy wins / no duplicate bubbles after a desktop update lands mid-session.
- T9 (file access toggle): turn **Allow access to file URLs** off → reload → images degrade to `.hm-img-fallback` links (clickable path), no broken-image icon; turn on → images render.
- T10 (regression): session list + refresh, new chat, send/stop button, settings save/test, connection badge, empty state — all unchanged behavior.
- T11: leave the panel open ~5 min with the gateway *stopped* → no error-spam (silent poll failures), no console exception storm; restart gateway → badge recovers.

**Acceptance mapping:** T5/T6 → req #1+#2, T5/T9 → req #3, T8 → req #4, T7 → XSS mandate, T0/T1 → sanity gates.

## 7. Risks + open questions

| Risk | Mitigation |
|---|---|
| `message_count` semantics unknown (may not track visible messages 1:1) | count is only a poll trigger; fingerprint gates DOM updates (§2.5) |
| Desktop-session message rows may contain payload shapes we haven't seen | `normalizeMessage` already flattens arrays/parts; the fingerprint uses the *normalized* form, so odd shapes surface as visible text rather than break rendering |
| KaTeX vendored size (~2–3 MB fonts) and repo bloat | acceptable for a local extension; alternative (MathJax) is larger; fonts are immutable cache-friendly |
| marked@12 vs newer majors: future maintainer might "upgrade" and break defaults | pin version + note in README layout section; the API surface used is `marked.parse` only |
| Inline `$` inside backtick code spans misread as math | documented known limitation (markdown-it-katex shares it); refinement path = `walkTokens` exemption (§2.4) |
| `%`-in-filename double-encoding, UNC paths, trailing-dot media lines | documented edge cases; error-fallback link always preserves the raw path text |
| CSP blocking something subtle in vendored builds (e.g. KaTeX internals) | explicitly tested in T7; all three libs' default builds are CSP-safe |
| Polling cost on the gateway | 1 cheap request per 3 s, only while visible+idle; errors silent |

**Open questions (no blocking ones; defaults chosen):**
- `breaks: true` (soft line breaks in markdown) — chosen for chat feel; trivially flippable to `false` if the user prefers strict markdown.
- Poll interval 3 s fixed constant — could become a setting later; YAGNI.
- No background-service-worker polling: panels unload when closed, so polling lives in the page — correct by construction; a service worker would need a persistent page anyway.
- Image click behavior (open in new tab vs nothing) — not requested; fallback link is the only navigation affordance in v1.
