# IMAGE_DIAGNOSIS — why images "aren't showing well" (orchestrator findings)

Verified against all 34 gateway sessions (real message content) + a node probe of the current renderer. This is the source of truth for the image fix task.

## Findings

1. **PRIMARY BUG — `@image:` prefix is not parsed.**
   The desktop app stores user-attached images as Obsidian-style `@image:<path>` lines. Real data: 22 occurrences across sessions, all `role=user`, all `.png`, e.g.:
   `@image:C:\Users\lasis\AppData\Roaming\Hermes\composer-images\composer_2026-08-08_13-29-39-364_50bb75.png`
   Current `MEDIA_RE` is `/^\s*(?:IMAGE|MEDIA)\s*:\s*(.+?)\s*$/i` — it does NOT match the leading `@`. Probe result:
   ```
   "@image:C:\Users\lasis\a.png" => media: 0 (stays raw text)
   "MEDIA:C:\Users\lasis\b.png" => media: 1 (works)
   "IMAGE:C:\x\c.png"            => media: 1 (works)
   "@media:C:\x\d.mp3"           => media: 0 (stays raw text)
   ```
   So the most common image case (user attaching/pasting an image in the desktop app, then viewing the session in the extension) renders as **raw literal path text** — ugly and definitely "not showing well".

2. **Agent-shared images use `MEDIA:<path>`** (6 occurrences, `role=assistant`, all `.png`, e.g. `MEDIA:C:\Users\lasis\OneDrive\Documentos\ObsidianVault\Study\images\trig_sech_vs_gaussian.png`). These ARE parsed and rendered as `<img src="file:///...">` — but only load when Edge's "Allow access to file URLs" is enabled (user was told where to click; also they must reload the extension after toggling so messages re-render — failed images are cached per message).

3. **`[media attachment]` tags: NOT present in real content.** Earlier notes claimed they exist — a full scan shows zero real occurrences (only pasted text inside tool outputs). Do not special-case them; harmless if a `MEDIA:`-less tag ever appears (leave as text).

4. **`@url:` link attachments exist** (desktop "Attached Context" links), e.g. `@url:\`https://canvasui.dev/\`` — sometimes inline mid-sentence, backtick-quoted. Currently raw text. SECONDARY fix.

5. **Gateway serves no media over HTTP** (probed /media /files /api/files /attachments /uploads /static → all 404; api-server docs confirm no file-serving route). So local-file display requires `file://` + the browser's file-URL access toggle. The extension cannot fetch these via fetch()/http.

## Required changes (implementation via opencode — this repo)

1. **Extend the media line regex** to accept an optional `@` prefix, standalone-line-only (keep the existing fence/indent guards):
   `^\s*@?(?:IMAGE|MEDIA)\s*:\s*(.+?)\s*$/i` — covers `@image:`, `@media:`, `IMAGE:`, `MEDIA:`, `image:`, `media:`.
2. **Route by file extension** in `imgHtml`/media rendering (all real data is .png today, but TTS/other tools will emit audio/video):
   - image (png|jpe?g|gif|webp|bmp|avif|svg) → existing `<img class="hm-img">`
   - audio (mp3|ogg|wav|m4a|aac|flac|opus) → `<audio controls class="hm-media" src=...>`
   - video (mp4|webm|mov|mkv) → `<video controls class="hm-media" src=...>`
   - anything else → existing fallback anchor link
   - Keep the existing onerror → fallback-link behavior for images; audio/video errors → swap to fallback anchor too.
3. **`@url:` inline links (secondary):** convert `@url:\`?URL\`?` (backtick-optional) to a clickable link. Recommend a pre-parse replacement in `renderMarkdown` (e.g. regex → `[$1]($1)` before `marked.parse`) OR a sentinel like media. Must not fire inside code fences (reuse the token pass-1 if simple; a fence-aware approach is preferred — decide what's cleanest given the existing pipeline).
4. **CSS:** add `.msg-body .hm-media { max-width: 100%; margin: 8px 0; }` (audio/video).
5. **Tests** (test_renderer.js) — add cases:
   - `@image:C:\...\a.png` → extracted, media count 1
   - `@media:C:\...\d.mp3` → extracted
   - `MEDIA:C:\...\x.mp3` → extracted (audio routing is a sidepanel concern; renderer just extracts)
   - `@image:` inside fenced code → NOT extracted (guard preserved)
   - path with spaces (`@image:C:\Users\lasis\My Folder\pic.png`) → URL-encoded file:// URL
   - `@url:`https://example.com/`` → converted to link (if implemented in renderer)
   - mixed `text\n@image:C:\x\e.png\ntext` → extracted
6. **README** (already being updated for BUG-4): mention `@image:`/`MEDIA:` rendering + the file-URL toggle + reload-after-toggle note.

## Verification (unit level, no browser)
`node --check` on changed files; `node test_renderer.js` all pass (existing 39 + new).
Browser-level verification is the USER's job (they verify manually in Edge — no browser automation).
