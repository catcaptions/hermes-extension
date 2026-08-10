/**
 * Hermes Minimal — ChatGPT-style side panel client.
 * Talks to local Hermes gateway REST + SSE (no build step).
 */

const STORAGE_KEY = 'hermesMinimal';
const DEFAULTS = {
  gatewayUrl: 'http://127.0.0.1:8642',
  apiKey: '',
  sessionId: '',
  sessionTitle: 'New chat',
  browserUse: false, // UI only in v1
};

// Live updates: cheap polling while the panel is visible and idle.
const POLL_INTERVAL_MS = 3000;
// Grace period after a local stream ends: the gateway may persist the
// final message slightly after run.completed; adopting a server copy that
// is missing it would blink the just-streamed message out (CRITIQUE #5).
const POLL_QUIET_MS = 6000;
// While a stopped/aborted stream's message may never persist, don't let a
// shorter server copy block adoption of newer desktop messages forever.
const POLL_STALE_LIMIT_MS = 30000;
// Trailing-edge throttle for streaming delta re-renders.
const STREAM_RENDER_MS = 60;

// Image paste: downscale before send (gateway POST limit ~1MB, vision
// providers reject oversized data URLs). Cap longest side + total bytes.
const MAX_IMAGE_SIDE = 1280;

const MAX_DATA_URL_BYTES = 350 * 1024;
// Send-time transport (TASK_BRIEF_4): file path via bridge is primary; the
// data URL fallback stays tiny (gateway sanitizer mangles multi-MB args).
const PASTE_MAX_SIDE = 1024;

const DATA_URL_CAP_BYTES = 100 * 1024;
// Local media bridge (media-bridge.py) — the reliable path for local files
// (Edge can't load file:// subresources from extension pages).
const BRIDGE_BASE = 'http://127.0.0.1:8643';
const BRIDGE_HINT = 'local file — start media-bridge.bat, then reload the panel (see README)';

// Hardcoded build stamp so the user can confirm the loaded build at a glance.
const BUILD_STRING = 'build 2026-08-10 0518e6a';

// ── DOM ──────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);
const els = {
  sessionTitle: $('session-title'),
  sessionMenu: $('session-menu'),
  sessionList: $('session-list'),
  sessionEmpty: $('session-empty'),
  settingsPanel: $('settings-panel'),
  settingsStatus: $('settings-status'),
  cfgUrl: $('cfg-url'),
  cfgKey: $('cfg-key'),
  cfgBrowserUse: $('cfg-browser-use'),
  messages: $('messages'),
  emptyState: $('empty-state'),
  banner: $('banner'),
  prompt: $('prompt'),
  btnSend: $('btn-send'),
  composer: $('composer'),
  connDot: $('conn-dot'),
  connLabel: $('conn-label'),
  btnSessions: $('btn-sessions'),
  btnNew: $('btn-new'),
  btnSettings: $('btn-settings'),
  btnCloseSettings: $('btn-close-settings'),
  btnSave: $('btn-save'),
  btnTest: $('btn-test'),
  btnRefreshSessions: $('btn-refresh-sessions'),
  attachStrip: $('attach-strip'),
  preview: $('preview'),
  previewImg: $('preview-img'),
  previewClose: $('preview-close'),
  versionBadge: $('version-badge'),
};

// ── State ────────────────────────────────────────────────────────

let settings = { ...DEFAULTS };
let activeSessionId = '';
let messages = []; // { role, content }
let sending = false;
let abortController = null;
let streamTimer = null;
let streamingSessionId = ''; // session streaming right now (pulse-dot marker)
let pollTimer = null;
let pollInFlight = false;
let lastSeenCount = null;    // message_count from the last session-list poll
let lastFingerprint = null;  // fingerprint of the last rendered message list
let quietUntil = 0;          // poll adoption grace after a local stream ends
let streamEndedAt = 0;       // used for the stale-limit guard
let sessionMissing = false;  // active session 404'd server-side
let bridgeUp = false;        // local media bridge reachable at boot (probe)

// Attachments (pasted/dropped images) awaiting send: { id, name, dataUrl }.
const attachments = [];
let attachId = 1;

// ── Storage ──────────────────────────────────────────────────────

async function loadSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  settings = { ...DEFAULTS, ...(stored[STORAGE_KEY] || {}) };
  activeSessionId = settings.sessionId || '';
  els.cfgUrl.value = settings.gatewayUrl || DEFAULTS.gatewayUrl;
  els.cfgKey.value = settings.apiKey || '';
  els.cfgBrowserUse.checked = Boolean(settings.browserUse);
  els.sessionTitle.textContent = settings.sessionTitle || 'New chat';
}

async function saveSettings( partial = {} ) {
  settings = { ...settings, ...partial };
  await chrome.storage.local.set({ [STORAGE_KEY]: settings });
}

// ── Hermes HTTP client ───────────────────────────────────────────

function baseUrl() {
  return String(settings.gatewayUrl || '').trim().replace(/\/+$/, '');
}

function authHeaders(hasBody = false) {
  const headers = {};
  if (hasBody) headers['Content-Type'] = 'application/json';
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
  return headers;
}

async function hermesFetch(path, options = {}) {
  const base = baseUrl();
  if (!base) throw new Error('Gateway URL is not set.');
  const hasBody = typeof options.body !== 'undefined';
  const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;
  return fetch(url, {
    redirect: 'error',
    ...options,
    headers: { ...authHeaders(hasBody), ...(options.headers || {}) },
  });
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: text.slice(0, 400) };
  }
}

function errorMessage(payload, fallback) {
  const v = payload?.error?.message ?? payload?.error ?? payload?.message ?? fallback ?? 'Request failed';
  // Object errors (unexpected shapes) → compact JSON; long bodies → truncated.
  if (typeof v === 'object' && v !== null) return JSON.stringify(v).slice(0, 300);
  return String(v).slice(0, 400);
}

function rows(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.sessions)) return payload.sessions;
  if (Array.isArray(payload?.messages)) return payload.messages;
  if (Array.isArray(payload?.results)) return payload.results;
  return [];
}

async function listSessions() {
  const res = await hermesFetch('/api/sessions?limit=50&offset=0&order=recent');
  const payload = await readJson(res);
  if (!res.ok) throw new Error(errorMessage(payload, `Session list failed (${res.status})`));
  return rows(payload);
}

