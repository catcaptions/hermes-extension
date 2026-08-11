# DESIGN_BROWSER_USE.md — Browser-Use Upgrade for the Hermes Extension

**Status:** DRAFT v1 (research pending) → will be revised after critique.
**Scope:** Add a proper MCP browser layer giving Hermes Playwright-level control of the USER'S REAL browser (existing tabs, logged-in sessions) through the extension, plus viewport/element/full-page screenshots.
**Constraints:** MV3, no build step, zero-code-change rule for the orchestrator (implement via herdr), minimal token overhead, strong permissions, clean stale-ref recovery.

## 0. Settled local facts (verified 2026-08-11)

- Extension: MV3 sidepanel; permissions `sidePanel`+`storage`; host_permissions `http://127.0.0.1/*`,`http://localhost/*`; background.js is trivial (sidePanel behavior only). No CSP `connect-src` in manifest/HTML → MV3 default allows WS to `ws://127.0.0.1:8644` from extension pages.
- Hermes: native MCP client active (`mcp` SDK 1.28.1 installed); servers configured under `mcp_servers` in `config.yaml` (none currently); tools registered as `mcp_{server}_{tool}`; stdio or HTTP transport; NO hot reload (restart needed to add/change servers).
- Node v22.23.2 present; `@playwright/mcp@0.0.79` on npm (npx-able) — a delegation option, not a default.
- Gateway 8642 (`API_SERVER_KEY` Bearer auth; CORS origins for the 2 extension IDs). Media bridge 8643 (Python, autostart .lnk) = established local-companion-server pattern to follow.
- Hermes already ships `browser_*` tools (CDP/cloud) + `chrome_*` plugin tools (21 tools, bridge 127.0.0.1:16319) + `web-browsing` skill documenting their contract (browser_navigate/snapshot/click/type/press/scroll/vision/console…). The agent ALREADY knows this interaction model.
- Environment now: no browser with debug port running (9222 dead, 9009 dead); only msedgewebview2 procs.

## 1. Recommended architecture and data flow

**One sentence:** a thin Python MCP server (Hermes-side, stdio) doubles as a localhost WebSocket hub; the extension (chrome.debugger) connects out to it and acts as the CDP tunnel into the user's real tabs; the MCP server implements the observe→act→observe tool semantics over CDP, reusing Hermes' existing `browser_*` tool contract so the agent needs zero retraining.

```
┌─────────────┐   MCP stdio   ┌──────────────────────┐   WS 127.0.0.1:8644   ┌────────────────────────┐
│ Hermes agent│◄─────────────►│ browser-mcp.py       │◄──────────────────────►│ extension (SW+sidepanel)│
│ (gateway    │ mcp_browser_* │  tool semantics      │   {cmd,tabId,method,   │  chrome.debugger attach │
│  8642)      │               │  refs/snapshots/waits│    params} / events    │  chrome.tabs list       │
└─────────────┘               │  WS listener         │                        │  pairing token          │
                              └──────────────────────┘                        └───────────┬────────────┘
                                                                                         │ chrome.debugger
                                                                                         ▼
                                                                              user's real Chrome/Edge tabs
                                                                              (cookies, logins, sessions intact)
```

**Data flow (observe→reason→act→observe):**
1. Agent calls `mcp_browser_snapshot()` → MCP server → WS `{cmd:"cdp", tabId, method:"Accessibility.getFullAXTree"}` → extension → `chrome.debugger.sendCommand` → page → tree back → server compacts into numbered refs → returned as compact text.
2. Agent calls `mcp_browser_click(ref:"@e7")` → server resolves ref → nodeId → `DOM.getBoxModel` → center point → `Input.dispatchMouseEvent` → extension → page.
3. `mcp_browser_screenshot(scope:"viewport|full|element", ref?)` → `Page.captureScreenshot` (viewport) / `captureBeyondViewport` (full, CDP-native, no stitching) / clip via getBoxModel (element) → PNG written to screenshots dir → result text carries `MEDIA:<abs path>` which the desktop app renders inline (established pattern).

