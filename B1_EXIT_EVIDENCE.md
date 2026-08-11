# B1 EXIT EVIDENCE

Date: 2026-08-11. Repo: `C:\projects\browser-extensions\hermes-minimal-extension`
(no remote). Scope: land the orchestrator's emergency working-tree changes,
fix doc drift, verify the pairing matrix, record results.

## Commits landed

| Commit | Message |
|---|---|
| `9c73f94` | fix(B1): per-browser TOFU pin map, rotate-gated re-pin, _save_pins deadlock; block self-pin bypass under env token |
| `8b11a58` | fix(B1): detect real browser name from userAgentData brands (Not=A?Brand skip) with UA fallback |
| `834af30` | docs(B1): mcp__live_browser__* tool naming; per-browser TOFU pins + rotate in README/PROTOCOL; explicit connect_timeout |

Doc drift fixed: `DESIGN_BROWSER_USE.md` §10.2/§10.5 and `README.md` tool
registration now use `mcp__live_browser__*` (Hermes double-underscore
convention, per `hermes_cli` tool registry). README `mcp_servers` block
confirmed against the Hermes schema (`command` string, `args` list,
`env` allowed, `timeout`, optional `connect_timeout` — default 60 s per
`tools/mcp_tool.py`); `connect_timeout: 60` made explicit. `PROTOCOL.md`
pairing section rewritten for per-browser pins, `rotate: true`, legacy `*`
migration, and env-pin semantics.

## Static checks

| Check | Result |
|---|---|
| `node --check background.js sidepanel.js` | PASS (both) |
| `PYTHONPATH= py -3.14 -m py_compile browser-mcp.py` (PYTHONPYCACHEPREFIX → temp) | PASS |
| `__pycache__` absent from repo root (Chrome/Edge load rule) | PASS |
| Relay `127.0.0.1:17645` responds (any HTTP reply) | PASS (404 body) |

## Pairing matrix (live server)

Server: `PYTHONPATH= py -3.14 -u browser-mcp.py` (stdio feeder keeps stdin
open), WS hub on `127.0.0.1:8644`, pin file `.live-browser-token` deleted
before the run. Client: `b1_exit_check.py` (websockets 16, user-site for
py -3.14). All results corroborated by server stderr log lines.

| Case | Result | Evidence |
|---|---|---|
| (a) first hello pins TOFU | PASS | log `TOFU paired with extension b1-exit-check v0.1.0 (Chrome) — token pinned to .live-browser-token`; file `{"Chrome": "tok-chrome-1"}` |
| (b) same token re-pairs | PASS | log `paired with extension b1-exit-check v0.1.0 (Chrome)` |
| (c) wrong token rejected | PASS | response `{id: null, ok: false, error: "bad token"}` then close code **4401**; log `rejected hello: bad token (Chrome)` |
| (d) second browser gets own slot | PASS | log TOFU-paired `(Edge)`; file `{"Chrome": "tok-chrome-1", "Edge": "tok-edge-1"}` |
| (e) rotate:true re-pins a slot | PASS | hello `Chrome` + `rotate: true` + new token → file `{"Chrome": "tok-chrome-2", "Edge": "tok-edge-1"}` (Edge slot untouched) |
| (e2) rotate gate holds | PASS | wrong token without `rotate` → 4401, file unchanged |
| (f) `--reset-pairing` clears the file | PASS | run as cleanup; file gone, log `pairing reset — next extension hello will be re-pinned` |
| (g) env-pin self-pin guard (review fix) | NOT RUN | test execution stopped by instruction; logic: `LIVE_BROWSER_TOKEN` sets `env_pin=True`, disabling the legacy-`*` migration branch so an unpinned browser cannot self-pin around the env token. Code-reviewed in `9c73f94`; exercised only by inspection |

## Test-expectation nuance (4401 close code)

Two server behaviors a pairing harness must respect (both caused false
"FAIL"s in the first harness iteration; the matrix above uses the corrected
expectations):

1. **Successful hello gets NO reply.** The server pairs silently; a client
   must infer pairing from subsequent traffic (e.g. a probe request gets
   `unknown cmd`, not `not paired`). Awaiting a reply on success times out.
2. **Rejection = response, THEN close.** The server sends
   `{"id": null, "ok": false, "error": "bad token"}` and only afterwards
   closes the socket with code `4401`. A test client that expects
   `ConnectionClosedError` on the first `recv()` misreads the rejection as
   a protocol failure — it must consume the response first, then confirm
   the close code on the follow-up `recv()` (all rejections verified as
   `closed:4401` this way).

## Live-world bonus evidence

- While the matrix was running, the user's real extension
  (`dbphlenbnphdemkgmmnmpippleegplco`) connected and its `hello` reported
  browser `(Not=A?Brand)` — a live sighting of the exact
  `userAgentData.brands[0]` placeholder bug fixed in `8b11a58`. Once the
  fixed `background.js` is reloaded in Edge, hello reports the real brand.
- Server stderr shows the extension's auto-reconnect backoff working:
  after the pin file was reset, rejects logged repeatedly (`rejected
  hello: bad token (Edge)`) — expected until the orchestrator restarts
  their server; the next hello then re-pins TOFU automatically.

## Environment notes

- Python: `PYTHONPATH= py -3.14` (machine-global `PYTHONPATH` points at the
  Hermes venv and breaks 3.14 `fastmcp`/`websockets` imports); deps in
  user-site (fastmcp 3.4.7, websockets 16.0).
- Server banner renders mojibake on a GBK console — stderr-only cosmetic.
- `browser-mcp.py` docstring updated in `9c73f94` (per-browser pins,
  `rotate`, env pin, reset semantics; tool naming `mcp__live_browser__*`).
- Orchestrator-owned, left uncommitted and untouched: `CRITIQUE.md`
  (modified), `CRITIQUE_B1.md` (new).
