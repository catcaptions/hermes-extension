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
const BUILD_STRING = 'build 2026-08-11 b1'; // placeholder — bumped to the feat hash on commit

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
  btnModel: $('btn-model'),
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
  btnBrowser: $('btn-browser'),
  browserDot: $('browser-dot'),
  browserChipText: $('browser-chip-text'),
  browserPanel: $('browser-panel'),
  browserTabs: $('browser-tabs'),
  btnBrowserRefresh: $('btn-browser-refresh'),
  btnBrowserCollapse: $('btn-browser-collapse'),
  btnBrowserDisconnect: $('btn-browser-disconnect'),
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

// TASK_BRIEF_10: confirmed @url:/@file: references awaiting send, each
// { kind: 'file'|'url', label, chip, content } — chip is the visible
// placeholder in the prompt; the content goes into the Attached Context block.
const attachedContext = [];

// TASK_BRIEF_11: per-session model lock. modelPref = the choice stored under
// `modelPref:<sessionId>` in localStorage; serverModel = the gateway's
// reported current model — the send-path fallback when no preference exists.
let modelPref = null;   // { provider, model } for the active session
let serverModel = null; // { provider, model } from /api/model/options
let modelLoading = false; // one options fetch in flight at a time
let modelLocking = false; // one model-lock POST in flight at a time
let modelToggleClick = false; // pill mousedown closed the picker — swallow the click

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
    els.btnModel.disabled = true; // CRITIQUE_BRIEF_11 #7: no model switch mid-stream
    setConnection('busy', 'Hermes is working…');
  } else {
    els.btnSend.title = 'Send';
    els.btnSend.setAttribute('aria-label', 'Send');
    els.prompt.disabled = false;
    els.btnModel.disabled = false;
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

let cmdPopover = null; // { el, listEl, items, onSelect, renderItem, filter, visible, highlight, emptyMessage, owner }
// TASK_BRIEF_9 / CRITIQUE_BRIEF_9 #4: name last inserted by the skills menu —
// while the in-progress token (after the leading '/', up to whitespace) still
// equals it, a fresh '/' hasn't been typed, so the menu stays closed.
let slashInserted = null;
// CRITIQUE_BRIEF_9 #1: Escape/Tab closes the menu but the '/' (or '@') stays,
// so the next keystroke would reopen it. Dismissed-until-prefix-changes flags:
// while the value still starts with the dismissed value, the menu stays closed.
let slashDismissed = null; // '/…' value dismissed via Escape/Tab (skills menu)
let atDismissed = null;    // '@…' value dismissed via Escape/Tab (@ picker)
// CRITIQUE_BRIEF_9 #3: at most one /v1/skills fetch in flight.
let skillsFetching = false;
// TASK_BRIEF_10: mid-flow state for the @ picker.
let atFileSession = null; // { chips, prefix, tail } while a @file: picker round is open
let atUrlBusy = false;    // a bridge /fetch is in flight — no double-confirm
let gitRowBusy = false;   // CRITIQUE_BRIEF_12 #1: a /git row fetch is in flight — no send
// CRITIQUE_BRIEF_10 #8: user pressed Esc on an unconfirmed '@url:' — the token
// is now plain text (Enter sends, space types) until the value leaves '@url:'.
let atUrlEscaped = false;

// TASK_BRIEF_12: @folder: browse state. folderSession remembers where the
// '@folder:…' token was so a picked file's chip replaces it (and later chips
// stack after it); folderPath/folderRootPath track the browser's position.
let folderSession = null;  // { head, tail }
let folderPath = '';       // directory currently shown in the browser
let folderRootPath = '';   // initially confirmed folder — select-all lives here

function cmdDefaultRow(item) {
  const label = escapeHtml(item?.label ?? '');
  const sub = item?.sublabel ? `<span class="cmd-sublabel">${escapeHtml(item.sublabel)}</span>` : '';
  return `<span class="cmd-label">${label}</span>${sub}`;
}

function cmdClose() {
  if (!cmdPopover) return;
  // CRITIQUE_BRIEF_13 #2: the model-picker outside-click listener lives only
  // while its popover is open — every close path funnels through here.
  document.removeEventListener('mousedown', modelPickerOutsideClick);
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
  const filterEl = cmdPopover.el.querySelector('.cmd-filter');
  if (filterEl) filterEl.value = cmdPopover.filter; // keep the box in sync (review NIT #7)
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

// CRITIQUE_BRIEF_9 #1: closing via Escape/Tab must not be undone by the next
// keystroke — remember the prompt value, suppress the menu until it changes.
function recordCmdDismissal() {
  if (!cmdPopover?.owner) return;
  const v = els.prompt.value;
  if (cmdPopover.owner === 'skills' && v.startsWith('/')) slashDismissed = v;
  else if (cmdPopover.owner === 'at' && v.startsWith('@')) atDismissed = v;
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
      recordCmdDismissal();
      closeCommandPopover();
      break;
    case 'Tab':
      recordCmdDismissal();
      closeCommandPopover(); // let the default focus move happen
      break;
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

  if (filterText !== null) {
    const filterEl = document.createElement('input');
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
    items: Array.isArray(items) ? items : [],
    onSelect,
    owner: null, // 'skills' | 'at' | null — who opened it (CRITIQUE_BRIEF_9 #2)
    renderItem,
    filter: String(filterText ?? ''),
    visible: [],
    highlight: -1,
    emptyMessage,
  };
  cmdRenderList();
}

// ── `/` skills menu (TASK_BRIEF_9) ──────────────────────────────
// Typing '/' in the prompt opens the popover over the Hermes skills list
// (fetched fresh from the gateway on every open — local + cheap, no cache).
// Filtering, keyboard nav, Enter/Escape/Tab are all Phase 0 popover behavior.

function skillItem(s) {
  const name = String(s?.name || '').trim();
  if (!name) return null;
  const desc = String(s?.description || '').trim();
  return {
    id: name,
    label: name,
    sublabel: desc.length > 90 ? `${desc.slice(0, 87)}…` : desc,
    group: String(s?.category || '').trim() || 'General',
    meta: s,
  };
}

function insertSkill(item) {
  const el = els.prompt;
  const end = typeof el.selectionStart === 'number' ? el.selectionStart : el.value.length;
  const head = el.value.slice(0, end);
  // CRITIQUE_BRIEF_9 #5: caret/selection outside the '/…' token (e.g. clicked
  // at position 0) — nothing to insert; stay a true no-op.
  if (!head.startsWith('/')) return;
  const inserted = `/${item.name}`;
  // CRITIQUE_BRIEF_9 #6: replace the whole in-progress token (up to whitespace),
  // not just the caret-to-head span — a mid-token selection would keep a tail.
  const sp = el.value.search(/\s/);
  const tokenEnd = sp === -1 ? el.value.length : sp;
  el.value = inserted + el.value.slice(tokenEnd);
  slashInserted = item.name; // CRITIQUE_BRIEF_9 #4: token-exact suppression
  closeCommandPopover();
  autoResizePrompt();
  const pos = el.value.length;
  el.setSelectionRange(pos, pos); // caret to the end, focus stays in #prompt
  el.focus();
}

async function openSkillsMenu() {
  // CRITIQUE_BRIEF_9 #3: one fetch in flight at a time — a slow gateway must
  // not spawn a fetch per keystroke. Re-check after the (cheap, local) fetch:
  // the user may have deleted the '/' or another open already took over.
  if (skillsFetching || isCommandPopoverOpen() || !els.prompt.value.startsWith('/')) return;
  skillsFetching = true;
  try {
    const res = await hermesFetch('/v1/skills');
    if (!res.ok) return; // silent — the next '/' re-fetches
    const payload = await readJson(res);
    if (isCommandPopoverOpen() || !els.prompt.value.startsWith('/')) return;
    const items = rows(payload).map(skillItem).filter(Boolean);
    showCommandPopover({
      items,
      onSelect: insertSkill,
      filterText: els.prompt.value.slice(1) || '',
      placeholder: 'Filter skills…',
      emptyMessage: 'No skills match',
    });
    cmdPopover.owner = 'skills'; // CRITIQUE_BRIEF_9 #2: who owns this open
  } catch {
    // gateway unreachable — no menu; typing continues as normal
  } finally {
    skillsFetching = false;
  }
}

// ── `@` context picker (TASK_BRIEF_10 + TASK_BRIEF_12) ───────────
// '@' expansion is CLI-only on the Hermes gateway, so references are
// expanded client-side: @url: → bridge /fetch → [fetched: domain] chip +
// queued content; @file: → OS picker → [File: name] chips (text read
// client-side, images reuse the paste-to-bridge flow); @image: is a hint
// row that inserts the literal token for the existing gateway flow;
// @folder:/@diff/@staged/@git: (TASK_BRIEF_12) → bridge /list + /git.

// Shared by the OS picker and the folder browser (TASK_BRIEF_12): a file
// that must never be queued as text.
const binaryExt = /\.(zip|rar|7z|gz|bz2|xz|tar|exe|msi|dll|so|bin|pdf|docx|xlsx|pptx|iso|jar)$/i;

const AT_ITEMS = [
  { id: '@file:', label: '@file:', sublabel: 'Attach a local file (reads it client-side)', group: 'File', meta: { kind: 'file' } },
  { id: '@url:', label: '@url:', sublabel: 'Attach a web page (via media bridge fetch)', group: 'URL', meta: { kind: 'url' } },
  { id: '@image:', label: '@image:', sublabel: 'Reuse the existing paste-to-bridge image flow', group: 'File', meta: { kind: 'image' } },
  // TASK_BRIEF_12: folder + git references.
  { id: '@folder:', label: '@folder:', sublabel: 'Attach a folder listing', group: 'Git/Folder', meta: { kind: 'folder' } },
  { id: '@diff', label: '@diff', sublabel: 'Attach working-tree diff', group: 'Git', meta: { kind: 'diff' } },
  { id: '@staged', label: '@staged', sublabel: 'Attach staged diff', group: 'Git', meta: { kind: 'staged' } },
  { id: '@git:', label: '@git:', sublabel: 'Attach a commit (ref)', group: 'Git', meta: { kind: 'git' } },
];

function openAtMenu(term) {
  showCommandPopover({
    items: AT_ITEMS,
    onSelect: insertAt,
    filterText: term || '',
    placeholder: 'Filter references…',
    emptyMessage: 'No matches',
  });
  cmdPopover.owner = 'at'; // CRITIQUE_BRIEF_9 #2: who owns this open
}

// Swap the nearest '@…' before the caret for a command token; returns
// { prefix, tail } so callers can rebuild the prompt, or null when there is
// no '@' before the caret (caret at 0, selection from 0, chips already in
// front of the token). CRITIQUE_BRIEF_10 #2: callers MUST no-op on null —
// the prompt is never touched on that path.
function atReplacePrefix(token) {
  const el = els.prompt;
  const end = typeof el.selectionStart === 'number' ? el.selectionStart : el.value.length;
  const head = el.value.slice(0, end);
  const at = head.lastIndexOf('@');
  if (at === -1) return null;
  const tail = el.value.slice(end);
  const prefix = head.slice(0, at);
  el.value = prefix + token + tail;
  autoResizePrompt();
  return { prefix, tail };
}

function insertAt(item) {
  const kind = item?.meta?.kind;
  if (kind === 'file') insertAtFile();
  else if (kind === 'url') insertAtUrl();
  else if (kind === 'folder') insertAtFolder();
  else if (kind === 'diff' || kind === 'staged') insertGitRow(kind);
  else if (kind === 'git') insertAtGit();
  else insertAtImage();
}

function insertAtUrl() {
  closeCommandPopover();
  const r = atReplacePrefix('@url:');
  if (!r) return; // CRITIQUE_BRIEF_10 #12: no token before the caret — no caret jump
  const el = els.prompt;
  const pos = r.prefix.length + 5;
  el.setSelectionRange(pos, pos); // caret right after the colon — user pastes a URL
  el.focus();
}

function insertAtImage() {
  closeCommandPopover();
  const r = atReplacePrefix('@image:');
  if (!r) return; // CRITIQUE_BRIEF_10 #12: no token before the caret — no caret jump
  const el = els.prompt;
  const pos = r.prefix.length + 7;
  el.setSelectionRange(pos, pos); // caret after the colon — user types/pastes a path
  el.focus();
}

// ── @folder: / @git: / @diff / @staged (TASK_BRIEF_12) ──────────

function insertAtFolder() {
  closeCommandPopover();
  const r = atReplacePrefix('@folder:');
  if (!r) return;
  const el = els.prompt;
  const pos = r.prefix.length + 8;
  el.setSelectionRange(pos, pos); // caret after the colon — user types a path
  el.focus();
}

function insertAtGit() {
  closeCommandPopover();
  const r = atReplacePrefix('@git:');
  if (!r) return;
  const el = els.prompt;
  const pos = r.prefix.length + 5;
  el.setSelectionRange(pos, pos); // caret after the colon — user types a ref
  el.focus();
}

// @diff / @staged: instant rows — call /git once and swap the typed token
// for the chip (no browse layer).
async function insertGitRow(op) {
  closeCommandPopover();
  const r = atReplacePrefix(`@${op}`);
  if (!r) return;
  gitRowBusy = true;
  try {
    const { ok, output, error } = await bridgePost('/git', { op });
    if (!ok) {
      showBanner(`Git failed: ${error}`, 'info');
      return; // the '@diff' token stays for editing
    }
    const entry = queueAttached('git', op, output);
    const el = els.prompt;
    el.value = r.prefix + entry.chip + r.tail;
    autoResizePrompt();
    const pos = el.value.length;
    el.setSelectionRange(pos, pos);
    el.focus();
  } finally {
    gitRowBusy = false;
  }
}

function insertAtFile() {
  closeCommandPopover();
  const r = atReplacePrefix('@file:');
  // CRITIQUE_BRIEF_10 #2: null (caret at 0 / chips in front of the token) must
  // never start a session — the old path wiped the whole prompt on cancel.
  if (!r) return;
  atFileSession = { chips: [], prefix: r.prefix, tail: r.tail };
  pickAtFiles();
}

function pickAtFiles() {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = '*/*';
  input.addEventListener('change', () => {
    const files = [...(input.files || [])];
    input.remove();
    // CRITIQUE_BRIEF_10FIX #1: FileReader.onload fires asynchronously, so the
    // session must outlive the change handler — null it only once every
    // pending read has resolved (or rejected), otherwise the chips never
    // render and the send path drops the attachments.
    let pending = files.length;
    const roundDone = () => {
      pending -= 1;
      if (pending > 0) return;
      renderAtFilePrompt();
      atFileSession = null; // round over — no stale session
    };
    for (const f of files) handleAtFile(f, roundDone);
  });
  input.addEventListener('cancel', () => {
    // No files chosen — drop the transient '@file:' token, keep the rest.
    const s = atFileSession;
    atFileSession = null;
    if (s) els.prompt.value = s.prefix + s.tail;
    input.remove();
    autoResizePrompt();
  });
  input.click();
}

function handleAtFile(file, done) {
  if (!file) {
    done?.();
    return;
  }
  if (file.type.startsWith('image/')) {
    ingestImageFile(file); // existing paste-to-bridge flow, no prompt token
    done?.();
    return;
  }
  const textMime = /^(text\/|application\/.*(json|xml)(;|$))/;
  if (binaryExt.test(file.name) || (file.type && !textMime.test(file.type))) {
    showBanner(`Skipped binary file: ${file.name}`, 'info');
    done?.();
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    let content = String(reader.result || '');
    // CRITIQUE_BRIEF_10 #3: content-based binary detection — null bytes in
    // binary data land as U+0000 (readAsText replaces invalid UTF-8).
    if (content.includes('\u0000')) {
      showBanner(`Skipped binary file: ${file.name}`, 'info');
      done?.();
      return;
    }
    if (content.length > 512 * 1024) {
      content = `${content.slice(0, 512 * 1024)}\n… (truncated at 512 KB)`;
    }
    const entry = queueAttached('file', file.name, content);
    atFileSession?.chips.push(entry.chip);
    renderAtFilePrompt();
    done?.();
  };
  reader.onerror = () => {
    showBanner(`Could not read ${file.name}`, 'info');
    done?.();
  };
  reader.readAsText(file);
}

function renderAtFilePrompt() {
  const s = atFileSession;
  if (!s) return;
  const el = els.prompt;
  const chips = s.chips.join(' ');
  el.value = s.prefix + chips + (s.tail ? `${chips ? ' ' : ''}${s.tail}` : '');
  autoResizePrompt();
  el.focus();
  el.setSelectionRange(el.value.length, el.value.length);
}

// CRITIQUE_BRIEF_10 #11: one queued entry per identity (re-adding the same
// item replaces the old one), and each entry gets a unique chip so deleting
// one chip can never expand another entry's content (e.g. two same-domain
// URLs share the '[fetched: …]' chip text otherwise).
function queueAttached(kind, label, content) {
  const id = `${kind}\u0000${label}`;
  const oldIdx = attachedContext.findIndex((i) => `${i.kind}\u0000${i.label}` === id);
  if (oldIdx >= 0) attachedContext.splice(oldIdx, 1);
  const chipBase = kind === 'url' ? `[fetched: ${urlDomain(label)}]`
    : kind === 'git' ? `[Git: ${label}]`
    : kind === 'folder' ? `[Folder: ${label}]`
    : `[File: ${label}]`;
  const dup = attachedContext.filter((i) => i.chip === chipBase).length;
  const chip = dup ? `${chipBase} · ${dup + 1}` : chipBase;
  const entry = { kind, label, chip, content };
  attachedContext.push(entry);
  return entry;
}

function urlDomain(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, '') || u;
  } catch {
    return u;
  }
}