**What we build vs delegate:**
- BUILD (extension): debugger attach/detach, tab bridge, WS client, pairing, status UI. ~250–400 lines + manifest permissions.
- BUILD (server): MCP tool surface, snapshot compaction, ref mapping, waits, screenshot saving, console/network buffering. ~600–900 lines Python.
- DELEGATE: NOTHING to Playwright the library through the tunnel (see §7 critique — CDP-endpoint emulation is a dead end). We borrow Playwright MCP's *contracts* (tool names/refs/screenshot scopes) and Hermes' own `browser_*` semantics instead.

## 2. MCP tool / API specification

Server name `live_browser` → registered as `mcp__live_browser__*` (mirrors built-in browser_* semantics so the web-browsing skill transfers 1:1, while the `live` marker keeps the user's-open-browser distinction unambiguous — see §10.5).

| Tool | Inputs | Returns |
|---|---|---|
| `browser_navigate` | url | `{url, title, status}` (waits for load) |
| `browser_snapshot` | full?:bool, max_items?:int | numbered a11y tree, refs `@eN`, groups, truncated flag |
| `browser_click` | ref, button?, count? | ok / stale-ref error + fresh snapshot hint |
| `browser_type` | ref, text, submit?:bool | ok (fills via Input.insertText; optional Enter) |
| `browser_fill` | ref, text | ok (clear + insert) |
| `browser_press` | key (FriendlyName or raw code) | ok |
| `browser_hover` | ref | ok |
| `browser_scroll` | direction, amount?, ref? | ok |
| `browser_select` | ref, values:[...] | ok (select option by value/label) |
| `browser_screenshot` | scope: viewport\|full\|element, ref?, quality?, max_width? | `MEDIA:<path>` + caption |
| `browser_evaluate` | expression | JSON-serialized result (sandboxed note) |
| `browser_wait` | condition: load\|idle\|visible(ref)\|text(selector,text), timeout | ok / timeout |
| `browser_tabs` | action: list\|activate\|close\|new, tabId?, url? | tab list {id,title,url,active,audible?} |
| `browser_console` | since?:seq | buffered console messages (severity, text, source) |
| `browser_network` | since?:seq, filter? | buffered network events (url, status, method, size) |
| `browser_attach_status` | — | which tab is attached, debugger state, bridge state |

**Ref contract:** refs are per-snapshot, stable while the DOM node lives; re-snapshot after page mutation. Server keeps a `snapshotEpoch` counter; actions carry the epoch implicitly (latest); stale ref → `{error:"STALE_REF", hint:"re-snapshot"}` (see §6).

## 3. Extension ↔ MCP ↔ Playwright ↔ Hermes communication design

**Two hops, one protocol shape each:**

- **Hop A — Hermes ↔ server:** standard MCP stdio (fastMCP). Config:
  ```yaml
  mcp_servers:
    live_browser:
      command: "python"
      args: ["C:\\projects\\browser-extensions\\hermes-minimal-extension\\browser-mcp.py"]
      timeout: 120
  ```
- **Hop B — server ↔ extension:** JSON-RPC-ish messages over one WebSocket (server hosts listener on `127.0.0.1:8644`; extension connects out — no inbound socket needed in the extension). Message envelope:
  ```json
  {"id": 1, "cmd": "cdp", "tabId": 123, "method": "Runtime.evaluate", "params": {...}}
  {"id": 1, "ok": true, "result": {...}}
  {"cmd": "event", "method": "Page.loadEventFired", "params": {...}, "tabId": 123}
  {"cmd": "detach", "tabId": 123, "reason": "target_closed"}
  ```
- **Heartbeat:** server pings every 15 s; extension pongs. On drop, server marks all tabs detached, tools return `BRIDGE_DOWN` (same banner pattern as the existing `@url:` bridge-down toast). Extension auto-reconnects with backoff (1,2,4,8,16 s).
- **Pairing/trust:** on first connect, extension generates a random token (chrome.storage.local), sends `hello {token, extId, version}`; server requires it in every message after handshake. The server binds the socket to 127.0.0.1 only; refuses non-loopback. The server ALSO refuses commands from any origin other than the paired socket (no HTTP endpoint exposed).
- **One active debugger per tab** (Chrome constraint): if DevTools/user opens another debugger, `chrome.debugger.onDetach` fires → server gets `detach` event → tools return `TAB_BUSY` with a hint to close DevTools on that tab. This matches Browser MCP's known limitation; we surface it, never fight it.
- **Lifecycle:** service worker hosts the WS client + debugger state (survives sidepanel close). MV3 SW idle-kill is mitigated because an attached debugger keeps CDP events flowing; server sends periodic `ping` RPCs that also serve as SW keep-alive. Sidepanel shows a status chip (attached tab title, bridge state) via chrome.runtime messaging.

**Why not native messaging / chrome-extension MCP transport?** Native messaging needs a registered native host (installer + manifest + path per machine) — heavier setup for zero benefit here (both ends are already localhost; WS is fine and matches Browser MCP's proven pattern). Why not a separate HTTP bridge like media-bridge? MCP stdio gives Hermes native tool discovery (no polling, typed schemas, error surfaces) — that's the whole point of "proper MCP browser layer".

## 4. Existing Chrome tabs and authenticated sessions

- **Tab discovery:** `chrome.tabs.query({})` through the extension → `browser_tabs` lists ALL user tabs (title, url, favicon, active state). No new window, no profile copy — this IS the user's session, cookies and logins intact (the core requirement).
- **Attach semantics:** attaching a tab via chrome.debugger does NOT navigate or reload it. The page continues rendering as the user sees it. `Page.navigate` only changes the URL when the agent explicitly calls `browser_navigate`.
- **Default tab:** tools act on the LAST ACTIVE tab (the one the user last focused, or last explicitly activated via `browser_tabs action:activate`). Agent can switch explicitly; snapshot includes `activeTabId` for orientation.
- **Auth-token/POST-login pages, payment flows:** no special handling — user's real session. SECURITY: agent MUST NOT auto-submit payments/credentials; see §7.
- **Private windows:** chrome.tabs query includes them (permission); design decision: attach allowed but flagged in `browser_attach_status` (`incognito: true`), and the sidepanel shows an amber badge. (Rationale: user's own machine, but visibility matters.)
- **What happens on navigation:** attach survives same-tab navigation (debugger session persists). On tab close → `onDetach` → server clears tab state, refs invalidated (epoch bump). New tabs from the page (`target=_blank`) appear via chrome.tabs.onCreated → surfaced in next `browser_tabs`.

## 5. Screenshot architecture and how images reach Hermes

- **Capture paths (all CDP-native, no stitching):**
  - viewport: `Page.captureScreenshot {format:"png"}` (default) or `jpeg quality:60` for cheap big shots.
  - full page: `Page.captureScreenshot {captureBeyondViewport:true}` — CDP does the composition; downscale via `Page.getLayoutMetrics` → optional `clip` to a max pixel budget.
  - element: `DOM.getBoxModel` on the ref's nodeId → `clip` rectangle → capture.
- **Size governance (token bloat is a hard requirement):** default JPEG q60; `max_width` param (default 1280) downscales by capturing a clip at scale; results returned as `MEDIA:<path>` in the tool text, NOT base64 inline. Screenshots go to `%TEMP%\hermes-browser-shots\<timestamp>.png|jpg`; the desktop app's existing media rendering renders `MEDIA:` paths inline; the extension renders via its established `@media:`/file handling.
- **When to screenshot vs snapshot:** snapshot (a11y tree) is the default interaction surface; screenshot is complementary — canvas/charts/visual QA/verification. The tool descriptions encode this guidance (mirrors the web-browsing skill's decision tree).
- **Caching:** server keeps a per-session LRU of last N (default 3) screenshots' paths in tool results so re-renders don't re-shoot; screenshots deleted on session end or after 24 h (temp dir hygiene).

## 6. Element-ref / snapshot design

**Snapshot pipeline (server-side):**
1. `Accessibility.getFullAXTree` → flattened tree (role, name, value, nodeId, backendNodeId, bounds).
2. Compaction pass (token discipline): keep interactive roles (button, link, textbox, checkbox, combobox, radio, menuitem, tab, option, input elements), skip pure-presentation/static text (but keep headings + a text summary), cap `max_items` (default 60, `full:true` → 300), group by section landmark when cheap.
3. Number refs `@e1..@eN`; refs map to `{backendNodeId}` server-side. Bounds (x,y,w,h) stored for hit-targeting but NOT emitted (saves tokens) — emitted only when the agent asks `browser_snapshot(full:true)`.
4. Return compact text: `[1] button "Sign in"`, `[2] link "Pricing"`, plus `truncated:true` flag when capped. Mirrors Hermes' own compact snapshot UX — the agent already reads this shape.

**Ref stability & staleness (the user's explicit requirement):**
- Refs are valid ONLY against the snapshot epoch they came from. Server stores `epoch → refMap → backendNodeId`; every action first re-validates the node via `DOM.describeNode({backendNodeId})` + `DOM.getBoxModel`; if gone/zero-size → `STALE_REF` error with hint `"page changed — re-snapshot"`.
- On ANY navigation event (`Page.frameNavigated`), server bumps the epoch and invalidates all refs — the agent's next action fails fast with STALE_REF rather than clicking a dead node (this is the classic "element refs become stale" failure; we make it cheap and self-healing: error → re-snapshot → continue).
- Re-snapshot after EVERY action is NOT required (token discipline): refs survive until invalidation; the agent re-snapshots when the next observe is due (observe→reason→act→observe loop).

**Action resolution order:** ref → backendNodeId → `DOM.requestNode` → nodeId → getBoxModel → center → `Input.dispatchMouseEvent` (mousePressed/mouseReleased) with `clickCount`. Type/fill → focus via `DOM.focus` then `Input.insertText`. Select → `Runtime.evaluate` on the select's value + dispatch `change` (React/Vue-safe pattern already in the web-browsing skill). Scroll → wheel event at element center or `Runtime.evaluate` scrollIntoView.

**Frames:** `Accessibility.getFullAXTree` includes iframe contents as child AX nodes; the server tracks `frameId` per node via `DOM.getFrameOwner` when needed; cross-origin OOPIFs — same limitation as Hermes' browser_* tools (documented; workaround = `browser_navigate` to the frame URL if same-origin, else snapshot text only).

## 7. Security and permission model

**Manifest additions (the heavy ask, stated honestly):**
- `"debugger"` permission (Chrome shows the scary "Read and change all your data on all websites" warning — unavoidable for CDP control; Browser MCP ships the same).
- `"tabs"` permission (tab titles/URLs for `browser_tabs`).
- host_permissions unchanged (127.0.0.1 already covered for WS+fetch).

**Layered boundaries:**
1. **Loopback only:** WS listener binds 127.0.0.1; server validates peer is loopback; no HTTP surface; token required post-handshake; token stored in chrome.storage.local (never logged, never sent to the gateway).
2. **Read-mostly default, write by explicit tool:** the tool surface has NO "evaluate arbitrary JS with user's cookies" free-for-all — `browser_evaluate` exists but the tool description requires a reason (mirrors Hermes' browser_console practice); sensitive domains (password managers, banking) get a **denylist + confirmation**: `browser_click`/`browser_type` on a page whose host matches a sensitive pattern (bank, pay, login, account, wallet…) requires `confirm:true` param from the agent; the sidepanel shows a red "automation active on sensitive page" chip.
3. **No credential/payment automation:** agent guidance hard-coded in tool descriptions: never enter credentials, never complete purchases (the extension surfaces a `SENSITIVE_ACTION` error for `browser_type` into `input[type=password]` unless `confirm:"user_approved"` — deliberate friction; the user must explicitly type secrets themselves if ever needed).
4. **Visible state:** sidepanel status chip always shows: attached tab + automation-active indicator + red/amber states; a global "Disconnect" button detaches everything immediately (kills WS + all debugger sessions).
5. **No gateway involvement:** the browser layer NEVER sends page content to the Hermes gateway; snapshots/screenshots stay in the local MCP process and in Hermes' own context (they ARE the agent's observations, same trust as terminal output). The media bridge is not involved in CDP traffic.
6. **Incognito flagging** (see §4) + tab-close/epoch hygiene.

## 8. Implementation plan — phases and files

**Files touched/added (repo):**
- `manifest.json` — add `debugger`, `tabs` permissions (edit)
- `background.js` — WS client, pairing token, debugger attach/detach, message relay, keep-alive (rewrite, ~250–350 lines)
- `browser-bridge.js` — NEW: shared protocol helpers + tab registry (used by SW; small)
- `sidepanel.html` / `sidepanel.css` / `sidepanel.js` — status chip, Disconnect button, sensitive-page red state, `/browser` command surface (edits)
- `browser-mcp.py` — NEW: MCP server (fastMCP, stdio) + WS listener + tool semantics + snapshot/ref/epoch logic + screenshots + console/network buffers (~700–900 lines)
- `test_browser_mcp.py` — NEW: unit tests (snapshot compaction, ref mapping, epoch invalidation, protocol envelope, denylist logic) — pure logic, no browser needed
- `README.md` — setup/security notes; `config.yaml` — `mcp_servers.browser` entry
- `DESIGN_BROWSER_USE.md` — this doc (living)

**Phases (one feature per herdr task, critic loop after each, per the user's pipeline):**

- **Phase B1 — Protocol + transport skeleton (extension SW + server stub):** manifest permissions; WS listener in browser-mcp.py; extension WS client + hello/pairing; ping/pong; `browser_attach_status` tool; sidepanel status chip + Disconnect. Verify: start server, attach to a tab, exchange hello, send one `cdp Runtime.evaluate "1+1"` end-to-end. **Exit:** live round-trip in the user's Edge.
- **Phase B2 — observe: snapshot + refs + epochs:** `browser_snapshot` (a11y compaction, refs, max_items/full), epoch invalidation on navigation events, STALE_REF contract, `browser_tabs`. Verify: snapshot a real page, click through 2 refs, navigate → STALE_REF → re-snapshot. Unit tests for compaction/epoch.
- **Phase B3 — act: input surface:** click/type/fill/press/hover/scroll/select via CDP Input/DOM; sensitive-domain denylist + password-field guard; `browser_wait`. Verify: form-fill on a test page (e.g. example.com form / the repo's own QA page), select option, hover, scroll.
- **Phase B4 — screenshots + evaluate + console/network:** `browser_screenshot` (viewport/full/element, jpeg q60, max_width, MEDIA: paths), `browser_evaluate`, `browser_console`, `browser_network` (bounded buffers). Verify: element screenshot of a chart, full-page of a long page, MEDIA: path renders in the Hermes desktop chat.
- **Phase B5 — hardening + UX:** reconnect/backoff, TAB_BUSY handling, incognito badge, SW keep-alive tuning, screenshot temp hygiene, README + user manual checklist. Verify: kill server mid-task → BRIDGE_DOWN → restart → auto-reconnect; DevTools-open → TAB_BUSY hint.

**Orchestrator verification (read-only, per pipeline):** `python -m py_compile browser-mcp.py`, unit tests green, protocol envelope round-trip via a stub WS client in a temp script, BUILD_STRING bump after extension edits, user manual checklist at the end (reload extension, open sidepanel, run `/browser status`, watch the chip).

## 9. Aggressive self-critique (of the draft above)

1. **"Unnecessary complexity — Hermes already HAS browser tools."** The `browser_*` built-ins (via CDP auto-connect, `browser.cdp_url`) need the browser relaunched with `--remote-debugging-port=9222` and a SEPARATE profile — they do NOT drive the user's active tabs/logins (the core requirement). The `chrome_*` plugin (21 tools, bridge 16319) DOES drive the real browser — but it's a separate third-party extension with its own install/authorize lifecycle, not this repo. Verdict: the new surface is justified, BUT the plan should state this comparison explicitly so nobody re-litigates it later. **Not a cut — a documentation requirement.**

2. **"You're reimplementing Playwright."** click/type/fill/select/wait are Playwright MCP's polished territory. Why not run `@playwright/mcp` (npx, Node 22 present) with `--cdp-endpoint`? Because there IS no CDP endpoint on the user's browser, and emulating one (Target domain, `/json/list`, sessionId synthesis over chrome.debugger's flat sessions) is the exact brittleness Browser MCP dodged by forking playwright-mcp instead of emulating CDP. The honest cost: our ~600–900 lines deliver maybe 60% of Playwright's semantics (no locator engine, no auto-waiting, no multi-context). Mitigations: explicit `browser_wait`, ref re-validation per action, and the observe→act loop doesn't need Playwright-grade auto-wait in most flows. **Accepted risk, stated; keep our own server.**

3. **MV3 service-worker lifetime is a real communication-reliability hole.** An attached `chrome.debugger` does NOT pin the SW; a quiet page → no CDP events → Chrome kills the SW (idle ~30 s) → WS dies → BRIDGE_DOWN → next tool call can't wake the SW (nothing does except extension events/alarms). **Fix: `chrome.alarms` keep-alive (20 s, only while attached) + WS client in SW; sidepanel close must not kill automation.** (Also: browser-mcp.py crash → Hermes' MCP reconnect retries; extension auto-reconnects WS with backoff — covered.)

4. **Screenshot delivery format was wrong in §5.** `MEDIA:` is the ORCHESTRATOR's own pasted-summary convention; the EXTENSION's renderer does NOT render `MEDIA:` — it renders `@image:C:\path` (file-URL/media-bridge path). MCP results are read by the AGENT, whose reply renders in BOTH surfaces: extension (needs `@image:`) and desktop (renders `MEDIA:`). **Fix: tool result text = `Screenshot saved: @image:C:\...` and also `MEDIA:C:\...` on the next line — agent echoes naturally, both render.**

5. **Missing tools the user's real workflows need:** `browser_back` (Hermes has it; trivial via `Page.navigateToHistoryEntry`/JS history.back), and **file upload** (`DOM.setFileInputFiles` — the user uploads docs to portals constantly). **Add both to the spec** (back → Phase B3; upload_file → Phase B3).

6. **Denylist is bypassable** (hostname substring tricks) — acceptable for a personal local tool, but the password-field guard (`input[type=password]`) is the one that matters and it's structural (DOM-based), not hostname-based. **Keep; document denylist limits honestly.**

7. **Token bloat residual risks:** full-page screenshots of giant pages (captureBeyondViewport on 50k-px pages) can be MBs — the JPEG q60 + max_width budget covers most; add a hard `max_pixels` guard (default ~8 MP) that downscales via clip. **Add to §5.**

8. **Debugger conflicts (DevTools open) are frequent in real use** — the user WILL have DevTools open sometimes. TAB_BUSY + "attach a DIFFERENT tab" path must be first-class, not an afterthought. **Explicit `browser_tabs` guidance: pick another tab; error text says which tab is busy.**

9. **What if the user never opens the sidepanel?** Status chip invisible → automation invisible. **Fix: `chrome.action.setBadgeText` ("●" when attached) + badge tooltip; sidepanel chip is the rich view.**

10. **Architectural dead ends rejected (recorded):** CDP-endpoint emulation for Playwright MCP (brittle Target/session synthesis); native messaging (installer weight, no benefit on loopback); a third HTTP bridge à la media-bridge (MCP stdio is strictly better for tool discovery); building this into the EXISTING media-bridge.py (single-purpose server, separate lifecycle — keep browser layer independent).

## 10. Revised plan — research-informed (Playwright MCP, browse.sh, OpenAI CUA)

**Research validation:** Playwright's OFFICIAL extension mode does exactly what §3 proposed — MV3 service worker holds `chrome.debugger`, extension connects OUT to the server's localhost port, first tool call shows a tab-selection page, per-connection approval (auto-approved only with a token in env). Our architecture is the proven one, not a gamble. OpenAI's CUA (coordinate grounding from pixels, no DOM) is the confirmed REJECTED alternative for us: refs are token-cheaper, exact, and need no vision model.

### 10.1 Changes from research (folded into the spec)

1. **Snapshot format = YAML-like TEXT tree, not JSON** (Playwright MCP's proven shape; ~200–400 tokens vs 3–5K for a screenshot; no vision model required for the text path):
   ```
   [e1] button "Sign in"
   [e2] link "Pricing" (section "nav")
   [e3] textbox "Email" [focused=false]
   ```
   Refs only on interactive elements; `depth` param limits tree depth; `full:true` adds `[box=x,y,w,h]`.
2. **Auto-snapshot after every action** (Playwright MCP's `--timeout-settle 500ms` behavior): after an action, wait 500 ms for settle, then return a fresh snapshot with the action result — the observe→reason→act loop is enforced structurally. Token escape hatch: `return_snapshot:false` param suppresses it (caller re-snapshots when needed). Epoch/STALE_REF machinery stays as the safety net for the suppressed path.
3. **Actions accept `target` = ref OR unique CSS selector** (Playwright MCP contract) — the agent can fall back to a selector when a ref goes stale, instead of re-snapshotting.
4. **Actionability pre-checks before acting** (Playwright MCP's auto-wait essence, lightweight): element exists (`DOM.describeNode`) → visible (`DOM.getBoxModel` non-zero) → enabled (AX state) → act; `timeout` param (default 5000 ms) polls until ready.
5. **New tool `browser_find`** (Playwright MCP's `browser_find`): text/regex search of the page, returns matching nodes + refs + snippet — cheaper than a full snapshot when you only need one ref.
6. **New params:** `browser_snapshot(depth)`, `browser_find(pattern)`, screenshots take `type` (png/jpeg/webp), `scale` (css|device), `fullPage` (full-page; incompatible with element shots) — mirroring `browser_take_screenshot`.
7. **Screenshot delivery stays PATHS, not base64** — deliberate improvement over Playwright MCP (which returns base64 image blocks, controlled by `--image-responses allow|omit`): the extension renders `@image:` paths inline, and no base64 ever enters agent context. Equivalents of Playwright MCP's flags live as params: `return_screenshot:false` (= `omit`).
8. **Filename offload** (Playwright MCP `filename` pattern): `browser_snapshot(filename)` / `browser_find(filename)` write the full output to disk and return a path — for giant pages.
9. **Config mirrors** (server-side defaults, agent-overridable): `snapshot_mode: full|none` (auto-attach snapshots to action results or not), `console_level: error|warning|info|debug` (trim console noise), `max_snapshot_items` (default 60).

### 10.2 Final tool surface (server `live_browser` → `mcp__live_browser__*`)

| Tool | Inputs | Returns |
|---|---|---|
| `browser_navigate` | url, wait?: load\|domcontentloaded (default load) | `{url, title, status}` |
| `browser_snapshot` | full?:bool, depth?, max_items?, filename? | YAML-like text tree, refs `[eN]`, truncated flag |
| `browser_find` | pattern (text or regex), max_results? | matching nodes + refs + snippet |
| `browser_click` | target (ref\|selector), element?, button?, doubleClick?, modifiers?, return_snapshot?:bool | action result + fresh snapshot |
| `browser_type` | target, text, submit?:bool, slowly?:bool, return_snapshot? | ditto |
| `browser_fill` | target, text, return_snapshot? | ditto (clear + insert) |
| `browser_press` | key, return_snapshot? | ditto |
| `browser_hover` | target, return_snapshot? | ditto |
| `browser_mouse_wheel` | deltaX?, deltaY? | ditto (vision-mode coordinate scroll) |
| `browser_scroll` | direction, amount?, target?, return_snapshot? | ditto (element/ref scroll) |
| `browser_select` | target, values:[...] | ditto |
| `browser_check` / `browser_uncheck` | target | ditto |
| `browser_upload_file` | target, paths:[...] | ditto (`DOM.setFileInputFiles`) |
| `browser_back` / `browser_forward` | — | `{url, title}` |
| `browser_screenshot` | scope: viewport\|full\|element, target?, type: png\|jpeg\|webp, quality?, scale?, max_width?, return_screenshot?:bool | `@image:<path>` + `MEDIA:<path>` |
| `browser_evaluate` | function (with `element` arg opt), target? | JSON result (reason-gated, §7.2) |
| `browser_wait` | condition: visible(target)\|text(selector,text)\|text_gone, timeout? | ok / timeout |
| `browser_tabs` | action: list\|activate\|close\|new, tabId?, url? | tab list {id,title,url,active} |
| `browser_console` | level?, since_seq? | buffered console (bounded 200) |
| `browser_network` | filter?, since_seq? | buffered network (bounded 200) |
| `browser_attach_status` | — | attached tab, debugger state, bridge state, incognito flag |

### 10.3 Updated phases (per herdr task, critic loop after each)

- **B1 — Transport + pairing skeleton:** manifest (`debugger`,`tabs`); `browser-mcp.py` (fastMCP stdio + WS listener on 8644, hello/pairing token, ping/pong, loopback-only); `background.js` WS client + chrome.debugger attach/detach + relay; `browser_attach_status`; sidepanel status chip + Disconnect + action badge. **Exit:** live `Runtime.evaluate "1+1"` round-trip in the user's Edge.
- **B2 — Observe: snapshot + refs + epochs + tabs:** a11y text-tree snapshot with `[eN]` refs, compaction/depth/max_items, epoch invalidation on `Page.frameNavigated`, STALE_REF contract, `browser_tabs`, `browser_find`, filename offload. Unit tests: compaction, ref map, epoch, find. **Exit:** snapshot real page, find → click 2 refs → navigate → STALE_REF → re-snapshot.
- **B3 — Act: input + waits + guards:** click/type/fill/press/hover/scroll/select/check/upload/back-forward; actionability pre-checks (exists→visible→enabled, `timeout` polling); auto-snapshot-after-action (500 ms settle, `return_snapshot` escape hatch); sensitive-domain confirmation + password-field structural guard; `browser_wait`. **Exit:** full form-fill + upload + back/forward on a QA page.
- **B4 — Screenshots + evaluate + console/network:** `browser_screenshot` (viewport/full/element; png/jpeg/webp; max_width/max_pixels budget; `@image:`+`MEDIA:` paths); `browser_evaluate` (reason-gated); `browser_console`/`browser_network` bounded buffers. **Exit:** element shot of a chart renders inline in the extension chat; full-page of a long page under pixel budget.
- **B5 — Hardening + UX:** reconnect/backoff, TAB_BUSY (DevTools-open) first-class guidance, incognito badge, SW keep-alive (`chrome.alarms` 20 s while attached), screenshot temp hygiene (24 h), README + user manual checklist. **Exit:** kill server → BRIDGE_DOWN → restart → auto-reconnect; DevTools open → TAB_BUSY hint.

### 10.4 Orchestrator verification per phase (read-only)
`python -m py_compile browser-mcp.py`; unit tests green; stub-WS-client envelope round-trip; BUILD_STRING bump after extension edits; user manual checklist at the end (`/browser status`, watch chip/badge, screenshot renders, stale-ref recovery demo).

### 10.5 Live-session awareness — the agent must KNOW this is the user's open browser

Requirement (user): when the user talks about "my browser", "the tab I have open", "my portal", or any logged-in page, Hermes must pick the live-session MCP tools — never a headless instance. Four mechanisms make this reliable:

1. **Tool names carry the signal.** Server is named `live_browser`, so every tool registers as `mcp__live_browser__*` (e.g. `mcp__live_browser__click`) — visually and semantically distinct from the built-in `browser_*` (headless) and `chrome_*` tools. Zero ambiguity in the tool list.
2. **Every tool description states it.** Uniform prefix in all `mcp__live_browser__*` descriptions: *"Drives the USER'S LIVE BROWSER — the real open tab attached via the Hermes extension sidepanel (actual profile, cookies, logins). NOT headless. Prefer this whenever the user refers to their own open browser, tabs, or a logged-in site (portals, school/university apps, email)."* Tool descriptions are injected into every session — this is the primary channel.
3. **Every tool result carries a context line.** The server prepends `[live: <browser> tab <id> — "<tab title>" (<url>)]` to results, so the agent re-reads the fact on every observation: `[live: Chrome tab 42 — "my.ie.edu — Application Form" (https://my.ie.edu/...)]`.
4. **`browser_attach_status` answers the question directly.** Result shape: `{live: true, browser: "Chrome", tab: {id, title, url}, incognito: false, debugger: "attached", bridge: "connected"}`. The tool's description instructs the agent: *"Call this first whenever the user mentions an open browser, tab, or logged-in page — confirm the live session and which tab is attached."*

**Supporting patches:**
- `web-browsing` skill: extend the decision tree — "user's open browser / logged-in site / 'my tab' → `mcp__live_browser__*`; headless or disposable browsing → `browser_*`; CDP 9222 → `chrome_*`/CDP". This mirrors the user's standing rule (Edge for logged-in portal work) — the MCP layer is now the canonical way to satisfy it.
- Sidepanel status chip already shows the attached tab; the tab-selection flow (B1) also records the choice in `chrome.storage.local` so `browser_attach_status` can report "user last attached: <tab>" even after a SW restart.

**Failure mode:** if no tab is attached yet, `browser_attach_status` returns `{live: false, hint: "open the Hermes sidepanel → Browser → select a tab"}` — the agent tells the user to pick a tab rather than silently falling back to headless.
