# TASK_BRIEF_5 — session switching during active stream + running indicator

Repo: `C:\projects\browser-extensions\hermes-minimal-extension` (HEAD `9002b39`; 62 renderer tests green).

## User feedback (verbatim essence)

1. "i cant switch between sessions while one is ongoing."
2. "i also dont have any visual indicators on the sessions to show that they are running."

## Required changes (sidepanel.js + CSS)

### A. Allow switching sessions while a stream is in flight
- Track the active stream's `AbortController` in a module-level var (e.g. `activeStreamAbort`).
- On session switch (`selectSession` / dropdown change): if a stream is active, `activeStreamAbort.abort()` first, clear the streaming state, then load the target session. No UI lock — the switch must always work.
- When a stream ends (done/error/abort), clear the controller ref.
- The gateway run may continue server-side after an abort; that's fine — results appear via the 3 s poll; the abort just frees the client.

### B. Running indicator in the session list
- When a stream is active, show a visual marker on the ACTIVE session in the session dropdown/list:
  - A small pulsing dot (CSS `@keyframes pulse`) + the session title, e.g. `● New chat …` with the dot colored (accent green) — style consistent with the existing UI (look at sidepanel.css existing classes).
  - Clear it when the stream ends (done/error/abort).
- Also reflect running state in the current session header if the header shows the session name (nice-to-have, do it if the header exists and it's a 3-line change; otherwise dropdown-only).

## Constraints
- Keep 62/62 renderer tests green; `node --check sidepanel.js`.
- Don't touch renderer.js / media-bridge.py in this task.
- Commit; reply exactly `SWITCH_INDICATOR_DONE` + 2-line summary.
