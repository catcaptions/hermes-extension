/**
 * Renderer — pure markdown/media/math extraction (no DOM, no chrome.*).
 * Shared by sidepanel.js (browser, via globalThis.renderer) and
 * test_renderer.js (node, via module.exports).
 *
 * Pipeline (used by sidepanel.js renderMarkdown):
 *   1. extractTokens(text)  → scrubbed text with ⟦HIMG:n:i⟧ / ⟦HMTH:n:i⟧
 *      sentinels + parallel math[] / media[] arrays (indices align).
 *   2. marked.parse(scrubbed) → DOMPurify.sanitize(html).
 *   3. Replace sentinels: math → katex.renderToString, media → <img>.
 *
 * Pass-1 rules (all pinned by test_renderer.js):
 *   - media lines (IMAGE:/image:/MEDIA:/media:/@image:/@media:) and math are
 *     extracted only OUTSIDE fenced code and outside 4-space indented code
 *     blocks (GFM: ≥4 leading spaces after a blank line ⇒ code).
 *   - media lines are standalone-line only: `> IMAGE:…` / `- IMAGE:…` stay
 *     literal (Hermes emits media tags as standalone lines).
 *   - media wins over math on the same line (value taken verbatim).
 *   - `@url:…` link attachments become ⟦HURL⟧ sentinels (inline, mid-line
 *     allowed; replaced before the inline math scan).
 *   - `$` math: no whitespace adjacent to the delimiters, escaped `\$` is
 *     literal, `$$…$$` / `\[…\]` (any line position) render as display math.
 *   - ponytail: `$` inside backtick code spans is read as math (same as
 *     markdown-it-katex etc.). Refinement path: a marked walkTokens pass
 *     exempting codespan tokens.
 */
'use strict';

