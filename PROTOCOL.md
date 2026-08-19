# Hermes Live-Browser Bridge Protocol (B1)

Transport between `browser-mcp.py` (the hub) and the Hermes extension's
service worker (`background.js`). One WebSocket connection, JSON messages.
Phase B1: transport + pairing + a generic CDP relay. B2+ adds domain
semantics on top — the envelope stays.

## Endpoint & trust model

- `ws://127.0.0.1:8644` — the hub **binds loopback only** and rejects
  non-loopback peers at connect time. No HTTP surface; the extension always
  connects **out** to the hub.
- **Pairing token:** TOFU (trust-on-first-use), one slot **per browser** — the
  `hello` carries `browser` (e.g. `Chrome`, `Edge`), and the **first** hello
  from each browser pins that browser's token. Pins persist to
  `.live-browser-token` next to the script: a JSON map `{"Chrome": tok, ...}`
  when more than one browser is pinned, a single plain token when only the
  legacy `*` slot exists (old single-token files are migrated to `*` on
  load). Subsequent hellos must match their browser's pin — a mismatch
  closes the socket with code `4401`. A browser's slot only re-pins when the
  hello carries `rotate: true` (sidepanel "Reset pairing" — a one-shot flag
  consumed on the next hello, which also mints a fresh token). A legacy `*`
  pin migrates to a named slot **only** for a hello whose token equals the
  `*` value, and is then pruned (no master key). Env `LIVE_BROWSER_TOKEN`
  pins `*` for every browser and disables TOFU (no re-pin, no file write
  while set). `browser-mcp.py --reset-pairing` clears the file. There is no
  per-message token — the envelope has no field for it.
- **Hello-ack:** every `hello` gets exactly one `{"cmd":"hello-ack",
  "ok":true,"browser":...,"version":...}` (pair) or
  `{"cmd":"hello-ack","ok":false}` followed by close `4401` (reject). The
  extension must not treat the connection as usable until the ack arrives —
  this is how it distinguishes the hub from anything else shadowing the
  port (e.g. the gateway's wildcard listener while `browser-mcp.py` is
  down). Missing/garbage ack = failure → close + reconnect backoff.
- **Takeover (last-writer-wins):** if a second connection pairs while one is
  live, it supersedes the first: the old connection's tasks are cancelled
  and its shutdown does not clear the new pairing's state. (A `4403`
  already-paired reject was rejected instead — the extension would treat it
  as a failed ack and back off forever while the other browser holds the
  slot.)

## Envelope

All messages are single-line JSON objects.

### Requests — hub → extension

```json
{"id": 1, "cmd": "cdp", "tabId": 123, "method": "Runtime.evaluate", "params": {"expression": "1+1"}}
{"id": 2, "cmd": "status"}
{"cmd": "ping"}
```

| Field | Meaning |
|---|---|
| `id` | integer, required for request/reply commands (`cdp`, `status`) |
| `cmd` | `cdp` (relay `method`/`params` to `chrome.debugger.sendCommand` for `tabId`) or `status` (report attach state) |
| `tabId` / `method` / `params` | cdp relay args |

`ping` (no `id`) is fire-and-forget; the peer answers `pong`.

### Hello-ack — hub → extension (handshake reply)

```json
{"cmd": "hello-ack", "ok": true, "browser": "Edge", "version": "0.1.0"}
{"cmd": "hello-ack", "ok": false}
```

Sent exactly once per `hello`: `ok: true` on pair, `ok: false` immediately
before the hub closes the socket with `4401` on reject. No other traffic
(requests, events) is valid before a successful ack.

### Responses — extension → hub

```json
{"id": 1, "ok": true, "result": {"result": {"type": "number", "value": 2}}}
{"id": 2, "ok": false, "error": "TAB_NOT_ATTACHED"}
```

Responses carry **no `cmd` field** — a message with an `id` and no `cmd`
is a response. `ok: true` → `result`; `ok: false` → `error` string.

### Events — extension → hub

```json
{"cmd": "event", "method": "Page.loadEventFired", "params": {...}, "tabId": 123}
{"cmd": "detach", "tabId": 123, "reason": "target_closed"}
{"cmd": "pong"}
```

- `event`: forwarded `chrome.debugger.onEvent` (ignored in B1; consumed from
  B2 for epoch invalidation / console / network buffers).
