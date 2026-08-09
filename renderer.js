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
 *   - media lines (IMAGE:/image:/MEDIA:/media:) and math are extracted only
 *     OUTSIDE fenced code and outside 4-space indented code blocks
 *     (GFM: ≥4 leading spaces after a blank line ⇒ code).
 *   - media lines are standalone-line only: `> IMAGE:…` / `- IMAGE:…` stay
 *     literal (Hermes emits media tags as standalone lines).
 *   - media wins over math on the same line (value taken verbatim).
 *   - `$` math: no whitespace adjacent to the delimiters, escaped `\$` is
 *     literal, `$$…$$` / `\[…\]` (any line position) render as display math.
 *   - ponytail: `$` inside backtick code spans is read as math (same as
 *     markdown-it-katex etc.). Refinement path: a marked walkTokens pass
 *     exempting codespan tokens.
 */
'use strict';

const BLOCK_MATH_RE = /\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]/g;
const MEDIA_RE = /^\s*(?:IMAGE|MEDIA)\s*:\s*(.+?)\s*$/i;
const FENCE_RE = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/;
const INDENT_RE = /^(?: {4,}|\t)/;

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

/**
 * Pass 1: split content into code regions (fenced / indented) and text
 * regions; in text regions extract media lines and math into sentinels.
 * Returns { scrubbed, math, media, nonce }.
 */
function extractTokens(text) {
  const n = nonce();
  const math = [];
  const media = [];
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
    for (const line of scrubbed.split('\n')) {
      out.push(line.includes('⟦') ? line : replaceInline(line, n, math));
    }
    run = [];
  };

  for (const line of lines) {
    if (line.trim() === '') {
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

  return { scrubbed: out.join('\n'), math, media, nonce: n };
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
function fingerprint(msgs) {
  return JSON.stringify((msgs || []).map((m) => `${m && m.role}\u0000${m && m.content != null ? String(m.content) : ''}`));
}

const api = { extractTokens, scanInlineMath, mediaUrl, fingerprint };

if (typeof module !== 'undefined' && module.exports) module.exports = api;
else globalThis.renderer = api;