async function createSession(title) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const id = `hermes-min-${stamp}-${Math.random().toString(16).slice(2, 8)}`;
  const body = {
    id,
    title: title || `Chat · ${new Date().toLocaleString()}`,
    source: 'hermes_minimal',
  };
  const res = await hermesFetch('/api/sessions', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const payload = await readJson(res);
  if (!res.ok) throw new Error(errorMessage(payload, `Create session failed (${res.status})`));
  const session = payload.session || payload;
  return {
    id: session.id || id,
    title: session.title || body.title,
  };
}

async function getMessages(sessionId) {
  const res = await hermesFetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages`);
  const payload = await readJson(res);
  if (!res.ok) throw new Error(errorMessage(payload, `Load messages failed (${res.status})`));
  return rows(payload).map(normalizeMessage).filter(Boolean);
}

function normalizeMessage(row) {
  if (!row || typeof row !== 'object') return null;
  const role = String(row.role || row.sender || '').toLowerCase();
  if (role !== 'user' && role !== 'assistant' && role !== 'system') return null;
  let content = row.content ?? row.message ?? row.text ?? '';
  if (Array.isArray(content)) {
    content = content
      .map((part) => (typeof part === 'string' ? part : part?.text || part?.content || ''))
      .filter(Boolean)
      .join('\n');
  }
  content = String(content || '').trim();
  if (!content && role !== 'assistant') return null;
  return { role: role === 'system' ? 'assistant' : role, content };
}

async function testConnection() {
  const res = await hermesFetch('/v1/health');
  const payload = await readJson(res);
  if (!res.ok) throw new Error(errorMessage(payload, `Health check failed (${res.status})`));
  // Authenticated check
  const res2 = await hermesFetch('/api/sessions?limit=1');
  const payload2 = await readJson(res2);
  if (!res2.ok) throw new Error(errorMessage(payload2, `Auth failed (${res2.status})`));
  return payload;
}

// ── SSE streaming ────────────────────────────────────────────────

function parseSseBlock(block = '') {
  const event = { type: 'message', data: '' };
  for (const line of String(block).split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) event.type = line.slice(6).trim();
    if (line.startsWith('data:')) event.data += `${line.slice(5).trim()}\n`;
  }
  event.data = event.data.trim();
  try {
    event.json = event.data ? JSON.parse(event.data) : {};
  } catch {
    event.json = {};
  }
  return event;
}

function reduceAssistantText(state, type, data) {
  const current = { text: String(state.text || ''), finalized: Boolean(state.finalized) };
  if (type === 'assistant.delta' && data.delta && !current.finalized) {
    return { text: `${current.text}${data.delta}`, finalized: false };
  }
  if (type === 'assistant.completed' && data.content != null) {
    return { text: String(data.content), finalized: true };
  }
  if (type === 'run.completed') {
    if (current.finalized && current.text) return current;
    const msgs = Array.isArray(data.messages) ? data.messages : [];
    const parts = msgs
      .filter((m) => m?.role === 'assistant' && m.content)
      .map((m) => String(m.content).trim())
      .filter(Boolean);
    if (parts.length) return { text: parts[parts.length - 1], finalized: current.finalized };
    if (data.content) return { text: String(data.content), finalized: current.finalized };
  }
  return current;
}

async function readHermesSse(response, { onAssistant, signal } = {}) {
  if (!response?.body) throw new Error('Stream returned no body.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let stream = { text: '', finalized: false };

  const processBlock = (block) => {
    const event = parseSseBlock(block);
    const data = event.json || {};
    if (['assistant.delta', 'assistant.completed', 'run.completed'].includes(event.type)) {
      stream = reduceAssistantText(stream, event.type, data);
      onAssistant?.(stream.text, { finalized: stream.finalized, event: event.type });
    }
    if (event.type === 'run.completed') return true;
    if (event.type === 'error') {
      throw new Error(data.message || event.data || 'Hermes stream error');
    }
    return false;
  };

  while (true) {
    if (signal?.aborted) {
      await reader.cancel().catch(() => {});
      throw new DOMException('Stopped', 'AbortError');
    }
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || '';
    let terminal = false;
    for (const block of blocks) {
      if (!block.trim()) continue;
      terminal = processBlock(block) || terminal;
      if (terminal) break;
    }
    if (terminal) {
      await reader.cancel().catch(() => {});
      return stream.text;
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) processBlock(buffer);
  return stream.text;
}

// ── UI helpers ───────────────────────────────────────────────────

function setConnection(state, label) {
  // state: online | offline | busy
  els.connDot.className = `dot ${state}`;
  els.connLabel.textContent = label;
}

function showBanner(text, kind = 'error') {
  if (!text) {
    els.banner.classList.add('hidden');
    els.banner.textContent = '';
    return;
  }
  els.banner.textContent = text;
  els.banner.classList.toggle('info', kind === 'info');
  els.banner.classList.remove('hidden');
}

function setSending(on) {
  sending = on;
  if (!on) updateRunningIndicator();
  els.btnSend.classList.toggle('busy', on);
  // While streaming: button becomes Stop (still enabled). Otherwise: Send.
  if (on) {
    els.btnSend.disabled = false;
    els.btnSend.title = 'Stop';
    els.btnSend.setAttribute('aria-label', 'Stop');
    els.prompt.disabled = true;
    setConnection('busy', 'Hermes is working…');
  } else {
    els.btnSend.title = 'Send';
    els.btnSend.setAttribute('aria-label', 'Send');
    els.prompt.disabled = false;
    updateSendDisabled();
  }
}

function autoResizePrompt() {
  const el = els.prompt;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  updateSendDisabled();
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Image paste / attachments ────────────────────────────────────

function updateSendDisabled() {
  const hasText = Boolean(els.prompt.value.trim());
  els.btnSend.disabled = sending || (!hasText && attachments.length === 0) || !settings.apiKey;
}

function renderChips() {
  els.attachStrip.classList.toggle('hidden', attachments.length === 0);
  els.attachStrip.innerHTML = '';
  for (const a of attachments) {
    const chip = document.createElement('div');
    chip.className = 'chip';
    chip.title = a.name;
    // Thumb is a data: URL we built ourselves — no sanitization needed.
    const thumb = document.createElement('img');
    thumb.src = a.dataUrl;
    thumb.alt = '';
    const label = document.createElement('span');
    label.textContent = a.name;
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'chip-x';
    x.textContent = '×';
    x.title = 'Remove attachment';
    x.setAttribute('aria-label', `Remove ${a.name}`);
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      const i = attachments.findIndex((it) => it.id === a.id);
      if (i >= 0) attachments.splice(i, 1);
      renderChips();
      updateSendDisabled();
    });
    chip.appendChild(thumb);
    chip.appendChild(label);
    chip.appendChild(x);
    chip.addEventListener('click', () => openPreview(a.dataUrl, a.name));
    els.attachStrip.appendChild(chip);
  }
  updateSendDisabled();
}

function loadImageEl(dataUrl) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('Image decode failed'));
    im.src = dataUrl;
  });
}

// Downscale to ≤MAX_IMAGE_SIDE and ≤MAX_DATA_URL_BYTES (PNG first; JPEG
// fallback loop for photos/large captures). Never throws — callers fall
// back to the original data URL on any canvas failure.
async function downscaleImage(dataUrl) {
  const img = await loadImageEl(dataUrl);
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  let w = Math.max(1, Math.round(img.naturalWidth * scale));
  let h = Math.max(1, Math.round(img.naturalHeight * scale));
  const draw = (tw, th, mime, q) => {
    const c = document.createElement('canvas');
    c.width = tw;
    c.height = th;
    c.getContext('2d').drawImage(img, 0, 0, tw, th);
    return c.toDataURL(mime, q);
  };
  try {
    let out = draw(w, h, 'image/png');
    if (out.length > MAX_DATA_URL_BYTES) {
      out = draw(w, h, 'image/jpeg', 0.82);
      let guard = 0;
      while (out.length > MAX_DATA_URL_BYTES && w > 64 && guard++ < 6) {
        w = Math.max(1, Math.round(w * 0.7));
        h = Math.max(1, Math.round(h * 0.7));
        out = draw(w, h, 'image/jpeg', 0.82);
      }
    }
    return out;
  } catch {
    return dataUrl;
  }
}

function addAttachment(file, dataUrl) {
  const name = (file && file.name) || `image-${attachId}.png`;
  attachments.push({ id: attachId++, name, dataUrl });
  renderChips();
}

// ── Send-time transport (TASK_BRIEF_4): bridge file path > capped data URL ──

// Send-time encode: ≤PASTE_MAX_SIDE px, JPEG q0.80 (PNG for alpha-capable
// sources) — small blobs, small args.
async function encodeForSend(dataUrl) {
  const img = await loadImageEl(dataUrl);
  const mime = /^data:(image\/\w+);/i.exec(dataUrl)?.[1] || 'image/png';
  const scale = Math.min(1, PASTE_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').drawImage(img, 0, 0, w, h);
  return mime === 'image/jpeg' ? c.toDataURL('image/jpeg', 0.8) : c.toDataURL('image/png');
}

function dataUrlToBlob(dataUrl) {
  const [head, b64] = dataUrl.split(',');
  const mime = /^data:(.*?);/i.exec(head)?.[1] || 'image/png';
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

// POST encoded bytes to the bridge /save → absolute path the message
// carries as @image:C:\... (tiny tool arg; vision_analyze reads the file
// itself). Null on any failure → caller falls back to a capped data URL.
async function saveImageToBridge(dataUrl) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 5000);
  try {
    const res = await fetch(`${BRIDGE_BASE}/save`, {
      method: 'POST',
      headers: { 'Content-Type': /^data:(.*?);/i.exec(dataUrl)?.[1] || 'image/png' },
      body: dataUrlToBlob(dataUrl),
      signal: ac.signal,
    });
    if (!res.ok) return null;
    const j = await readJson(res);
    return j && j.ok && typeof j.path === 'string' ? j.path : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Fallback transport: data URL capped ~DATA_URL_CAP_BYTES (re-encode 640px
// q0.6 once; best effort if still over). Never throws.
async function cappedDataUrl(dataUrl) {
  if (String(dataUrl).length <= DATA_URL_CAP_BYTES) return dataUrl;
  try {
    const img = await loadImageEl(dataUrl);
    const scale = Math.min(1, 640 / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    return c.toDataURL('image/jpeg', 0.6);
  } catch {
    return dataUrl;
  }
}

function ingestImageFile(file) {
  if (!file || !file.type || !file.type.startsWith('image/')) return;
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = String(reader.result || '');
    downscaleImage(dataUrl)
      .then((scaled) => addAttachment(file, scaled))
      .catch(() => addAttachment(file, dataUrl));
  };
  reader.readAsDataURL(file);
}

function openPreview(dataUrl, name) {
  els.previewImg.src = dataUrl;
  els.previewImg.alt = name || '';
  els.preview.classList.remove('hidden');
}

function closePreview() {
  els.preview.classList.add('hidden');
  els.previewImg.src = '';
}

// ── Markdown / math / image rendering ──────────────────────────

function basename(path) {
  return String(path).split(/[\\/]/).pop() || path;
}

function mathHtml(item) {
  if (!item) return '';
  try {
    return katex.renderToString(item.tex, {
      throwOnError: false,
      displayMode: Boolean(item.display),
      output: 'html',
    });
  } catch {
    // KaTeX never throws with throwOnError:false, but never break a message.
    return escapeHtml(item.tex);
  }
}

// Bridge URL for local absolute paths (bridge serves them without the
// browser's file-URL toggle). data:/http(s) are not bridge candidates.
function bridgeUrl(raw) {
  const p = String(raw || '').trim();
  if (!/^[a-zA-Z]:[\\/]/.test(p) && !p.startsWith('/')) return null;
  return `${BRIDGE_BASE}/media?path=${encodeURIComponent(p)}`;
}

// Boot-time bridge probe: any HTTP response (200/403/404) means UP; a
// network error means DOWN. Non-blocking, ~1.5s cap. When DOWN, media uses
// file:// and the existing error chain probes the bridge again per item.
async function probeBridge() {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 1500);
  try {
    await fetch(`${BRIDGE_BASE}/media?path=probe`, { signal: ac.signal });
    bridgeUp = true;
  } catch {
    bridgeUp = false;
  } finally {
    clearTimeout(timer);
  }
}

// Route media by extension (renderer.mediaKind): img → <img>, audio/video →
// <audio>/<video controls>, anything else → fallback block. srcOverride
// lets a bridge-served element re-render with the bridge URL (no error
// churn on every streamed delta).
function mediaElementHtml(raw, idx, srcOverride) {
  // Bridge-first: Edge cannot load file:// subresources from extension
  // pages (even with "Allow access to file URLs" on); the bridge is the
  // reliable path for local absolute paths. data:/http(s) pass through
  // untouched (bridgeUrl returns null for them). When the bridge is down,
  // fall back to file:// and let the error chain probe it again.
  const bridge = bridgeUrl(raw);
  const url = srcOverride || (bridgeUp && bridge ? bridge : renderer.mediaUrl(raw));
  const kind = renderer.mediaKind(raw);
  if (kind === 'img') {
    return `<img class="hm-img" data-hm-idx="${idx}" src="${escapeHtml(url || raw)}" alt="${escapeHtml(basename(raw))}">`;
  }
  if (kind === 'audio') {
    return `<audio class="hm-media" data-hm-idx="${idx}" controls preload="none" src="${escapeHtml(url || '')}"></audio>`;
  }
  if (kind === 'video') {
    return `<video class="hm-media" data-hm-idx="${idx}" controls preload="none" src="${escapeHtml(url || '')}"></video>`;
  }
  return fallbackBlockHtml(raw);
}

// Compact failure block: clickable path + actionable hint (TASK_BRIEF_2 #3).
function fallbackBlockHtml(raw) {
  const url = renderer.mediaUrl(raw);
  const href = escapeHtml(url || '');
  return `<a class="hm-img-fallback" href="${href}" title="${escapeHtml(raw)}">${escapeHtml(raw)}</a><span class="hm-hint">${escapeHtml(BRIDGE_HINT)}</span>`;
}

function renderMarkdown(text, ctx, tokens) {
  const { scrubbed, math, media, url, nonce } = tokens || renderer.extractTokens(text || '');
  const failed = ctx?.failed || new Set();
  const bridged = ctx?.bridged || new Set();
  let html;
  try {
    html = marked.parse(scrubbed, { gfm: true, breaks: true });
  } catch {
    html = escapeHtml(scrubbed);
  }
  // Sanitize BEFORE any of our own HTML is introduced; media/math/url tags
  // are constructed by us below and never pass through DOMPurify (CRITIQUE:
  // the default allowlist would strip file: URIs anyway).
  html = DOMPurify.sanitize(html);
  // Sentinels inside attributes (link destinations, img alt/title) become
  // percent-encoded raw values, not HTML (BUG-3). Before the generic pass.
  html = renderer.fixAttributeSentinels(html, nonce, math, url);
  html = html.replace(new RegExp(`⟦HMTH:${nonce}:(\\d+)⟧`, 'g'), (m, i) => mathHtml(math[Number(i)]));
  html = html.replace(new RegExp(`⟦HIMG:${nonce}:(\\d+)⟧`, 'g'), (m, i) => {
    const raw = media[Number(i)];
    if (raw == null) return '';
    // Known-failed media render as their fallback block directly, so a
    // streamed re-render never fires another error event (CRITIQUE #11).
    if (failed.has(Number(i))) return fallbackBlockHtml(raw);
    return mediaElementHtml(raw, Number(i), bridged.has(Number(i)) ? bridgeUrl(raw) : null);
  });
  html = html.replace(new RegExp(`⟦HURL:${nonce}:(\\d+)⟧`, 'g'), (m, i) => {
    const u = url[Number(i)];
    return u ? `<a class="hm-url" href="${escapeHtml(u)}" target="_blank" rel="noopener">${escapeHtml(u)}</a>` : '';
  });
  return html;
}

function fallbackBlockEl(raw) {
  const a = document.createElement('a');
  a.className = 'hm-img-fallback';
  const url = renderer.mediaUrl(raw);
  if (url) a.href = url;
  a.title = raw;
  a.textContent = raw;
  const hint = document.createElement('span');
  hint.className = 'hm-hint';
  hint.textContent = BRIDGE_HINT;
  const wrap = document.createElement('span');
  wrap.className = 'hm-fallback';
  wrap.append(a, hint);
  return wrap;
}

// Error chain for a failed element: file:// failed → try the local media
// bridge once (probe element) → only then mark failed + show the hint
// block. The `failed`/`bridged` sets drive re-renders so streaming never
// churns (CRITIQUE #11; TASK_BRIEF_2 #3).
function attachMediaFallbacks(scope, msg) {
  const failed = msg._failedImgs || (msg._failedImgs = new Set());
  const bridged = msg._bridged || (msg._bridged = new Set());
  for (const el of scope.querySelectorAll('.hm-img[data-hm-idx], .hm-media[data-hm-idx]')) {
    const idx = Number(el.dataset.hmIdx);
    el.addEventListener('error', () => {
      const raw = msg._media[idx];
      const b = bridgeUrl(raw);
      if (!b) {
        failed.add(idx);
        el.replaceWith(fallbackBlockEl(raw));
        return;
      }
      const probe = document.createElement(el.tagName.toLowerCase());
      probe.className = el.className;
      probe.style.cssText = el.style.cssText;
      probe.src = b;
      const ok = () => {
        bridged.add(idx);
        el.replaceWith(probe);
      };
      const bad = () => {
        failed.add(idx);
        el.replaceWith(fallbackBlockEl(raw));
      };
      if (probe.tagName === 'IMG') {
        probe.onload = ok;
        probe.onerror = bad;
      } else {
        probe.onloadedmetadata = ok;
        probe.onerror = bad;
      }
    }, { once: true });
  }
}

function renderMessageBody(msg) {
  const el = msg._el;
  if (!el) return;
  const body = el.querySelector('.msg-body');
  if (!body) return;
  const failed = msg._failedImgs || (msg._failedImgs = new Set());
  const bridged = msg._bridged || (msg._bridged = new Set());
  const tokens = renderer.extractTokens(msg.content || '');
  msg._media = tokens.media;
  body.innerHTML = renderMarkdown(msg.content, { failed, bridged }, tokens);
  attachMediaFallbacks(body, msg);
}

function scheduleStreamingRender(msg) {
  clearTimeout(streamTimer);
  streamTimer = setTimeout(() => {
    renderMessageBody(msg);
    scrollToBottomIfNear(); // keep the caret in view while the reply grows
  }, STREAM_RENDER_MS);
}

function scrollToBottomIfNear(threshold = 60) {
  const el = els.messages;
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  if (nearBottom || sending) el.scrollTop = el.scrollHeight;
}

function renderMessages() {
  // Keep empty state node; rebuild the rest.
  const kids = [...els.messages.children].filter((n) => n !== els.emptyState);
  for (const n of kids) n.remove();

  const has = messages.length > 0;
  els.emptyState.classList.toggle('hidden', has);

  for (const msg of messages) {
    const div = document.createElement('div');
    div.className = `msg ${msg.role}${msg.streaming ? ' streaming' : ''}${msg.error ? ' error' : ''}`;
    const roleLabel = msg.error ? 'Error' : msg.role === 'user' ? 'You' : 'Hermes';
    div.innerHTML = `<div class="msg-role">${escapeHtml(roleLabel)}</div><div class="msg-body"></div>`;
    msg._el = div;
    els.messages.appendChild(div);
    renderMessageBody(msg);
  }
  scrollToBottomIfNear();
}

function openSettings(open) {
  document.body.classList.toggle('settings-open', open);
  els.settingsPanel.classList.toggle('hidden', !open);
  if (open) {
    els.cfgUrl.value = settings.gatewayUrl || DEFAULTS.gatewayUrl;
    els.cfgKey.value = settings.apiKey || '';
    els.settingsStatus.textContent = '';
    els.settingsStatus.className = 'status';
  }
}

function closeSessionMenu() {
  els.sessionMenu.classList.add('hidden');
}

function sessionLabel(session) {
  return (
    session.title
    || session.name
    || session.id
    || 'Untitled'
  );
}

function renderSessionList(sessions) {
  els.sessionList.innerHTML = '';
  const list = sessions || [];
  els.sessionEmpty.classList.toggle('hidden', list.length > 0);
  for (const s of list) {
    const id = s.id || s.session_id;
    if (!id) continue;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `session-item${id === activeSessionId ? ' active' : ''}`;
    btn.dataset.sid = id;
    btn.innerHTML =
      `<span class="srow"><i class="run-dot" aria-hidden="true"></i><span class="title">${escapeHtml(sessionLabel(s))}</span></span>` +
      `<span class="meta">${escapeHtml(id)}</span>`;
    btn.addEventListener('click', () => selectSession(id, sessionLabel(s)));
    els.sessionList.appendChild(btn);
  }
  updateRunningIndicator();
}

// Running-stream marker (TASK_BRIEF_5): pulsing dot on the streaming
// session in the dropdown + header. Called on stream start/end/switch.
function updateRunningIndicator() {
  const running = Boolean(streamingSessionId && streamingSessionId === activeSessionId);
  els.sessionTitle.classList.toggle('running', running);
  for (const btn of els.sessionList.querySelectorAll('.session-item')) {
    btn.classList.toggle('running', btn.dataset.sid === streamingSessionId);
  }
}

// ── Command popover (TASK_BRIEF_8) ───────────────────────────────
// Generic anchored dropdown — foundation for the `/` skills menu, `@`
// context picker, and model switcher. One popover open at a time; the
// caller owns item semantics and closes/replaces the popover from onSelect.

const CMD_POPOVER_MAX_HEIGHT = 260;

let cmdPopover = null; // { el, listEl, filterEl, items, onSelect, renderItem, filter, visible, highlight, emptyMessage }

function cmdDefaultRow(item) {
  const label = escapeHtml(item?.label ?? '');
  const sub = item?.sublabel ? `<span class="cmd-sublabel">${escapeHtml(item.sublabel)}</span>` : '';
  return `<span class="cmd-label">${label}</span>${sub}`;
}

function cmdClose() {
  if (!cmdPopover) return;
  const pop = cmdPopover;
  cmdPopover = null; // no dangling refs: node + listeners are GC'd with it
  pop.el.remove();
  els.prompt.focus(); // no-op while the prompt is disabled
}

function closeCommandPopover() { cmdClose(); }

function isCommandPopoverOpen() { return Boolean(cmdPopover); }

function setCommandPopoverFilter(text) {
  if (!cmdPopover) return;
  cmdPopover.filter = String(text ?? '');
  cmdRenderList();
}

function cmdPaint() {
  const s = cmdPopover;
  if (!s) return;
  for (const row of s.listEl.querySelectorAll('.cmd-item')) {
    const sel = Number(row.dataset.idx) === s.highlight;
    row.classList.toggle('cmd-hl', sel);
    row.setAttribute('aria-selected', String(sel));
  }
}

function cmdSetHighlight(idx) {
  const s = cmdPopover;
  if (!s || idx === s.highlight || idx < 0 || idx >= s.visible.length) return;
  s.highlight = idx;
  cmdPaint();
  s.listEl.querySelector(`.cmd-item[data-idx="${idx}"]`)?.scrollIntoView({ block: 'nearest' });
}

function cmdMove(delta) {
  const s = cmdPopover;
  const n = s.visible.length;
  if (!n) return;
  const next = s.highlight < 0 ? (delta > 0 ? 0 : n - 1) : (s.highlight + delta + n) % n;
  cmdSetHighlight(next);
}

function cmdSelect(idx) {
  const s = cmdPopover;
  if (!s || !s.visible[idx]) return;
  // Contract: onSelect is called on Enter/click; the caller closes or
  // replaces the popover from there.
  s.onSelect?.(s.visible[idx]);
}

function cmdRow(item, idx) {
  const li = document.createElement('li');
  li.className = 'cmd-item';
  li.dataset.idx = String(idx);
  li.setAttribute('role', 'option');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.innerHTML = cmdPopover.renderItem
    ? cmdPopover.renderItem(item, idx === cmdPopover.highlight)
    : cmdDefaultRow(item);
  btn.addEventListener('click', (e) => { e.stopPropagation(); cmdSelect(idx); });
  li.appendChild(btn);
  li.addEventListener('mousemove', () => cmdSetHighlight(idx));
  return li;
}

function cmdRenderList() {
  const s = cmdPopover;
  const q = s.filter.trim().toLowerCase();
  s.visible = q
    ? s.items.filter((it) => `${it.label ?? ''} ${it.sublabel ?? ''} ${it.group ?? ''}`.toLowerCase().includes(q))
    : [...s.items];
  s.listEl.innerHTML = '';
  if (!s.visible.length) {
    const li = document.createElement('li');
    li.className = 'cmd-empty';
    li.setAttribute('role', 'presentation');
    li.textContent = s.emptyMessage;
    s.listEl.appendChild(li);
    s.highlight = -1;
    return;
  }
  let lastGroup = null;
  s.visible.forEach((item, idx) => {
    if (item.group && item.group !== lastGroup) {
      lastGroup = item.group;
      const h = document.createElement('li');
      h.className = 'cmd-group';
      h.setAttribute('role', 'presentation');
      h.textContent = item.group;
      s.listEl.appendChild(h);
    }
    s.listEl.appendChild(cmdRow(item, idx));
  });
  if (s.highlight >= s.visible.length) s.highlight = s.visible.length - 1;
  else if (s.highlight < 0) s.highlight = s.visible.length ? 0 : -1;
  cmdPaint();
}

// Shared key handling for #prompt and the filter input (spec #3 + #6).
function cmdHandleKey(e) {
  if (!cmdPopover) return;
  switch (e.key) {
    case 'ArrowDown': e.preventDefault(); cmdMove(1); break;
    case 'ArrowUp': e.preventDefault(); cmdMove(-1); break;
    case 'Enter':
      e.preventDefault(); // never submit the form while a popover is open
      if (cmdPopover.highlight >= 0) cmdSelect(cmdPopover.highlight);
      break;
    case 'Escape':
      e.preventDefault();
      closeCommandPopover();
      break;
    case 'Tab':
      closeCommandPopover(); // let the default focus move happen
      break;
    default:
      // Type-ahead hook: keep the popover filter in sync with the prompt.
      if (e.target === els.prompt) setCommandPopoverFilter(els.prompt.value);
  }
}

function showCommandPopover({
  anchor = els.composer,
  items = [],
  onSelect,
  filterText = null,
  placeholder = 'Filter…',
  emptyMessage = 'No matches',
  renderItem = null,
} = {}) {
  closeCommandPopover(); // opening replaces the old popover (old DOM first)
  if (!anchor || typeof anchor.getBoundingClientRect !== 'function') anchor = els.composer;

  const pop = document.createElement('div');
  pop.id = 'cmd-popover';
  pop.setAttribute('aria-label', 'Command popover');

  let filterEl = null;
  if (filterText !== null) {
    filterEl = document.createElement('input');
    filterEl.type = 'text';
    filterEl.className = 'cmd-filter';
    filterEl.placeholder = placeholder;
    filterEl.value = String(filterText ?? '');
    filterEl.setAttribute('aria-label', placeholder);
    filterEl.addEventListener('input', () => setCommandPopoverFilter(filterEl.value));
    filterEl.addEventListener('keydown', cmdHandleKey);
    pop.appendChild(filterEl);
  }

  const ul = document.createElement('ul');
  ul.className = 'cmd-list';
  ul.setAttribute('role', 'listbox');
  pop.appendChild(ul);
  document.body.appendChild(pop);

  // Above the anchor: popover bottom edge at the anchor's top, left edge
  // aligned to it, both clamped so the popover never leaves the viewport.
  const r = anchor.getBoundingClientRect();
  const width = Math.min(340, window.innerWidth - 24);
  pop.style.width = `${width}px`;
  pop.style.left = `${Math.max(12, Math.min(r.left, window.innerWidth - 12 - width))}px`;
  pop.style.bottom = `${Math.max(8, Math.min(window.innerHeight - r.top, window.innerHeight - CMD_POPOVER_MAX_HEIGHT - 8))}px`;

  cmdPopover = {
    el: pop,
    listEl: ul,
    filterEl,
    items: Array.isArray(items) ? items : [],
    onSelect,
    renderItem,
    filter: String(filterText ?? ''),
    visible: [],
    highlight: -1,
    emptyMessage,
  };
  cmdRenderList();
}

// ── Live updates (polling) ─────────────────────────────────────

// The gateway has no SSE endpoint for watching arbitrary sessions, so the
// panel polls. Guards keep it cheap: only while visible, idle, and on an
// active session. Adoption is double-guarded (CRITIQUE #4/#7) and never
// drops local messages without the stale-limit expiry (CRITIQUE #5).
async function pollActiveSession() {
  if (pollInFlight) return;
  const sid = activeSessionId; // capture; the user may switch mid-fetch
  if (!settings.apiKey || !sid || sending || sessionMissing) return;
  if (document.visibilityState !== 'visible') return;
  if (!els.settingsPanel.classList.contains('hidden')) return;
  pollInFlight = true;
  try {
    // Stage 1 (cheap): compare the active row's message_count.
    let changed = false;
    try {
      const sessions = await listSessions();
      const row = sessions.find((s) => (s.id || s.session_id) === sid);
      if (row && typeof row.message_count === 'number') {
        changed = row.message_count !== lastSeenCount;
        lastSeenCount = row.message_count;
      } else {
        changed = true; // unknown/missing count → fall through to the fetch
      }
    } catch {
      changed = true; // list failed → try messages directly
    }
    if (activeSessionId !== sid || sending) return;
    if (!changed) return;

    // Stage 2: full history + fingerprint reconciliation.
    const serverMsgs = await getMessages(sid);
    if (activeSessionId !== sid || sending) return; // adoption-time guards
    const fp = renderer.fingerprint(serverMsgs);
    if (fp === lastFingerprint) return;
    if (Date.now() < quietUntil) return; // post-stream grace
    if (serverMsgs.length < messages.length && Date.now() - streamEndedAt < POLL_STALE_LIMIT_MS) {
      return; // server is behind (or a stopped stream never persisted): keep local
    }
    messages = serverMsgs;
    lastFingerprint = fp;
    renderMessages();
  } catch (err) {
    // Deleted session: stop polling and say so instead of a silent stale view.
    if (/404|not found/i.test(String(err?.message || err || '')) && activeSessionId === sid && !sessionMissing) {
      sessionMissing = true;
      showBanner('This session was deleted on the server. Open another session.', 'info');
    }
    // Transient errors are swallowed; the connection badge reports outages.
  } finally {
    pollInFlight = false;
  }
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(pollActiveSession, POLL_INTERVAL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') pollActiveSession();
  });
}

// Seed poll state from freshly-loaded/just-streamed local messages.
function syncPollState() {
  lastFingerprint = renderer.fingerprint(messages);
  streamEndedAt = Date.now();
  quietUntil = streamEndedAt + POLL_QUIET_MS;
  sessionMissing = false;
}

// ── Actions ──────────────────────────────────────────────────────

async function refreshConnectionBadge() {
  if (!settings.apiKey) {
    setConnection('offline', 'Add API key in settings');
    return false;
  }
  try {
    await testConnection();
    setConnection('online', baseUrl().replace(/^https?:\/\//, ''));
    showBanner('');
    return true;
  } catch (err) {
    setConnection('offline', err.message || 'Offline');
    return false;
  }
}

async function beginNewChat() {
  // Abort any in-flight stream so starting fresh never blocks (TASK_BRIEF_5).
  if (sending) {
    abortController?.abort();
    clearTimeout(streamTimer);
    setSending(false);
  }
  closeSessionMenu();
  // Reset local state first so the UI never blocks on the server.
  activeSessionId = '';
  messages = [];
  lastSeenCount = null;
  lastFingerprint = null;
  quietUntil = 0;
  streamEndedAt = 0;
  sessionMissing = false;
  els.sessionTitle.textContent = 'New chat';
  renderMessages();
  showBanner('');
  els.prompt.focus();

  // Create the session server-side immediately so it shows up in the
  // dropdown (TASK_BRIEF_2 #1). On failure, fall back to lazy creation on
  // first send — the chat stays usable.
  setConnection('busy', 'Creating session…');
  try {
    const session = await createSession('New chat');
    activeSessionId = session.id;
    await saveSettings({ sessionId: session.id, sessionTitle: session.title });
    els.sessionTitle.textContent = session.title;
    setConnection('online', baseUrl().replace(/^https?:\/\//, ''));
  } catch (err) {
    showBanner(`Could not create session (${err.message || err}) — will create on first message.`);
    setConnection('offline', 'Create failed');
    await saveSettings({ sessionId: '', sessionTitle: 'New chat' });
  }
}

async function selectSession(id, title) {
  // Abort any in-flight stream so switching never blocks (TASK_BRIEF_5).
  // The gateway run continues server-side and shows up via the poll.
  if (sending) {
    abortController?.abort();
    clearTimeout(streamTimer);
    setSending(false);
  }
  closeSessionMenu();
  activeSessionId = id;
  const label = title || id;
  els.sessionTitle.textContent = label;
  await saveSettings({ sessionId: id, sessionTitle: label });
  showBanner('');
  try {
    setConnection('busy', 'Loading…');
    messages = await getMessages(id);
    syncPollState();
    lastSeenCount = null;
    quietUntil = 0; // just synced from the server; no local stream to protect
    streamEndedAt = 0;
    renderMessages();
    setConnection('online', baseUrl().replace(/^https?:\/\//, ''));
  } catch (err) {
    messages = [];
    lastFingerprint = null;
    renderMessages();
    showBanner(err.message || String(err));
    setConnection('offline', 'Load failed');
  }
}

async function openSessionMenu() {
  const open = els.sessionMenu.classList.contains('hidden');
  if (!open) {
    closeSessionMenu();
    return;
  }
  els.sessionMenu.classList.remove('hidden');
  els.sessionList.innerHTML = '<div class="dropdown-empty">Loading…</div>';
  els.sessionEmpty.classList.add('hidden');
  try {
    const sessions = await listSessions();
    renderSessionList(sessions);
  } catch (err) {
    els.sessionList.innerHTML = '';
    els.sessionEmpty.classList.remove('hidden');
    els.sessionEmpty.textContent = err.message || 'Could not load sessions';
  }
}

async function sendMessage(text) {
  const clean = String(text || '').trim();
  const pending = [...attachments];
  if ((!clean && pending.length === 0) || sending) return;
  if (!settings.apiKey) {
    openSettings(true);
    els.settingsStatus.textContent = 'Paste your API key first.';
    els.settingsStatus.className = 'status err';
    return;
  }

  showBanner('');
  els.prompt.value = '';
  autoResizePrompt();

  // Ensure a session exists.
  if (!activeSessionId) {
    try {
      setSending(true);
      const session = await createSession(clean.slice(0, 48) || 'New chat');
      activeSessionId = session.id;
      els.sessionTitle.textContent = session.title;
      await saveSettings({ sessionId: session.id, sessionTitle: session.title });
    } catch (err) {
      setSending(false);
      showBanner(err.message || String(err));
      setConnection('offline', 'Create failed');
      return;
    }
  }

  // Upload pasted images to the bridge — file-path transport (TASK_BRIEF_4):
  // one @image:C:\... line per attachment, rendered back via the bridge.
  // Bridge down / save fails → capped data URL (gateway sanitizer mangles
  // multi-MB data URLs in tool args). Chips are consumed after upload.
  if (!sending) setSending(true);
  const mediaLines = [];
  for (const a of pending) {
    try {
      const enc = await encodeForSend(a.dataUrl);
      const path = await saveImageToBridge(enc);
      mediaLines.push(path ? `@image:${path}` : `@image:${await cappedDataUrl(enc)}`);
    } catch {
      mediaLines.push(`@image:${await cappedDataUrl(a.dataUrl)}`);
    }
  }

  const full = mediaLines.length ? `${clean}${clean ? '\n' : ''}${mediaLines.join('\n')}` : clean;
  attachments.length = 0;
  renderChips();

  const userMsg = { role: 'user', content: full };
  const assistantMsg = { role: 'assistant', content: '', streaming: true };
  messages = [...messages, userMsg, assistantMsg];
  renderMessages();
  setSending(true);
  abortController = new AbortController();
  streamingSessionId = activeSessionId;
  updateRunningIndicator();

  try {
    // v1 body: plain message (+ @image: data URLs as lines). browser_use
    // toggle is reserved for later.
    const body = {
      message: full,
      // When browser use lands: include page context here if settings.browserUse.
    };

    const res = await hermesFetch(
      `/api/sessions/${encodeURIComponent(activeSessionId)}/chat/stream`,
      {
        method: 'POST',
        body: JSON.stringify(body),
        signal: abortController.signal,
      },
    );

    if (!res.ok) {
      const payload = await readJson(res);
      throw new Error(errorMessage(payload, `Stream failed (${res.status})`));
    }

    const finalText = await readHermesSse(res, {
      signal: abortController.signal,
      onAssistant: (content) => {
        assistantMsg.content = content;
        scheduleStreamingRender(assistantMsg);
      },
    });

    clearTimeout(streamTimer);
    assistantMsg.content = finalText || assistantMsg.content || '(empty reply)';
    assistantMsg.streaming = false;
    syncPollState();
    renderMessages();
    setConnection('online', baseUrl().replace(/^https?:\/\//, ''));
  } catch (err) {
    if (err?.name === 'AbortError') {
      assistantMsg.content = assistantMsg.content || '(stopped)';
      assistantMsg.streaming = false;
    } else {
      // Drop empty streaming bubble; show error instead.
      if (!assistantMsg.content) {
        messages = messages.filter((m) => m !== assistantMsg);
        messages.push({ role: 'assistant', content: err.message || String(err), error: true });
      } else {
        assistantMsg.streaming = false;
        showBanner(err.message || String(err));
      }
      setConnection('offline', 'Error');
    }
    clearTimeout(streamTimer);
    syncPollState();
    renderMessages();
  } finally {
    abortController = null;
    streamingSessionId = '';
    setSending(false);
    autoResizePrompt();
    els.prompt.focus();
  }
}

// ── Event wiring ─────────────────────────────────────────────────

els.btnSettings.addEventListener('click', () => openSettings(true));
els.btnCloseSettings.addEventListener('click', () => openSettings(false));
els.btnNew.addEventListener('click', () => beginNewChat());
els.btnSessions.addEventListener('click', (e) => {
  e.stopPropagation();
  openSessionMenu();
});
els.btnRefreshSessions.addEventListener('click', (e) => {
  e.stopPropagation();
  openSessionMenu();
});

document.addEventListener('click', (e) => {
  if (!els.sessionMenu.classList.contains('hidden')) {
    if (!els.sessionMenu.contains(e.target) && e.target !== els.btnSessions && !els.btnSessions.contains(e.target)) {
      closeSessionMenu();
    }
  }
});

els.btnSave.addEventListener('click', async () => {
  const gatewayUrl = els.cfgUrl.value.trim() || DEFAULTS.gatewayUrl;
  const apiKey = els.cfgKey.value.trim();
  await saveSettings({ gatewayUrl, apiKey });
  els.settingsStatus.textContent = 'Saved.';
  els.settingsStatus.className = 'status ok';
  const ok = await refreshConnectionBadge();
  if (ok) {
    els.settingsStatus.textContent = 'Saved · connected.';
    setTimeout(() => openSettings(false), 500);
  }
});

els.btnTest.addEventListener('click', async () => {
  // Temporarily apply form values without persisting.
  const prev = { ...settings };
  settings.gatewayUrl = els.cfgUrl.value.trim() || DEFAULTS.gatewayUrl;
  settings.apiKey = els.cfgKey.value.trim();
  els.settingsStatus.textContent = 'Testing…';
  els.settingsStatus.className = 'status';
  try {
    const health = await testConnection();
    els.settingsStatus.textContent = `OK · Hermes ${health.version || health.status || 'online'}`;
    els.settingsStatus.className = 'status ok';
  } catch (err) {
    els.settingsStatus.textContent = err.message || String(err);
    els.settingsStatus.className = 'status err';
  } finally {
    // Restore until Save — unless values match stored.
    settings = prev;
  }
});

els.composer.addEventListener('submit', (e) => {
  e.preventDefault();
  if (sending) {
    abortController?.abort();
    return;
  }
  sendMessage(els.prompt.value);
});

els.btnSend.addEventListener('click', (e) => {
  if (sending) {
    e.preventDefault();
    abortController?.abort();
  }
});

els.prompt.addEventListener('input', autoResizePrompt);
els.prompt.addEventListener('input', () => {
  // TASK_BRIEF_8 hook: while a popover is open, keystrokes refilter it.
  if (isCommandPopoverOpen()) setCommandPopoverFilter(els.prompt.value);
});
els.prompt.addEventListener('keydown', (e) => {
  if (isCommandPopoverOpen()) {
    // Popover takes over the keys: arrows move the highlight, Enter selects
    // (never submits), Escape closes. The normal send flow stays untouched
    // when no popover is open.
    cmdHandleKey(e);
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage(els.prompt.value);
  }
});

// ── Attachment wiring (paste / drag-drop / preview) ──────────────

els.prompt.addEventListener('paste', (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
    const file = item.getAsFile();
    if (!file) continue;
    e.preventDefault(); // keep raw binary out of the textarea
    ingestImageFile(file);
  }
});

els.composer.addEventListener('dragover', (e) => {
  e.preventDefault(); // allow dropping onto the composer
});
els.composer.addEventListener('drop', (e) => {
  e.preventDefault();
  const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'));
  for (const file of files) ingestImageFile(file);
});

els.previewClose.addEventListener('click', closePreview);
els.preview.addEventListener('click', (e) => {
  if (e.target === els.preview || e.target.classList.contains('preview-backdrop')) closePreview();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !els.preview.classList.contains('hidden')) closePreview();
});

// ── Boot ─────────────────────────────────────────────────────────

async function boot() {
  await loadSettings();
  // Version badge: manifest version + hardcoded build stamp, so the user
  // can instantly confirm the loaded build (TASK_BRIEF_2 #1).
  const v = chrome?.runtime?.getManifest?.().version || '0.1.0';
  els.versionBadge.textContent = `v${v} · ${BUILD_STRING}`;
  autoResizePrompt();
  renderMessages();
  startPolling();
  probeBridge(); // async, non-blocking — bridge-first media depends on it

  if (!settings.apiKey) {
    setConnection('offline', 'Add API key in settings');
    openSettings(true);
    els.settingsStatus.textContent = 'Paste API_SERVER_KEY from ~/.hermes/.env to get started.';
    els.settingsStatus.className = 'status';
    return;
  }

  const ok = await refreshConnectionBadge();
  if (ok && activeSessionId) {
    try {
      messages = await getMessages(activeSessionId);
      syncPollState();
      quietUntil = 0; // fresh server sync — no local stream to protect
      streamEndedAt = 0;
      renderMessages();
      els.sessionTitle.textContent = settings.sessionTitle || activeSessionId;
    } catch {
      // Stale session — start fresh.
      await beginNewChat();
    }
  }
}

boot();