// Bridge /fetch with an abort cap matching the bridge's 60 s fetch timeout
// (CRITIQUE_BRIEF_10 #5: the old 25 s aborted while the bridge kept going).
async function bridgeFetch(url) {
  return bridgePost('/fetch', { url });
}

// Generic bridge POST shared by /fetch, /list and /git (TASK_BRIEF_12):
// returns { ok, ...payload } on 2xx+ok, else { ok:false, error }.
async function bridgePost(path, body) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 60000);
  try {
    const res = await fetch(`${BRIDGE_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const j = await readJson(res);
    return res.ok && j?.ok
      ? { ok: true, ...j }
      : { ok: false, error: j?.error || `${path} failed (${res.status})` };
  } catch (err) {
    return { ok: false, error: err?.name === 'AbortError' ? 'timed out' : 'bridge unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

// Enter/space while an unconfirmed '@url:' prefix is present: fetch the URL
// token (up to whitespace, trailing punctuation stripped), swap it for a
// chip, queue the content.
async function confirmAtUrl() {
  if (atUrlBusy) return;
  const el = els.prompt;
  const m = /^@url:(\S*)/.exec(el.value);
  if (!m) return; // token gone — nothing to confirm
  const head = m[0];
  const url = m[1].replace(/[.,;:!?]+$/, ''); // CRITIQUE_BRIEF_10 #6: no trailing punctuation
  if (!url) {
    showBanner('Paste a URL after @url:, then press Enter.', 'info');
    return;
  }
  atUrlBusy = true;
  const { ok, title, content, error } = await bridgeFetch(url);
  atUrlBusy = false;
  if (!ok) {
    showBanner(`Attach failed: ${error}`, 'info');
    return; // the raw token stays — the user can edit or delete it
  }
  // CRITIQUE_BRIEF_10FIX #2: Esc (or an edit away from '@url:') while the
  // fetch was in flight must cancel the commit — the value check alone
  // can't catch it, since Esc leaves the prompt text untouched.
  if (atUrlEscaped || !el.value.startsWith(head)) return;
  {
    const entry = queueAttached('url', url, content || title || '');
    el.value = entry.chip + el.value.slice(head.length);
    autoResizePrompt();
    const pos = el.value.length;
    el.setSelectionRange(pos, pos);
    el.focus();
  }
}

// TASK_BRIEF_12: Enter on an unconfirmed '@folder:' — everything after the
// token is the path (paths may contain spaces). Confirm opens the browse
// popover over /list's entries; the raw token stays until a file is picked.
async function confirmAtFolder() {
  const el = els.prompt;
  const m = /^@folder:(.*)$/.exec(el.value);
  if (!m) return; // token gone — nothing to confirm
  const head = m[0];
  const path = m[1].trim();
  if (!path) {
    showBanner('Type a path after @folder:, then press Enter.', 'info');
    return;
  }
  const { ok, entries, truncated, error } = await bridgePost('/list', { path });
  if (!ok) {
    showBanner(`Folder failed: ${error}`, 'info');
    return; // keep the raw token for editing
  }
  folderSession = { head, tail: el.value.slice(head.length) };
  folderRootPath = path;
  openFolderBrowse(path, entries, truncated);
}

function openFolderBrowse(path, entries, truncated) {
  folderPath = path;
  const items = [];
  // 'select all files in this folder (max 20)' lives at the root level only:
  // it attaches the folder's file LIST as one [Folder: path] block.
  if (path === folderRootPath) {
    items.push({
      id: '@folder:select-all',
      label: 'Attach all files in this folder (max 20)',
      sublabel: 'Queues the file list as one folder block',
      group: '',
      meta: { kind: 'select-all', path },
    });
  }
  if (truncated) {
    items.push({
      id: '@folder:cap',
      label: 'Listing capped at 200 entries — only the first 200 are shown',
      sublabel: '',
      group: '',
      meta: { kind: 'cap' },
    });
  }
  for (const e of entries || []) {
    const size = e.size != null ? `${e.size} bytes` : '';
    items.push({
      id: `@folder:${e.path}`,
      label: e.name,
      sublabel: e.is_dir ? 'folder' : size,
      group: '',
      meta: { kind: e.is_dir ? 'dir' : 'file', path: e.path, name: e.name },
    });
  }
  showCommandPopover({
    items,
    onSelect: selectFolderEntry,
    filterText: '',
    placeholder: 'Filter files…',
    emptyMessage: 'No matches',
  });
  cmdPopover.owner = 'at'; // owned: typing in the prompt closes this layer
}

async function selectFolderEntry(item) {
  const kind = item?.meta?.kind;
  if (kind === 'select-all') {
    await attachFolderListing(item.meta.path);
    return;
  }
  if (kind === 'cap') return; // notice row — no-op
  if (kind === 'dir') {
    const { ok, entries, truncated, error } = await bridgePost('/list', { path: item.meta.path });
    if (!ok) {
      showBanner(`Folder failed: ${error}`, 'info');
      return; // popover keeps the current listing
    }
    openFolderBrowse(item.meta.path, entries, truncated);
    return;
  }
  if (kind === 'file') await attachFolderFile(item.meta);
}

// Swap the '@folder:…' token for the chip; later picks stack after it. The
// popover stays open so several files can be picked in one round.
function putFolderChip(chip) {
  const el = els.prompt;
  const s = folderSession;
  if (!s) return;
  el.value = el.value.startsWith(s.head)
    ? chip + el.value.slice(s.head.length)
    : `${el.value} ${chip}`.trim();
  autoResizePrompt();
  el.setSelectionRange(el.value.length, el.value.length);
  el.focus();
}

// A file picked in the folder browser is read through the bridge (the
// extension has no filesystem access), then fed through the SAME acceptance
// pipeline as the OS @file: picker — binary-ext + NUL-byte checks and the
// 512 KB cap — so both flows share one reader path (TASK_BRIEF_12 spec 2).
async function attachFolderFile(meta, quiet = false) {
  const { name, path } = meta;
  if (binaryExt.test(name)) {
    if (!quiet) showBanner(`Skipped binary file: ${name}`, 'info');
    return false;
  }
  let res;
  try {
    res = await fetch(`${BRIDGE_BASE}/media?path=${encodeURIComponent(path)}`, {
      signal: AbortSignal.timeout(60000),
    });
  } catch {
    if (!quiet) showBanner(`Could not read ${name} — bridge unreachable.`, 'info');
    return false;
  }
  if (!res.ok) {
    if (!quiet) showBanner(`Could not read ${name} (${res.status}).`, 'info');
    return false;
  }
  const ctype = (res.headers.get('Content-Type') || '').split(';')[0].trim();
  const bytes = await res.arrayBuffer();
  if (ctype.startsWith('image/')) {
    // Synthetic File → the same image pipeline as paste/@file: (bridge save).
    ingestImageFile(new File([bytes], name, { type: ctype }));
    return true;
  }
  let content = new TextDecoder('utf-8').decode(bytes);
  if (content.includes('\u0000')) {
    if (!quiet) showBanner(`Skipped binary file: ${name}`, 'info');
    return false;
  }
  if (content.length > 512 * 1024) {
    content = `${content.slice(0, 512 * 1024)}\n… (truncated at 512 KB)`;
  }
  const entry = queueAttached('file', name, content);
  putFolderChip(entry.chip);
  return true;
}

// 'Attach all files in this folder (max 20)': one [Folder: path] block whose
// content is the file list (name — size), capped at 20 files.
async function attachFolderListing(path) {
  const { ok, entries, error } = await bridgePost('/list', { path });
  if (!ok) {
    showBanner(`Folder failed: ${error}`, 'info');
    return; // popover stays open
  }
  const files = (entries || []).filter((e) => !e.is_dir).slice(0, 20);
  const lines = files.map((e) => (e.size != null ? `${e.name} — ${e.size} bytes` : e.name));
  const entry = queueAttached('folder', path, lines.join('\n') || '(empty folder)');
  putFolderChip(entry.chip);
  closeCommandPopover();
  showBanner(`Attached folder listing: ${path} (${files.length} file${files.length === 1 ? '' : 's'})`, 'info');
}

// TASK_BRIEF_12: Enter/space on an unconfirmed '@git:<ref>' — /git show →
// [Git: <ref>] chip + stat block. Bridge down / bad ref → toast, token stays.
async function confirmAtGit() {
  const el = els.prompt;
  const m = /^@git:(\S*)/.exec(el.value);
  if (!m) return; // token gone — nothing to confirm
  const head = m[0];
  const ref = m[1];
  if (!ref) {
    showBanner('Type a ref after @git:, then press Enter.', 'info');
    return;
  }
  const { ok, output, error } = await bridgePost('/git', { op: 'show', ref });
  if (!ok) {
    showBanner(`Git failed: ${error}`, 'info');
    return; // keep the raw token for editing
  }
  if (!el.value.startsWith(head)) return; // edited away while fetching
  const entry = queueAttached('git', ref, output);
  el.value = entry.chip + el.value.slice(head.length);
  autoResizePrompt();
  const pos = el.value.length;
  el.setSelectionRange(pos, pos);
  el.focus();
}

// Prompt typing (TASK_BRIEF_10 extends the '/' hook): a leading '/' opens
// the skills menu, a leading '@' the context picker; the two can never be
// open together. Command tokens in use ('@url:', '@file:', '@image:') close
// the picker so the URL/path can be typed freely. CRITIQUE_BRIEF_9 #2: only
// the popover this hook owns (owner 'skills' / 'at') is closed or refiltered
// here — a foreign popover (e.g. a future model picker) is never touched.
function updatePrefixMenu() {
  const v = els.prompt.value;
  if (!v.startsWith('@url:')) atUrlEscaped = false; // CRITIQUE_BRIEF_10 #8
  if (slashDismissed) {
    if (v.startsWith(slashDismissed)) return;
    slashDismissed = null; // prefix changed — dismissal expires
  }
  if (atDismissed) {
    if (v.startsWith(atDismissed)) return;
    atDismissed = null; // prefix changed — dismissal expires
  }
  if (slashInserted) {
    // CRITIQUE_BRIEF_9 #4: compare the in-progress token, not a prefix — an
    // append or a backspace inside the token ends the suppression.
    const token = v.startsWith('/') ? v.slice(1).split(/\s/, 1)[0] : '';
    if (token === slashInserted) return;
    slashInserted = null; // token gone — normal rules resume
  }
  if (v.startsWith('/')) {
    if (cmdPopover?.owner === 'skills') {
      setCommandPopoverFilter(v.slice(1));
    } else if (cmdPopover?.owner === 'at') {
      closeCommandPopover(); // prefix flipped to '/' — stale @ picker
      openSkillsMenu();
    } else if (!cmdPopover) {
      openSkillsMenu();
    }
    return;
  }
  if (v.startsWith('@url:') || v.startsWith('@image:') || v.startsWith('@file:') ||
      v.startsWith('@folder:') || v.startsWith('@git:') ||
      v.startsWith('@diff') || v.startsWith('@staged')) {
    if (cmdPopover?.owner === 'at') closeCommandPopover();
    return;
  }
  if (v.startsWith('@')) {
    if (cmdPopover?.owner === 'at') {
      setCommandPopoverFilter(v.slice(1));
    } else if (cmdPopover?.owner === 'skills') {
      closeCommandPopover(); // prefix flipped to '@' — stale skills menu
      openAtMenu(v.slice(1));
    } else if (!cmdPopover) {
      openAtMenu(v.slice(1));
    }
    return;
  }
  if (cmdPopover?.owner === 'skills' || cmdPopover?.owner === 'at') closeCommandPopover();
}

// ── Model switcher (TASK_BRIEF_11) ──────────────────────────────
// A pill in the composer meta row opens the popover over the provider→model
// list; selecting POSTs the per-session lock and stores a localStorage pref
// that survives reloads. The popover's owner stays null — the '/' and '@'
// typing hook must never close or refilter it (CRITIQUE_BRIEF_9 #2).

function modelPrefKey() { return `modelPref:${activeSessionId}`; }

function loadModelPref() {
  let stored = null;
  try {
    stored = JSON.parse(localStorage.getItem(modelPrefKey()) || 'null');
  } catch {
    stored = null;
  }
  modelPref = stored?.model && stored?.provider ? stored : null;
}

function storeModelPref() {
  if (!modelPref?.model || !modelPref?.provider) return; // nothing to persist
  try {
    localStorage.setItem(modelPrefKey(), JSON.stringify(modelPref));
  } catch {
    // storage unavailable (private mode) — the lock still rides this send
  }
}

function updateModelPill() {
  const name = (modelPref?.model || serverModel?.model || '').trim();
  els.btnModel.textContent = name || 'model…';
  els.btnModel.title = name ? `${name} — click to switch` : 'No model yet — click to pick';
}

// Accepts both live gateway shapes for providers[].models: plain strings
// ("anthropic/claude-fable-5", bare "deepseek-v4-flash-free") and objects
// ({name, id, pricing}). Same return shape either way.
function modelItem(provider, m, payload) {
  const name = (typeof m === 'string' ? m : String(m?.name || m?.id || '')).trim();
  if (!name) return null;
  const current = Boolean(payload && (typeof m === 'string' ? m === payload.model : m.name === payload.model) && provider.slug === payload.provider);
  const free = typeof m === 'string'
    ? /free|cheap/i.test(name)
    : /free|cheap/i.test(String(m?.pricing ?? ''));
  const count = provider.total_models != null ? ` · ${provider.total_models}` : '';
  return {
    id: `${provider.slug}/${name}`,
    label: name,
    sublabel: free ? 'free' : '',
    group: `${provider.name}${count}`,
    meta: { provider: provider.slug, model: name, current },
  };
}

function renderModelItem(item, selected) {
  const mark = item.meta.current ? '● ' : '';
  const free = item.sublabel ? ` <span class="model-free">${escapeHtml(item.sublabel)}</span>` : '';
  return `<span class="cmd-label">${mark}${escapeHtml(item.label)}${free}</span>`;
}

// Fetch fresh on every open (cheap, local gateway). Returns the payload or
// null. On failure the pill keeps its known in-memory model (stored pref or
// a previously reported server model) and only falls back to 'model?' when
// nothing is known yet (CRITIQUE_BRIEF_11 #1).
async function fetchModelOptions() {
  if (modelLoading) return null;
  modelLoading = true;
  try {
    const res = await hermesFetch('/api/model/options');
    const payload = await readJson(res);
    if (!res.ok) {
      if (!modelPref?.model && !serverModel?.model) els.btnModel.textContent = 'model?';
      return null;
    }
    serverModel = { provider: payload?.provider, model: payload?.model };
    updateModelPill();
    return payload;
  } catch {
    if (!modelPref?.model && !serverModel?.model) els.btnModel.textContent = 'model?';
    return null;
  } finally {
    modelLoading = false;
  }
}

async function openModelPicker() {
  if (modelLoading) {
    // CRITIQUE_BRIEF_11 #2: a dead click is a silent no-op — say why.
    showBanner('Models are still loading — try again in a moment.', 'info');
    return;
  }
  showBanner('');
  const payload = await fetchModelOptions();
  if (!payload) {
    showBanner('Could not load models — gateway unreachable.', 'info');
    return;
  }
  const items = [];
  for (const p of Array.isArray(payload.providers) ? payload.providers : []) {
    for (const m of Array.isArray(p?.models) ? p.models : []) {
      const it = modelItem(p, m, payload);
      if (it) items.push(it);
    }
  }
  showCommandPopover({
    items,
    onSelect: applyModel,
    filterText: '',
    placeholder: 'Search models…',
    emptyMessage: 'No models match',
    renderItem: renderModelItem,
  });
  // cmdPopover.owner stays null: this popover's lifecycle is pill-click only.
  document.addEventListener('mousedown', modelPickerOutsideClick);
}

// Outside-click dismissal for the model picker (owner null). Only registered
// while that popover is open (see openModelPicker); cmdClose removes it, so
// '/' and '@' menus never see it. Clicks inside the popover (filter, rows,
// scrollbar) are ignored; a pill click toggles closed.
function modelPickerOutsideClick(e) {
  if (!cmdPopover || cmdPopover.el.contains(e.target)) return;
  if (e.target.closest?.('#btn-model')) {
    modelToggleClick = true; // the pill's click that follows must not reopen
    closeCommandPopover();
    return;
  }
  closeCommandPopover();
}

async function applyModel(item) {
  if (modelLocking) return; // CRITIQUE_BRIEF_11 #5: re-Enter/click mid-POST is ignored
  const { provider, model } = item.meta;
  const prev = modelPref;
  modelPref = { provider, model };
  updateModelPill();
  if (!activeSessionId) {
    // CRITIQUE_BRIEF_11 #3: no session yet — keep the choice in memory only
    // (never write the junk 'modelPref:' key); the first send persists it.
    closeCommandPopover();
    return;
  }
  modelLocking = true;
  try {
    const res = await hermesFetch(
      `/api/sessions/${encodeURIComponent(activeSessionId)}/model`,
      { method: 'POST', body: JSON.stringify({ model, provider }) },
    );
    if (!res.ok) {
      modelPref = prev; // lock not applied server-side — revert the pill
      updateModelPill();
      const payload = await readJson(res);
      showBanner(errorMessage(payload, `Model lock failed (${res.status})`));
      return; // toast, don't close the popover — the user can retry
    }
  } catch (err) {
    modelPref = prev;
    updateModelPill();
    showBanner(`Model lock failed: ${err.message || err}`);
    return;
  } finally {
    modelLocking = false;
  }
  storeModelPref();
  updateModelPill();
  closeCommandPopover();
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
  loadModelPref(); // fresh session (or none) → no stored pref, pill falls back
  updateModelPill();
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
  loadModelPref(); // spec 7: restore this session's stored choice
  updateModelPill();
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
  closeCommandPopover(); // a '/' menu can't float over a disabled prompt
  els.prompt.value = '';
  slashInserted = null; // CRITIQUE_BRIEF_9 #8: fresh prompt, fresh suppression
  slashDismissed = null;
  atDismissed = null;
  atUrlEscaped = false; // CRITIQUE_BRIEF_10 #8: raw-send mode ends with the prompt
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

  let full = clean;
  // TASK_BRIEF_10/12: confirmed @url:/@file:/@folder:/@git: references expand
  // into an Attached Context block; chips edited out of the prompt drop
  // their item (exactly-once — chips were consumed with the prompt below).
  const ctxBlocks = [];
  for (const item of attachedContext) {
    if (!full.includes(item.chip)) continue;
    const block = { file: 'File', url: 'URL', git: 'Git', folder: 'Folder' }[item.kind] || item.kind;
    ctxBlocks.push(`[${block}: ${item.label}]\n${item.content}`);
  }
  if (ctxBlocks.length) full = `${full}${full ? '\n\n' : ''}--- Attached Context ---\n${ctxBlocks.join('\n\n')}`;
  if (mediaLines.length) full = `${full}${full ? '\n' : ''}${mediaLines.join('\n')}`;
  attachments.length = 0;
  attachedContext.length = 0; // chips were consumed with the prompt — no dup on retry
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
    // TASK_BRIEF_11: every turn carries the per-session model lock — the
    // stored preference first, else the server-reported current model.
    // Neither known → omit the lock (gateway default, pre-switcher behavior).
    const lock = modelPref || serverModel;
    if (lock?.model && lock?.provider) {
      body.provider = lock.provider;
      body.model = lock.model;
      body.require_model_lock = true;
    }
    // CRITIQUE_BRIEF_11 #3: a pre-session choice (no junk 'modelPref:' key
    // was written at pick time) is persisted under the real session key here,
    // on the first send that gives us a session id. No-op otherwise.
    storeModelPref();

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

els.btnModel.addEventListener('click', () => {
  if (modelToggleClick) {
    modelToggleClick = false; // the mousedown just closed the picker — no reopen
    return;
  }
  openModelPicker();
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
  // TASK_BRIEF_9/10: '/' + '@' menus open/sync/close from the popover hook.
  updatePrefixMenu();
});
els.prompt.addEventListener('keydown', (e) => {
  if (isCommandPopoverOpen()) {
    // Popover takes over the keys: arrows move the highlight, Enter selects
    // (never submits), Escape closes. The normal send flow stays untouched
    // when no popover is open.
    cmdHandleKey(e);
    return;
  }
  if (e.key === 'Escape' && els.prompt.value.startsWith('@url:') && !atUrlEscaped) {
    // CRITIQUE_BRIEF_10 #8: leave confirm mode — the token is now plain text
    // (Enter sends raw, space inserts a literal space) until it stops
    // starting with '@url:'.
    e.preventDefault();
    atUrlEscaped = true;
  } else if (e.key === 'Enter' && !e.shiftKey) {
    if (gitRowBusy) {
      // CRITIQUE_BRIEF_12 #1: a /git row fetch is in flight — Enter would
      // fall through and send the raw '@diff' literal, dropping the entry.
      e.preventDefault();
      return;
    }
    if (els.prompt.value.startsWith('@url:') && !atUrlEscaped) {
      // TASK_BRIEF_10: Enter confirms an in-progress @url: instead of sending.
      e.preventDefault();
      confirmAtUrl();
      return;
    }
    if (els.prompt.value.startsWith('@folder:')) {
      // TASK_BRIEF_12: Enter opens the folder browser (paths may hold spaces).
      e.preventDefault();
      confirmAtFolder();
      return;
    }
    if (els.prompt.value.startsWith('@git:')) {
      // TASK_BRIEF_12: Enter confirms an in-progress @git: ref.
      e.preventDefault();
      confirmAtGit();
      return;
    }
    e.preventDefault();
    sendMessage(els.prompt.value);
  } else if (e.key === ' ' && !e.shiftKey && els.prompt.value.startsWith('@url:') && !atUrlEscaped) {
    e.preventDefault(); // space ends the URL token
    confirmAtUrl();
  } else if (e.key === ' ' && !e.shiftKey && els.prompt.value.startsWith('@git:')) {
    e.preventDefault(); // space ends the ref token
    confirmAtGit();
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

// ── Browser-use B1 (TASK_BRIEF_B1) ──────────────────────────────
// Status chip + tab picker for the live-browser bridge (background.js
// owns the WS client and chrome.debugger; this panel is the UI).

const BROWSER_TABS_THROTTLE_MS = 400;

let browserState = { ws: 'down', attached: false, tab: null }; // mirror of background
let browserTabs = [];
let browserTabTimer = null;

function browserChipClass() {
  if (browserState.ws !== 'connected') return 'state-off';
  if (browserState.attached) return browserState.tab?.incognito ? 'state-attn' : 'state-on';
  return 'state-attn';
}

function renderBrowserChip() {
  const el = els.btnBrowser;
  el.classList.remove('state-on', 'state-attn', 'state-off');
  el.classList.add(browserChipClass());
  if (browserState.ws !== 'connected') {
    els.browserChipText.textContent = '○ bridge down';
  } else if (browserState.attached && browserState.tab) {
    const title = browserState.tab.title || browserState.tab.url || 'tab';
    const flag = browserState.tab.incognito ? ' (incognito)' : '';
    els.browserChipText.textContent = `● ${browserState.browser || 'Chrome'} — "${title}"${flag}`;
  } else {
    els.browserChipText.textContent = '○ no tab attached';
  }
  els.btnBrowserDisconnect.textContent =
    browserState.ws === 'connected' || browserState.attached ? 'Disconnect' : 'Reconnect';
}

function renderBrowserTabs() {
  const list = els.browserTabs;
  list.textContent = '';
  if (browserState.ws !== 'connected') {
    const empty = document.createElement('div');
    empty.className = 'browser-tabs-empty';
    empty.textContent = 'Bridge down — start browser-mcp.py, then reload the extension (see README).';
    list.appendChild(empty);
    return;
  }
  if (!browserTabs.length) {
    const empty = document.createElement('div');
    empty.className = 'browser-tabs-empty';
    empty.textContent = 'No tabs';
    list.appendChild(empty);
    return;
  }
  for (const tab of browserTabs) {
    const row = document.createElement('div');
    row.className = 'browser-tab' + (tab.id === browserState.tab?.id ? ' attached' : '');
    const main = document.createElement('div');
    main.className = 'browser-tab-main';
    const title = document.createElement('span');
    title.className = 'browser-tab-title';
    title.textContent = tab.title || '(untitled)';
    const url = document.createElement('span');
    url.className = 'browser-tab-url';
    url.textContent = tab.url || '';
    main.append(title, url);
    if (tab.incognito) {
      const badge = document.createElement('span');
      badge.className = 'browser-tab-incognito';
      badge.textContent = 'incognito';
      title.appendChild(badge);
    }
    const act = document.createElement('button');
    act.className = 'browser-tab-act';
    act.type = 'button';
    act.textContent = tab.id === browserState.tab?.id ? 'Detach' : 'Attach';
    act.addEventListener('click', () => browserToggleTab(tab.id));
    row.append(main, act);
    list.appendChild(row);
  }
}

async function browserQueryState() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'browser-get-state' });
    if (res?.type === 'browser-state') browserState = { ...browserState, ...res };
  } catch {
    browserState = { ws: 'down', attached: false, tab: null };
  }
  renderBrowserChip();
  renderBrowserTabs();
}

function loadBrowserTabs() {
  clearTimeout(browserTabTimer);
  browserTabTimer = setTimeout(async () => {
    try {
      browserTabs = await chrome.tabs.query({});
    } catch {
      browserTabs = [];
    }
    renderBrowserTabs();
  }, BROWSER_TABS_THROTTLE_MS);
}

async function browserToggleTab(tabId) {
  const attachedId = browserState.tab?.id;
  const res = await chrome.runtime.sendMessage({
    type: attachedId === tabId ? 'browser-detach' : 'browser-attach',
    tabId,
  });
  if (res && !res.ok) {
    showBanner(res.error === 'TAB_BUSY'
      ? `Tab busy — close DevTools on that tab first (${res.message || ''})`
      : `Browser: ${res.error}`, 'error');
  }
  await browserQueryState();
}

async function browserDisconnect() {
  await chrome.runtime.sendMessage({ type: 'browser-disconnect' });
  browserState = { ws: 'down', attached: false, tab: null };
  renderBrowserChip();
  renderBrowserTabs();
}

function browserConnect() {
  chrome.runtime.sendMessage({ type: 'browser-connect' });
  setTimeout(browserQueryState, 500); // let the SW reconnect, then re-read
}

function initBrowserUI() {
  els.btnBrowser.addEventListener('click', () => {
    const willOpen = els.browserPanel.classList.contains('hidden');
    els.browserPanel.classList.toggle('hidden', !willOpen);
    if (willOpen) loadBrowserTabs();
  });
  els.btnBrowserRefresh.addEventListener('click', () => {
    browserQueryState();
    loadBrowserTabs();
  });
  els.btnBrowserCollapse.addEventListener('click', () => {
    els.browserPanel.classList.add('hidden');
  });
  els.btnBrowserDisconnect.addEventListener('click', () => {
    if (browserState.ws === 'connected' || browserState.attached) {
      browserDisconnect();
    } else {
      browserConnect();
    }
  });
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'browser-state') {
      browserState = { ...browserState, ...msg };
      renderBrowserChip();
      renderBrowserTabs();
    }
  });
  for (const ev of ['onCreated', 'onRemoved', 'onActivated']) {
    chrome.tabs[ev].addListener?.(loadBrowserTabs);
  }
  chrome.tabs.onUpdated?.addListener((_id, info) => {
    if (info.title !== undefined || info.url !== undefined) loadBrowserTabs();
  });
  browserQueryState();
  loadBrowserTabs();
}

// ── Boot ─────────────────────────────────────────────────────────

async function boot() {
  await loadSettings();
  initBrowserUI();
  // Version badge: manifest version + hardcoded build stamp, so the user
  // can instantly confirm the loaded build (TASK_BRIEF_2 #1).
  const v = chrome?.runtime?.getManifest?.().version || '0.1.0';
  els.versionBadge.textContent = `v${v} · ${BUILD_STRING}`;
  loadModelPref(); // spec 8: the stored choice survives reloads
  updateModelPill();
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
  fetchModelOptions(); // fire-and-forget: seed the pill's server default
}

boot();
