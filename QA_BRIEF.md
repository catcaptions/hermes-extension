# Task Brief — QA Review (Final Phase)

You are the **QA reviewer**. A planner wrote `PLAN.md`, a critic wrote `CRITIQUE.md`, and an implementer has now modified the code in this repo (Chrome MV3 extension "Hermes Minimal" — vanilla JS, no build step) to:
1. Render markdown (bold, tables, code, lists, links, blockquotes, etc.) in the chat panel
2. Render LaTeX math (`$...$`, `$$...$$`)
3. Render `IMAGE:<path>` / `image:` / `MEDIA:` lines as inline images (with fallback)
4. Auto-refresh messages when the Hermes desktop app adds new ones (no manual reload)

Your job: **verify the implementation, not just read it.**

## Steps

1. Read `TASK_BRIEF.md`, `PLAN.md`, `CRITIQUE.md`, and the git diff (`git status`, `git diff --stat`, `git diff`).
2. Read the modified source files (`sidepanel.js`, `sidepanel.html`, `sidepanel.css`, `manifest.json`, any new `vendor/` files, `README.md`).
3. Run static checks: `node --check sidepanel.js` (and background.js). If vendored libs exist, sanity-check they are real (head of file, version banner) and correctly referenced.
4. Exercise the logic where possible from the terminal:
   - If there is a markdown/image-tag parser function, test it with Node on sample inputs (bold, table, code fence containing `IMAGE:...`, real Windows path `image:C:\Users\lasis\AppData\Roaming\Hermes\composer-images\composer_2026-08-08_13-29-39-364_50bb75.png`, `$x^2$`, `$$...$$`). You can stub browser APIs if needed, or reason statically — report which.
   - Confirm XSS sanitization is applied to assistant AND user content, and that KaTeX/math output survives sanitization.
5. Verify the live-update logic: polling interval, visibility handling, dedup/reconciliation, interaction with streaming state, session switching.
6. Check the README documents the "Allow access to file URLs" requirement and any new setup steps.
7. Check nothing in the change list broke the existing flows: session list, create session, send message, stop, history load, settings.

## Deliverable

Write **`QA_REPORT.md`**: for each of the 4 requirements, VERIFIED / PARTIAL / FAILED with evidence (file/line, command output); list all bugs found (severity + repro); confirm or refute each BLOCKER from CRITIQUE.md; end with a SHIP / SHIP-WITH-FIXES / NO-GO verdict and the exact fix list for anything failing.

Reply with exactly **QA_DONE** + a 3-line summary when finished. You MAY run read-only and test commands (node, curl). Do NOT modify source files unless it is a one-line obvious fix — prefer reporting.
