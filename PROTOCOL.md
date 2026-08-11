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
  hello carries `rotate: true` (sidepanel "Reset pairing"); a new browser
  arriving while only a legacy `*` pin exists takes its own slot instead.
  Env `LIVE_BROWSER_TOKEN` pins `*` for every browser and disables TOFU
  (no re-pin while set). `browser-mcp.py --reset-pairing` clears the file.
  There is no per-message token — the envelope has no field for it.

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
  detach). Hub clears its attached-tab state.
- `pong`: answers a hub `ping`.

## Heartbeat

The hub pings every **15 s** and expects a `pong` within **10 s**; a miss
marks the bridge down (all tools return `BRIDGE_DOWN`) and closes the
socket. The extension's own SW keep-alive pings (chrome.alarms, 30 s while
attached) also get a `pong` — any pong keeps the heartbeat satisfied.

## Commands

| `cmd` | Direction | Purpose |
|---|---|---|
| `hello` | ext → hub | handshake `{token, extId, version, browser, rotate?}`; per-browser TOFU pin; wrong token → close `4401`; `rotate: true` re-pins the browser's slot |
| `cdp` | hub → ext | relay `method`/`params` to the attached tab; reply with CDP result/error |
| `status` | hub → ext | reply `{attached, tab: {id,title,url,incognito}|null, debugger: "attached"|"none", browser}` |
| `ping` / `pong` | either | liveness (hub heartbeat 15 s/10 s; extension SW keep-alive) |
| `event` | ext → hub | CDP events (B1: ignored) |
| `detach` | ext → hub | debugger detached from a tab (reason per chrome.debugger) |

## Error codes

| Code | Where | Meaning |
|---|---|---|
| `bad token` | hub | hello token mismatch → close `4401` |
| `not paired` | hub | message before a successful `hello` |
| `unknown cmd` | hub | unrecognized `cmd` |
| `BRIDGE_DOWN` | hub/tools | no connected socket (server not running, SW asleep, Disconnect) |
| `TIMEOUT` | hub | no extension reply within the request budget |
| `TAB_NOT_ATTACHED` | ext | cdp relay for a tabId that isn't the attached one |
| `TAB_BUSY` | ext | `chrome.debugger.attach` failed — another debugger (e.g. DevTools) holds the tab |

## Flow: attach + round trip

```
hub                         extension                      tab
 │ ── hello{token,extId}──▶  │                              │
 │ ◀── {cmd:"event"...}──────│ (events flow either way)     │
 │ ◀── {cmd:"detach"}────────│ ◀─ chrome.debugger.onDetach  │
 │ ── {id:1,cmd:"cdp",method:"Runtime.evaluate"}──▶         │
 │ ◀─ {id:1,ok:true,result:{...}} ◀─ sendCommand ────────── │
```