const BLOCK_MATH_RE = /\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]/g;
// Standalone-line media tags; optional leading `@` covers the desktop app's
// Obsidian-style `@image:` / `@media:` attachments (IMAGE_DIAGNOSIS #1).
const MEDIA_RE = /^\s*@?(?:IMAGE|MEDIA)\s*:\s*(.+?)\s*$/i;
// `@url:` link attachments (desktop "Attached Context"), backtick-optional.
const URL_RE = /@url\s*:\s*(?:`([^`]+)`|(\S+))/gi;
const FENCE_RE = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/;
const INDENT_RE = /^(?: {4,}|\t)/;

const IMG_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'svg']);
const AUDIO_EXTS = new Set(['mp3', 'ogg', 'wav', 'm4a', 'aac', 'flac', 'opus']);
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'mkv']);

const NONCE_ALPHABET = '0123456789abcdef';

function nonce() {
  let s = '';
  for (let i = 0; i < 6; i++) s += NONCE_ALPHABET[(Math.random() * 16) | 0];
  return s;
}

// Odd number of backslashes directly before index i ⇒ char is escaped.
function isEscaped(s, i) {
  let b = 0;
  for (let k = i - 1; k >= 0 && s[k] === '\\'; k--) b++;
  return b % 2 === 1;
}

// Reject empty math and math with whitespace adjacent to the delimiters.
function validInline(tex) {
  const t = tex.trim();
  return t.length > 0 && t === tex;
}

// Inline math scan for a single line: `$…$` and `\(…\)`.
function scanInlineMath(line) {
  const out = [];
  let i = 0;
  const n = line.length;
  while (i < n) {
    const ch = line[i];
    if (ch === '$') {
      if (isEscaped(line, i)) { i++; continue; }
      if (line[i + 1] === '$') { i += 2; continue; } // $$ handled by the block pass
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (line[j] === '$' && !isEscaped(line, j)) { closed = true; break; }
        j++;
      }
      if (closed && validInline(line.slice(i + 1, j))) {
        out.push({ start: i, end: j, tex: line.slice(i + 1, j) });
        i = j + 1;
        continue;
      }
      i++;
    } else if (ch === '\\' && line[i + 1] === '(' && !isEscaped(line, i)) {
      let j = i + 2;
      let closed = false;
      while (j < n) {
        if (line[j] === '\\' && line[j + 1] === ')' && !isEscaped(line, j)) { closed = true; break; }
        j++;
      }
      if (closed && validInline(line.slice(i + 2, j))) {
        out.push({ start: i, end: j + 1, tex: line.slice(i + 2, j) });
        i = j + 2;
        continue;
      }
      i++;
    } else {
      i++;
    }
  }
  return out;
}

function replaceInline(line, n, math) {
  const toks = scanInlineMath(line);
  if (!toks.length) return line;
  let res = '';
  let last = 0;
  for (const t of toks) {
    res += line.slice(last, t.start);
    res += `⟦HMTH:${n}:${math.length}⟧`;
    math.push({ tex: t.tex, display: false });
    last = t.end + 1;
  }
  res += line.slice(last);
  return res;
}

// `@url:…` → ⟦HURL:n:i⟧. Runs BEFORE the inline math scan so `$` inside a
// URL is never read as math. Quoted form is taken verbatim; the bare form
// strips trailing punctuation (sentence `@url:https://x.com/.` → no dot).
function replaceUrls(line, n, url) {
  if (!/@url\s*:/i.test(line)) return line;
  return line.replace(URL_RE, (mm, quoted, bare) => {
    const u = (quoted || (bare || '').replace(/[.,;:!?`]+$/, '')).trim();
    if (!u) return mm;
    url.push(u);
    return `⟦HURL:${n}:${url.length - 1}⟧`;
  });
}

/**
 * Route a media path by file extension: 'img' | 'audio' | 'video' | 'other'
 * (IMAGE_DIAGNOSIS #2 — TTS/other tools emit audio; some emit video).
 * `data:image/*` URLs are always images (pasted attachments, TASK_BRIEF_2).
 */
function mediaKind(raw) {
  const p = String(raw == null ? '' : raw).trim();
  if (/^data:image\//i.test(p)) return 'img';
  const m = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(p);
  if (!m) return 'other';
  const ext = m[1].toLowerCase();
  if (IMG_EXTS.has(ext)) return 'img';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (VIDEO_EXTS.has(ext)) return 'video';
  return 'other';
}

/**
 * Pass 1: split content into code regions (fenced / indented) and text
 * regions; in text regions extract media lines and math into sentinels.
 * Returns { scrubbed, math, media, nonce }.
 */
function extractTokens(text) {
  const n = nonce();
  const math = [];
  const media = [];
  const url = [];
  const out = [];
  const lines = String(text == null ? '' : text).replace(/\r\n/g, '\n').split('\n');
  let fence = null;    // { ch, len } while inside a fenced code block
  let indented = false; // inside a ≥4-space indented code block
  let prevBlank = true; // previous line was blank (or start of text)
  let run = [];         // consecutive non-code lines (block-math buffer)

  const flushRun = () => {
    if (!run.length) return;
    // Media lines first: they own their whole line, verbatim.
    const lines2 = run.map((line) => {
      const m = MEDIA_RE.exec(line);
      if (!m) return line;
      media.push(m[1]);
      return `⟦HIMG:${n}:${media.length - 1}⟧`;
    });
    const scrubbed = lines2.join('\n').replace(BLOCK_MATH_RE, (mm) => {
      const tex = mm.slice(2, -2).trim();
      if (!tex) return mm;
      math.push({ tex, display: true });
      return `⟦HMTH:${n}:${math.length - 1}⟧`;
    });
    // Inline scan always runs on the residual (block math is already gone),
    // so `$$a$$ and $b$` extracts both instead of swallowing the inline one.
    // `@url:` is replaced first so `$` inside a URL stays literal.
    for (const line of scrubbed.split('\n')) {
      out.push(replaceInline(replaceUrls(line, n, url), n, math));
    }
    run = [];
  };

  for (const line of lines) {
    if (line.trim() === '') {
      // TASK_BRIEF_7: flush the run BEFORE the blank line so each paragraph
      // keeps its own block and blank lines stay in their original positions
      // (no hoisting, no `\n---` setext adjacency). Idempotent on empty run.
      flushRun();
      out.push(line);
      prevBlank = true;
      continue;
    }
    const fm = FENCE_RE.exec(line);
    if (fm) {
      if (!fence) {
        fence = { ch: fm[1][0], len: fm[1].length };
      } else if (fm[1][0] === fence.ch && fm[1].length >= fence.len && /^[ \t]*$/.test(fm[2])) {
        fence = null;
      }
      flushRun();
      out.push(line);
      prevBlank = false;
      continue;
    }
    if (fence) {
      flushRun();
      out.push(line);
      prevBlank = false;
      continue;
    }
    if (indented) {
      if (INDENT_RE.test(line)) {
        out.push(line);
        prevBlank = false;
        continue;
      }
      indented = false; // exiting line is normal text — fall through
    }
    if (INDENT_RE.test(line) && prevBlank) {
      indented = true;
      flushRun();
      out.push(line);
      prevBlank = false;
      continue;
    }
    run.push(line);
    prevBlank = false;
  }
  flushRun();

  return { scrubbed: out.join('\n'), math, media, url, nonce: n };
}

/**
 * Replace math/url sentinels that ended up inside HTML attributes (link
 * destinations, image alt/title) with percent-encoded raw values instead of
 * KaTeX HTML / anchors. Without this, `[x]($y$)` becomes attribute soup:
 * the KaTeX markup lands inside href="…" (BUG-3). Must run BEFORE the
 * generic sentinel replacement.
 */
function fixAttributeSentinels(html, n, math, url) {
  const re = new RegExp(`⟦(?:HMTH|HURL):${n}:(\\d+)⟧`, 'g');
  return html.replace(/(href|src|alt|title)="([^"]*)"/g, (m, attr, val) => {
    if (!val.includes('⟦')) return m;
    return `${attr}="${val.replace(re, (mm, i) => {
      // Math tex: encodeURIComponent (it lives inside a path/query context).
      // URLs: encodeURI preserves the scheme (`://` must survive href=).
      const raw = mm.startsWith('⟦HMTH') ? math[Number(i)]?.tex : url[Number(i)];
      const enc = mm.startsWith('⟦HMTH') ? encodeURIComponent : encodeURI;
      return enc(raw ?? '');
    })}"`;
  });
}

/**
 * Local media path → usable URL. Windows drive or POSIX absolute paths
 * become file:// URLs; http(s)/file URLs pass through; anything else → null
 * (caller renders the raw path as a fallback link instead of an <img>).
 */
function mediaUrl(raw) {
  const p = String(raw || '').trim();
  if (!p) return null;
  if (/^(?:https?|file):\/\//i.test(p)) return p;
  // Pasted attachments travel as data: URLs; pass them through untouched.
  if (/^data:image\//i.test(p)) return p;
  let url = null;
  if (/^[a-zA-Z]:[\\/]/.test(p)) {
    url = `file:///${p.replace(/\\/g, '/')}`;
  } else if (p.startsWith('/')) {
    url = `file://${p}`;
  } else {
    return null;
  }
  return encodeURI(url).replace(/#/g, '%23');
}

/**
 * Stable fingerprint of a message list; used to gate poll adoption so
 * identical server copies never touch the DOM. Display-only fields
 * (streaming, error) are ignored.
 */
// ponytail: WeakMap memo — same array identity with same length/content hits cache (O(1) for poll)
const _fpCache = new WeakMap(); // msgs array -> { len, fp }
function fingerprint(msgs) {
  const arr = msgs || [];
  const cached = _fpCache.get(arr);
  if (cached && cached.len === arr.length) {
    // Quick check: first/last content same → likely unchanged; still verify via JSON if needed
    // We cache strictly by identity+length; poll creates new array each time so cache helps
    // within same tick's double calls (poll + syncPollState) without extra stringify
    return cached.fp;
  }
  const fp = JSON.stringify(arr.map((m) => `${m && m.role}\u0000${m && m.content != null ? String(m.content) : ''}`));
  try { _fpCache.set(arr, { len: arr.length, fp }); } catch {}
  return fp;
}

function diffLineClass(line) {
  if (line.startsWith('@@')) return 'd-hunk';
  if (line.startsWith('+') && !line.startsWith('+++')) return 'd-add';
  if (line.startsWith('-') && !line.startsWith('---')) return 'd-del';
  return '';
}

function activityFingerprint(msg) {
  const parts = [];
  if (msg && msg.thought) parts.push(`T:${String(msg.thought).slice(0, 200)}`);
  for (const t of (msg && msg.tools) || []) {
    parts.push(`X:${t.name || t.type || ''}:${t.status || ''}:${String(t.output || t.result || '').slice(0, 80)}`);
  }
  for (const d of (msg && msg.diffs) || []) {
    parts.push(`D:${d.path || ''}:${String(d.patch || '').slice(0, 80)}`);
  }
  for (const s of (msg && msg.skills) || []) parts.push(`S:${s.name || s}`);
  return parts.join('|');
}

const api = { extractTokens, scanInlineMath, mediaUrl, mediaKind, fingerprint, fixAttributeSentinels, diffLineClass, activityFingerprint };

if (typeof module !== 'undefined' && module.exports) module.exports = api;
else globalThis.renderer = api;