- `detach`: the debugger left the tab (closed, another debugger, user
  detach, or `reason:"idle"` — the extension's idle release, see below).
  Hub clears its attached-tab state.
- `pong`: answers a hub `ping`.

## Attach lifecycle (demand-only + idle release)

Every `chrome.debugger.attach` shows Chrome's "started debugging this
browser" banner, so the extension attaches **only on demand**:

- Attach happens ONLY in response to a hub `tabs` `attach`/`activate`/`new`
  command or an explicit sidepanel Attach click — never on pairing, tab
  switches, or page loads. Cancelling the banner therefore sticks (no
  silent re-attach) until the next tool call.
- **Idle release:** while attached, the extension's keep-alive alarm also
  checks the last hub command (`cdp`/`tabs`/`status` — heartbeats and
  keep-alive pings do NOT count). No command for **3 min** → the
  extension detaches and sends `{"cmd":"detach","reason":"idle"}`; the
  banner disappears. The hub re-attaches (focused tab) on the next tool
  call — agents should expect `STALE_REF` after an idle release and
  re-snapshot.

## Heartbeat

The hub pings every **15 s** and expects a `pong` within **10 s**; a miss
marks the bridge down (all tools return `BRIDGE_DOWN`) and closes the
socket. The extension's own SW keep-alive pings (chrome.alarms, 30 s while
attached) also get a `pong` — any pong keeps the heartbeat satisfied. The
same alarm enforces the idle release (see above).

## Commands

| `cmd` | Direction | Purpose |
|---|---|---|
| `hello` | ext → hub | handshake `{token, extId, version, browser, rotate?}`; per-browser TOFU pin; wrong token → `hello-ack` `ok:false` + close `4401`; `rotate: true` re-pins the browser's slot |
| `hello-ack` | hub → ext | handshake reply `{ok, browser, version}`; `ok:false` precedes the `4401` close; nothing else valid before a successful ack |
| `cdp` | hub → ext | relay `method`/`params` to the attached tab; reply with CDP result/error |
| `status` | hub → ext | reply `{attached, tab: {id,title,url,incognito}|null, debugger: "attached"|"none", browser}` |
| `tabs` | hub → ext | tab control: `action` = `list` \| `attach` \| `detach` \| `activate` \| `new` \| `close`. `attach`/`activate`/`new` wait until `chrome.debugger.attach` succeeds (or `TAB_BUSY` / `TAB_NOT_FOUND`). Match by `tabId` or substring `url` / `title`. |
| `ping` / `pong` | either | liveness (hub heartbeat 15 s/10 s; extension SW keep-alive; hub also pongs incoming pings) |
| `event` | ext → hub | CDP events for the ACTIVE tab only (B1: ignored; B2: epoch/buffers) |
| `attach` | ext → hub | debugger attached to a tab (`{tabId, tab}`) — hub resets refs/buffers |
| `detach` | ext → hub | debugger detached from a tab (reason per chrome.debugger) |

## Error codes

| Code | Where | Meaning |
|---|---|---|
| `bad token` | hub | hello token mismatch → `hello-ack` `ok:false`, then close `4401` |
| `not paired` | hub | message before a successful `hello` |
| `unknown cmd` | hub | unrecognized `cmd` |
| `BRIDGE_DOWN` | hub/tools | no connected socket (server not running, SW asleep, Disconnect) |
| `TIMEOUT` | hub | no extension reply within the request budget |
| `TAB_NOT_ATTACHED` | ext | cdp relay for a tabId that isn't the attached one |
| `TAB_BUSY` | ext | `chrome.debugger.attach` failed — another debugger (e.g. DevTools) holds the tab |
| `TAB_NOT_FOUND` | ext | `tabs` attach/activate could not match `tabId` / `url` / `title` |

## Flow: attach + round trip

```
hub                         extension                      tab
 │ ── hello{token,extId,rotate?}──▶  │                              │
 │ ◀── hello-ack{ok,browser}───────── │                              │
 │ ◀── {cmd:"event"...}──────│ (events flow either way)     │
 │ ◀── {cmd:"detach"}────────│ ◀─ chrome.debugger.onDetach  │
 │ ── {id:1,cmd:"cdp",method:"Runtime.evaluate"}──▶         │
 │ ◀─ {id:1,ok:true,result:{...}} ◀─ sendCommand ────────── │
```
