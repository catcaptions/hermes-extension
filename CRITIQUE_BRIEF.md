# Task Brief — Plan Critique (Phase 2: CRITIQUE ONLY)

You are a **senior engineering reviewer** (red team for plans). A planning agent has written `PLAN.md` in the repo root of this project: a Chrome MV3 extension ("Hermes Minimal") that needs (1) markdown rendering incl. LaTeX math, (2) `IMAGE:path` → inline image rendering, (3) live updates when the Hermes desktop app adds messages, all without a build step, under MV3 CSP (no CDN scripts), with XSS safety.

Your job: read `TASK_BRIEF.md` (the original requirements + verified facts) and `PLAN.md` (the proposed plan), then write a hard-nosed critique to **`CRITIQUE.md`** in the repo root. Do NOT modify any source files.

## What to look for (be specific, reference plan sections)

1. **Correctness of approach** — Is the markdown strategy sound for the constraints? (Vendored libs: are the proposed versions/files real and correctly pinned? Is KaTeX CSS+fonts accounted for? Hand-rolled: does it cover tables + task lists + nested lists + code fences + images safely?) Is DOMPurify/sanitization correct (sanitize AFTER markdown→HTML, allow KaTeX output)? Any XSS hole remaining?
2. **Math rendering soundness** — `$...$` / `$$...$$` handling mid-stream (unclosed math), interplay with markdown emphasis (single `$` vs italics), KaTeX error rendering, performance (KaTeX per token?).
3. **IMAGE: handling** — regex correctness for `IMAGE:`/`image:`/`MEDIA:` prefixes + Windows paths (`C:\Users\...`), detection must skip code blocks and inline code, file:/// URL construction, onerror fallback, and the "Allow access to file URLs" README requirement. Does the plan handle IMAGE lines inside tables/blockquotes? Multi-line paths? Paths with spaces?
4. **Live-update design** — polling interval, reconciliation logic (new messages appended vs full re-render; session switching race conditions; stream-vs-poll conflicts; panel visibility handling; avoiding duplicate messages or flicker; message_count drift). Is polling `GET /api/sessions/{id}/messages` every N seconds acceptable? Any better cheap strategy given no events endpoint?
5. **Streaming performance** — is the per-delta re-render plan sound (debounce, incremental append, markdown parse of partial content)? What breaks with unclosed fences/tables/code mid-stream and is recovery handled on `assistant.completed`?
6. **File-level change list** — anything missing (manifest, CSP, CSS additions, README updates, vendor files), anything over-engineered, anything that violates "no build step / minimal / auditable"?
7. **Testing plan** — is it actually testable? Concrete verification steps? Gaps?
8. **Risks the planner missed.**

## Deliverable

Write **`CRITIQUE.md`**: numbered findings, each with severity (BLOCKER / MAJOR / MINOR / NIT), the plan section it targets, and a concrete recommendation. End with a short verdict (approve / approve-with-changes / reject) and the top 3 things the implementer must not get wrong.

Reply with exactly **CRITIQUE_DONE** + a 3-line summary when finished. Read-only commands only; do not edit source files.
