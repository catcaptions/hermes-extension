/**
 * Hermes Extension — ChatGPT-style side panel client.
 * Talks to local Hermes gateway REST + SSE (no build step).
 */

const STORAGE_KEY = 'hermesExtension';
const LEGACY_STORAGE_KEY = 'hermesMinimal';
const DEFAULTS = {
  gatewayUrl: 'http://127.0.0.1:8642',
  apiKey: '',
  sessionId: '',
  sessionTitle: 'New chat',
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
const BUILD_STRING = 'build 2026-08-19 run-control';

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
  queueStrip: $('queue-strip'),
  preview: $('preview'),
  previewImg: $('preview-img'),
  previewClose: $('preview-close'),
  versionBadge: $('version-badge'),
  btnBrowser: $('btn-browser'),
  browserDot: $('browser-dot'),
  browserChipText: $('browser-chip-text'),
  browserPanel: $('browser-panel'),
  browserStatus: $('browser-status'),
  browserTabs: $('browser-tabs'),
  browserAdvanced: $('browser-advanced'),
  btnBrowserAdvanced: $('btn-browser-advanced'),
  btnBrowserRefresh: $('btn-browser-refresh'),
  btnBrowserCollapse: $('btn-browser-collapse'),
  btnBrowserDisconnect: $('btn-browser-disconnect'),
  btnBrowserResetPairing: $('btn-browser-reset-pairing'),
  quickMenu: $('quick-menu'),
  btnMenu: $('btn-menu'),
  btnBrowserMenu: $('btn-browser-menu'),
  btnAttach: $('btn-attach'),
  attachInput: $('attach-input'),
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
let activeRunId = null;       // gateway run_id of the stream we're attached to (SSE events carry it)
const queuedTurns = [];       // /queue holds messages here until the current run finishes
let promptHistoryIndex = -1;
let promptHistoryDraft = '';

// ── Storage ──────────────────────────────────────────────────────

async function loadSettings() {
  const stored = await chrome.storage.local.get([STORAGE_KEY, LEGACY_STORAGE_KEY]);
  if (!stored[STORAGE_KEY] && stored[LEGACY_STORAGE_KEY]) {
    stored[STORAGE_KEY] = stored[LEGACY_STORAGE_KEY];
    await chrome.storage.local.set({ [STORAGE_KEY]: stored[LEGACY_STORAGE_KEY] });
  }
  settings = { ...DEFAULTS, ...(stored[STORAGE_KEY] || {}) };
  if (!stored[STORAGE_KEY] && !stored[LEGACY_STORAGE_KEY] && !settings.apiKey) {
    console.info('Hermes Extension: no stored settings — repaste API key if this follows a folder rename (new extension ID wipes storage)');
  }
  activeSessionId = settings.sessionId || '';
  els.cfgUrl.value = settings.gatewayUrl || DEFAULTS.gatewayUrl;
  els.cfgKey.value = settings.apiKey || '';
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

const PROVIDER_ALIASES = {
  'opencode': 'opencode-zen',
  'opencode_zen': 'opencode-zen',
  'opencode-zen': 'opencode-zen',
};
function normalizeProvider(p) {
  const raw = String(p || '').trim().toLowerCase();
  if (!raw) return '';
  return PROVIDER_ALIASES[raw] || raw;
}
function normalizeLock(lock) {
  if (!lock?.model || !lock?.provider) return lock;
  return { provider: normalizeProvider(lock.provider), model: String(lock.model).trim() };
}
function isModelLockMismatch(msg) {
  return /confirmed model lock runtime mismatch|require_model_lock|Model lock failed/i.test(String(msg || ''));
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
  const id = `hermes-${stamp}-${Math.random().toString(16).slice(2, 8)}`;
  const body = {
    id,
    title: title || `Chat · ${new Date().toLocaleString()}`,
    source: 'hermes_extension',
  };
  const res = await hermesFetch('/api/sessions', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const payload = await readJson(res);
  if (!res.ok) {
    const base = errorMessage(payload, `Create session failed (${res.status})`);
    const hint = res.status === 403 && !settings.apiKey
      ? ' — API key missing (folder rename wipes unpacked storage). Re-copy API_SERVER_KEY from ~/.hermes/.env → Settings → Test connection → Save.'
      : res.status === 403
        ? ' — gateway rejected the API key. Re-copy API_SERVER_KEY from ~/.hermes/.env → Test connection → Save; if Health OK but still 403, run hermes gateway restart.'
        : '';
    throw new Error(`${base}${hint}`);
  }
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

function pickFirst(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v != null && String(v).trim() !== '') return v;
  }
  return null;
}

function coerceThought(row) {
  const v = pickFirst(row, ['thought', 'reasoning', 'thinking']);
  if (v == null) return '';
  return String(v).trim();
}

function extractCommandFromTool(t) {
  const raw = t && typeof t === 'object' ? t : {};
  const direct = raw.command ?? raw.cmd ?? raw.code ?? raw.script;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  if (typeof direct === 'object' && direct != null) {
    const v = direct.command ?? direct.cmd ?? direct.code ?? direct.script ?? '';
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  const containers = [raw.input, raw.args, raw.arguments, raw.params, raw.tool_input, raw.toolInput, raw.parameters];
  for (const c of containers) {
    if (c == null) continue;
    if (typeof c === 'string') {
      const s = c.trim();
      if (!s) continue;
      if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
        try { const p = JSON.parse(s); const v = p.command ?? p.cmd ?? p.code ?? p.script ?? p.text ?? p.content ?? ''; if (typeof v === 'string' && v.trim()) return v.trim(); } catch {}
      }
      return s;
    }
    if (typeof c === 'object') {
      const v = c.command ?? c.cmd ?? c.code ?? c.script ?? c.text ?? c.content ?? c.query ?? '';
      if (typeof v === 'string' && v.trim()) return v.trim();
      if (Array.isArray(c.commands) && c.commands.length) return c.commands.join(' ; ').trim();
      if (Array.isArray(c) && c.length && typeof c[0] === 'string') return c.join(' ; ').trim();
    }
  }
  const fallback = raw.content ?? raw.text ?? raw.query ?? '';
  if (typeof fallback === 'string' && fallback.trim()) return fallback.trim();
  return '';
}

function coerceTools(row) {
  const raw = row?.tools ?? row?.tool_calls ?? row?.toolCalls ?? row?.tool_results ?? row?.toolResults;
  if (!Array.isArray(raw)) return [];
  return raw.map((t) => {
    if (typeof t === 'string') return { name: t, label: '', status: 'done', input: '', output: '' };
    if (!t || typeof t !== 'object') return null;
    const name = extractToolName(t, 'tool');
    const lcName = name.toLowerCase();
    if (lcName === '_thinking' || lcName === 'thinking' || lcName === 'reasoning') return null;
    const output = t.output ?? t.result ?? t.content ?? t.observation ?? t.stdout ?? t.stderr ?? '';
    const outputStr = toDisplayString(output, 4000);
    const hasOutput = Boolean(String(outputStr).trim());
    let status = String(t.status || (t.error ? 'error' : hasOutput ? 'done' : 'running')).toLowerCase();
    if (!hasOutput && !t.error && status === 'done') status = 'running';
    const inputRaw = t.input ?? t.args ?? t.arguments ?? t.params ?? '';
    const isTerminal = lcName === 'terminal' || String(t.tool || '').toLowerCase().includes('terminal');
    const cmd = isTerminal ? extractCommandFromTool(t) : '';
    const labelSrc = isTerminal ? (cmd || toDisplayString(inputRaw, 500)) : String(t.label ?? t.title ?? t.summary ?? t.description ?? '').trim();
    const label = (labelSrc || (isTerminal ? summarizeCommand(cmd) : '') || toDisplayString(inputRaw, 300)).trim().slice(0, 500) || (isTerminal && cmd ? summarizeCommand(cmd) : '');
    const displayName = isTerminal ? 'terminal' : name;
    const displayLabel = isTerminal ? (cmd ? summarizeCommand(cmd) : label) : label;
    if (isTerminal && !cmd && !displayLabel) return null;
    return { name: displayName, label: displayLabel, status: ['running', 'done', 'error'].includes(status) ? status : 'running', input: (isTerminal && cmd ? cmd : toDisplayString(inputRaw, 800)), output: outputStr };
  }).filter(Boolean).slice(0, 20);
}

function coerceDiffs(row) {
  const raw = row?.diffs ?? row?.file_changes ?? row?.fileChanges ?? row?.patches;
  if (!Array.isArray(raw)) {
    const single = row?.patch ?? row?.diff;
    if (typeof single === 'string' && single.trim()) return [{ path: String(row?.path || row?.file || 'patch'), patch: single.slice(0, 8000) }];
    return [];
  }
  return raw.map((d) => {
    if (typeof d === 'string') return { path: 'patch', patch: d.slice(0, 8000) };
    if (!d || typeof d !== 'object') return null;
    const path = String(d.path || d.file || d.filename || 'patch');
    const patch = String(d.patch || d.diff || d.content || d.hunk || '').slice(0, 8000);
    if (!patch.trim()) return null;
    return { path, patch };
  }).filter(Boolean).slice(0, 10);
}

function coerceSkills(row) {
  const raw = row?.skills ?? row?.skill_calls ?? row?.skillCalls;
  if (!Array.isArray(raw)) {
    const single = row?.skill ?? row?.skill_name ?? row?.skillName;
    if (typeof single === 'string' && single.trim()) return [{ name: single.trim() }];
    return [];
  }
  return raw.map((s) => {
    if (typeof s === 'string') return { name: s };
    if (!s || typeof s !== 'object') return null;
    return { name: String(s.name || s.skill || s.id || '').trim() || 'skill' };
  }).filter((s) => s && s.name).slice(0, 10);
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
  const thought = coerceThought(row);
  const tools = coerceTools(row);
  const diffs = coerceDiffs(row);
  const skills = coerceSkills(row);
  const hasActivity = Boolean(thought || tools.length || diffs.length || skills.length);
  if (!content && role !== 'assistant' && !hasActivity) return null;
  if (!content && role === 'assistant' && !hasActivity) return { role: 'assistant', content: '' };
  const msg = { role: role === 'system' ? 'assistant' : role, content };
  if (thought) msg.thought = thought;
  if (tools.length) msg.tools = tools;
  if (diffs.length) msg.diffs = diffs;
  if (skills.length) msg.skills = skills;
  return msg;
}

async function testConnection() {
  const res = await hermesFetch('/v1/health');
  const payload = await readJson(res);
  if (!res.ok) throw new Error(errorMessage(payload, `Health check failed (${res.status})`));
  const res2 = await hermesFetch('/api/sessions?limit=1');
  const payload2 = await readJson(res2);
  if (!res2.ok) {
    const base = errorMessage(payload2, `Auth failed (${res2.status})`);
    const hint = res2.status === 401 || res2.status === 403
      ? ' — re-copy API_SERVER_KEY from ~/.hermes/.env → Test connection → Save; if Health OK but still 401/403, run hermes gateway restart.'
      : '';
    throw new Error(`${base}${hint}`);
  }
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

// ── Activity model (Phase 1-3): SSE thought/tool/skill/diff → rich msg ──

function ensureActivity(msg) {
  if (!msg._activity) msg._activity = { thought: '', thoughtDone: false, tools: [], skills: [], diffs: [], unknown: [] };
  return msg._activity;
}

function pushTool(activity, entry) {
  const tools = activity.tools;
  const key = entry.id || entry.name || entry.type || '';
  if (key) {
    const existing = tools.find((t) => (t.id && t.id === entry.id) || (t.name && t.name === entry.name && t.status === 'running'));
    if (existing) {
      for (const k of ['name', 'label', 'type', 'status', 'input', 'output']) {
        const v = entry[k];
        if (v != null && String(v).trim() !== '') existing[k] = v;
        else if (k === 'status' && v) existing[k] = v;
      }
      if (entry.id) existing.id = entry.id;
      return;
    }
  }
  tools.push(entry);
  if (tools.length > 24) tools.shift();
}

function summarizeCommand(cmd) {
  const s = String(cmd || '').trim();
  if (!s) return '';
  const parts = s.split(/\n|;\s*/).map((p) => p.trim()).filter(Boolean);
  if (parts.length <= 1) return s.slice(0, 120);
  const first = parts[0].slice(0, 80);
  return `${first} + ${parts.length - 1} command${parts.length - 1 === 1 ? '' : 's'}`;
}

function toDisplayString(v, cap = 800) {
  if (v == null) return '';
  if (typeof v === 'string') return v.slice(0, cap);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v).slice(0, cap);
  try { return JSON.stringify(v).slice(0, cap); } catch { return String(v).slice(0, cap); }
}

function extractToolName(raw, fallback) {
  const cand = raw.name ?? raw.tool ?? raw.function ?? raw.tool_name ?? raw.id;
  if (typeof cand === 'string' && cand.trim()) return cand.trim().slice(0, 80);
  if (cand && typeof cand === 'object') {
    const inner = cand.name ?? cand.tool ?? cand.id ?? cand.label ?? '';
    if (typeof inner === 'string' && inner.trim()) return inner.trim().slice(0, 80);
  }
  return String(fallback || 'tool').slice(0, 80);
}

function ingestActivityEvent(msg, type, data) {
  const t = String(type || '').toLowerCase();
  if (!t || ['assistant.delta', 'assistant.completed', 'run.completed', 'run.started', 'message.started', 'message.completed', 'message.delta'].includes(t)) return false;
  if (t.startsWith('message.')) return false;
  if (t === 'error') return false;
  const activity = ensureActivity(msg);
  const raw = data && typeof data === 'object' ? data : {};
  const rawToolName = String(extractToolName(raw, '') || raw.tool || raw.name || '').toLowerCase();
  const isThinkingTool = rawToolName === '_thinking' || rawToolName === 'thinking' || rawToolName === 'reasoning';
  if (t.includes('thought') || t.includes('reasoning') || t.includes('thinking') || isThinkingTool) {
    const delta = raw.delta ?? raw.content ?? raw.text ?? raw.thought ?? raw.input ?? raw.args ?? raw.output ?? '';
    const s = toDisplayString(delta, 6000);
    if (s && s !== '{}' && s !== '""') activity.thought += s;
    else if (rawToolName === '_thinking' && raw.input) {
      const alt = toDisplayString(raw.input, 6000);
      if (alt) activity.thought += alt;
    }
    if (t.includes('completed') || raw.done || raw.completed) activity.thoughtDone = true;
    return true;
  }
  if (t.includes('skill')) {
    const name = toDisplayString(raw.name ?? raw.skill ?? raw.id ?? raw.label ?? '', 80).trim() || 'skill';
    if (!activity.skills.find((s) => s.name === name)) activity.skills.push({ name });
    return true;
  }
  const patchLike = raw.patch ?? raw.diff;
  const isDiffType = t.includes('diff') || t.includes('patch') || t.includes('file') || t.includes('edit') || t.includes('write') || t === 'document' || t === 'file_change';
  const hasPatchField = typeof patchLike === 'string' && patchLike.trim();
  const isFilePayload = raw.path || raw.file || raw.filename;
  if (isDiffType || hasPatchField) {
    if (hasPatchField) {
      activity.diffs.push({ path: toDisplayString(raw.path ?? raw.file ?? raw.filename ?? raw.name ?? 'patch', 200), patch: patchLike.slice(0, 8000) });
      if (activity.diffs.length > 10) activity.diffs.shift();
      if (isDiffType) return true;
    }
    if (isFilePayload && !hasPatchField) {
      const label = toDisplayString(raw.path ?? raw.file ?? raw.filename ?? '', 400).trim();
      const preview = toDisplayString(raw.preview ?? raw.content ?? raw.observation ?? '', 2000);
      const name = t.includes('read') ? `Read ${label}` : `File ${label}`;
      pushTool(activity, { id: raw.id ? String(raw.id) : '', name: name.slice(0, 120), label, type: t, status: 'done', input: label.slice(0, 400), output: preview.slice(0, 2000) });
      return true;
    }
    if (hasPatchField) return true;
  }
  if (hasPatchField) {
    activity.diffs.push({ path: toDisplayString(raw.path ?? raw.file ?? 'patch', 200), patch: String(patchLike).slice(0, 8000) });
    if (activity.diffs.length > 10) activity.diffs.shift();
    return true;
  }
  const nestedCmd = (() => {
    const direct = raw.command ?? raw.cmd ?? raw.code ?? raw.script;
    if (typeof direct === 'string' && direct.trim()) return direct.trim();
    const containers = [raw.input, raw.args, raw.arguments, raw.params, raw.tool_input, raw.toolInput, raw.parameters];
    for (const c of containers) {
      if (!c) continue;
      if (typeof c === 'string') {
        const s = c.trim();
        if (!s) continue;
        if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
          try { const p = JSON.parse(s); const v = p.command ?? p.cmd ?? p.code ?? p.script ?? p.text ?? p.content ?? ''; if (typeof v === 'string' && v.trim()) return v.trim(); } catch {}
        }
        return s;
      }
      if (typeof c === 'object') {
        const v = c.command ?? c.cmd ?? c.code ?? c.script ?? c.text ?? c.content ?? c.query ?? '';
        if (typeof v === 'string' && v.trim()) return v.trim();
        if (Array.isArray(c.commands) && c.commands.length) return c.commands.join(' ; ').trim();
        if (Array.isArray(c) && c.length && typeof c[0] === 'string') return c.join(' ; ').trim();
      }
    }
    const fallback = raw.content ?? raw.text ?? raw.query ?? raw.input_text ?? raw.command_text;
    if (typeof fallback === 'string' && fallback.trim()) return fallback.trim();
    return '';
  })();
  const isTerminal = t.includes('terminal') || String(raw.tool || '').toLowerCase().includes('terminal') || String(extractToolName(raw, '')).toLowerCase() === 'terminal' || String(raw.name || '').toLowerCase() === 'terminal';
  if (t.includes('command') || t.includes('shell') || t.includes('bash') || t.includes('exec') || isTerminal || raw.command || raw.cmd || nestedCmd) {
    const cmd = (nestedCmd || toDisplayString(raw.command ?? raw.cmd ?? raw.input ?? raw.args ?? '', 600).trim() || t).trim();
    const output = toDisplayString(raw.output ?? raw.result ?? raw.content ?? raw.observation ?? raw.stdout ?? raw.stderr ?? '', 4000);
    const shortCmd = cmd.length > 80 ? `${cmd.slice(0, 77)}…` : cmd;
    const label = isTerminal ? shortCmd : (cmd.length > 80 ? `Run: ${cmd.slice(0, 77)}…` : `Run: ${cmd}`);
    const name = isTerminal ? 'terminal' : label;
    const cmdLabel = isTerminal ? shortCmd : cmd;
    pushTool(activity, { id: raw.id ? String(raw.id) : '', name, label: cmdLabel, type: t, status: raw.error ? 'error' : 'done', input: cmd.slice(0, 800), output });
    return true;
  }
  if (isThinkingTool) return true;
  if (t.includes('tool') || t.includes('hermes.tool') || t.includes('progress') || raw.tool || raw.tool_call || raw.function) {
    if (isThinkingTool) return true;
    const name = extractToolName(raw, t);
    if (name.toLowerCase() === '_thinking' || name.toLowerCase() === 'thinking') return true;
    const labelRaw = raw.label ?? raw.title ?? raw.summary ?? raw.description ?? raw.detail ?? nestedCmd ?? '';
    const label = toDisplayString(labelRaw, 500).trim();
    const status = String(raw.status || (raw.error ? 'error' : raw.output || raw.result ? 'done' : t.includes('progress') ? 'running' : 'running')).toLowerCase();
    const entry = {
      id: raw.id ? String(raw.id) : '',
      name,
      label: label || '',
      type: t,
      status: ['running', 'done', 'error'].includes(status) ? status : 'running',
      input: raw.input ?? raw.args ?? raw.arguments ?? raw.params ?? nestedCmd ?? '',
      output: raw.output ?? raw.result ?? raw.content ?? raw.observation ?? '',
    };
    entry.input = toDisplayString(entry.input, 800);
    entry.output = toDisplayString(entry.output, 4000);
    if (!entry.label && entry.input) entry.label = entry.input.slice(0, 300);
    if (!entry.label && nestedCmd) entry.label = nestedCmd.slice(0, 300);
    if (!entry.label) entry.label = summarizeCommand(nestedCmd || entry.input || '');
    pushTool(activity, entry);
    const patch2 = raw.patch ?? raw.diff;
    if (typeof patch2 === 'string' && patch2.trim()) {
      activity.diffs.push({ path: toDisplayString(raw.path ?? raw.file ?? name, 200), patch: patch2.slice(0, 8000) });
      if (activity.diffs.length > 10) activity.diffs.shift();
    }
    return true;
  }
  try {
    const preview = JSON.stringify(raw).slice(0, 600);
    activity.unknown.push({ type: String(type), preview });
    if (activity.unknown.length > 12) activity.unknown.shift();
  } catch {
    activity.unknown.push({ type: String(type), preview: toDisplayString(raw, 600) });
  }
  return true;
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

async function readHermesSse(response, { onAssistant, onEvent, signal } = {}) {
  if (!response?.body) throw new Error('Stream returned no body.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let stream = { text: '', finalized: false };

  const processBlock = (block) => {
    const event = parseSseBlock(block);
    const data = event.json || {};
    onEvent?.(event.type, data); // every event carries run_id — stop/steer need it
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
  if (on) {
    els.prompt.disabled = false;
    els.btnModel.disabled = true; // CRITIQUE_BRIEF_11 #7: no model switch mid-stream
    els.prompt.placeholder = 'Steer the agent…';
    setConnection('busy', 'Hermes is working…');
    updateSendDisabled();
    els.prompt.focus();
  } else {
    els.prompt.placeholder = 'Do anything';
    els.prompt.disabled = false;
    els.btnModel.disabled = false;
    els.btnSend.classList.remove('steer-ready');
    els.btnSend.title = 'Send';
    els.btnSend.setAttribute('aria-label', 'Send');
    updateSendDisabled();
  }
}

function autoResizePrompt() {
  const el = els.prompt;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  updateSendDisabled();
}

function promptHistory() {
  return messages
    .filter((msg) => msg.role === 'user' && msg.content)
    .map((msg) => String(msg.content));
}

function navigatePromptHistory(direction) {
  const history = promptHistory();
  if (!history.length) return false;
  if (promptHistoryIndex === -1) promptHistoryDraft = els.prompt.value;
  const next = Math.max(-1, Math.min(history.length - 1, promptHistoryIndex + direction));
  if (next === promptHistoryIndex) return true;
  promptHistoryIndex = next;
  const value = next === -1 ? promptHistoryDraft : history[history.length - 1 - next];
  setPromptValue(value);
  return true;
}

// Shared tail of every chip/token insertion: set the prompt value (when
// given), resize, park the caret (default: end), keep focus in the composer.
function setPromptValue(value, caretPos) {
  const el = els.prompt;
  if (value !== undefined) el.value = value;
  autoResizePrompt();
  el.focus();
  const pos = caretPos ?? el.value.length;
  el.setSelectionRange(pos, pos);
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
  const hasPending = attachments.length > 0 || attachedContext.length > 0;
  if (sending) {
    const steerReady = hasText || hasPending;
    els.btnSend.disabled = !settings.apiKey;
    els.btnSend.classList.toggle('steer-ready', steerReady);
    els.btnSend.title = steerReady ? 'Steer — inject into the current run' : 'Stop — cancel the current run';
    els.btnSend.setAttribute('aria-label', steerReady ? 'Steer' : 'Stop');
    return;
  }
  els.btnSend.classList.remove('steer-ready');
  els.btnSend.title = 'Send';
  els.btnSend.setAttribute('aria-label', 'Send');
  els.btnSend.disabled = (!hasText && !hasPending) || !settings.apiKey;
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
function drawScaledDataUrl(img, maxSide, mime, q) {
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').drawImage(img, 0, 0, w, h);
  return c.toDataURL(mime, q);
}

async function encodeForSend(dataUrl) {
  const img = await loadImageEl(dataUrl);
  const mime = /^data:(image\/\w+);/i.exec(dataUrl)?.[1] || 'image/png';
  return mime === 'image/jpeg'
    ? drawScaledDataUrl(img, PASTE_MAX_SIDE, 'image/jpeg', 0.8)
    : drawScaledDataUrl(img, PASTE_MAX_SIDE, 'image/png');
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
    return drawScaledDataUrl(img, 640, 'image/jpeg', 0.6);
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

// ponytail: memoize KaTeX — same formula often repeats while streaming
const mathCache = new Map(); // key: tex\0display -> html, LRU cap 500
function mathHtml(item) {
  if (!item) return '';
  const key = `${item.tex}\0${item.display ? '1' : '0'}`;
  const cached = mathCache.get(key);
  if (cached !== undefined) return cached;
  let out;
  try {
    out = katex.renderToString(item.tex, {
      throwOnError: false,
      displayMode: Boolean(item.display),
      output: 'html',
    });
  } catch {
    // KaTeX never throws with throwOnError:false, but never break a message.
    out = escapeHtml(item.tex);
  }
  mathCache.set(key, out);
  if (mathCache.size > 500) {
    const first = mathCache.keys().next().value;
    mathCache.delete(first);
  }
  return out;
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

// ponytail: memoize rendered markdown — same text+failed/bridged often repeats (poll + streaming)
const renderCache = new Map(); // key: text\0failedKey\0bridgedKey -> html, LRU cap 100
function renderCacheKey(text, failed, bridged) {
  const fk = failed.size ? [...failed].sort((a, b) => a - b).join(',') : '';
  const bk = bridged.size ? [...bridged].sort((a, b) => a - b).join(',') : '';
  return `${text}\0${fk}\0${bk}`;
}
function renderMarkdown(text, ctx, tokens) {
  const failed = ctx?.failed || new Set();
  const bridged = ctx?.bridged || new Set();
  const key = renderCacheKey(String(text || ''), failed, bridged);
  const hit = renderCache.get(key);
  if (hit !== undefined) return hit;
  const { scrubbed, math, media, url, nonce } = tokens || renderer.extractTokens(text || '');
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
  renderCache.set(key, html);
  if (renderCache.size > 100) {
    const first = renderCache.keys().next().value;
    renderCache.delete(first);
  }
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

function getActivity(msg) {
  if (msg._activity) return msg._activity;
  const hasHist = Boolean(msg.thought || msg.tools || msg.diffs || msg.skills);
  if (!hasHist) return null;
  const a = ensureActivity(msg);
  if (msg.thought) a.thought = String(msg.thought);
  if (Array.isArray(msg.tools) && msg.tools.length) a.tools = msg.tools.map((t) => ({ name: toDisplayString(t.name || 'tool', 80), label: toDisplayString(t.label || '', 500), status: t.status || 'done', input: toDisplayString(t.input || '', 800), output: toDisplayString(t.output || '', 4000) }));
  if (Array.isArray(msg.diffs) && msg.diffs.length) a.diffs = msg.diffs.map((d) => ({ path: String(d.path || 'patch'), patch: String(d.patch || '').slice(0, 8000) }));
  if (Array.isArray(msg.skills) && msg.skills.length) a.skills = msg.skills.map((s) => ({ name: String(s.name || s) }));
  return a;
}

function renderActivityBlocks(msg) {
  const el = msg._el;
  if (!el || msg.role !== 'assistant') return;
  let host = el.querySelector('.hm-activity');
  if (!host) {
    host = document.createElement('div');
    host.className = 'hm-activity';
    const body = el.querySelector('.msg-body');
    if (body) el.insertBefore(host, body);
    else el.appendChild(host);
  }
  const activity = getActivity(msg) || msg._activity;
  if (!activity) { host.innerHTML = ''; host.style.display = 'none'; return; }
  const thought = String(activity.thought || '').trim();
  const hasThought = Boolean(thought);
  const hasTools = Array.isArray(activity.tools) && activity.tools.length > 0;
  const hasDiffs = Array.isArray(activity.diffs) && activity.diffs.length > 0;
  const hasSkills = Array.isArray(activity.skills) && activity.skills.length > 0;
  const hasUnknown = Array.isArray(activity.unknown) && activity.unknown.length > 0;
  if (!hasThought && !hasTools && !hasDiffs && !hasSkills && !hasUnknown) { host.innerHTML = ''; host.style.display = 'none'; return; }
  host.style.display = '';
  const actionItems = [];
  if (hasThought) {
    const label = thought.replace(/\s+/g, ' ').slice(0, 100);
    actionItems.push({ kind: 'thought', label, full: thought });
  }
  if (hasTools) {
    for (const t of activity.tools) {
      const dot = t.status === 'running' ? 'running' : t.status === 'error' ? 'error' : 'done';
      const title = String(t.name || 'tool').slice(0, 80);
      const detail = (String(t.label || '').trim() || String(t.input || '').trim()).slice(0, 400);
      const output = String(t.output || '').trim();
      const label = detail || t.type || '';
      actionItems.push({ kind: 'tool', title, label, dot, output });
    }
  }
  if (hasDiffs) {
    for (const d of activity.diffs) {
      actionItems.push({ kind: 'diff', title: String(d.path || 'patch').slice(0, 160), patch: String(d.patch || '') });
    }
  }
  if (hasSkills) {
    for (const s of activity.skills) actionItems.push({ kind: 'skill', title: String(s.name || s).slice(0, 60) });
  }
  if (hasUnknown) {
    for (const u of activity.unknown.slice(-6)) actionItems.push({ kind: 'unknown', title: String(u.type).slice(0, 80), label: String(u.preview || '').trim().slice(0, 400) });
  }
  if (!actionItems.length) { host.innerHTML = ''; host.style.display = 'none'; return; }
  const preview = actionItems.slice(0, 2).map((it) => {
    if (it.kind === 'thought') return `Thought › ${it.label.slice(0, 60)}`;
    if (it.kind === 'tool') return `${it.title} — ${it.label.slice(0, 50)}`;
    if (it.kind === 'diff') return `Diff: ${it.title}`;
    if (it.kind === 'skill') return `Skill: ${it.title}`;
    return it.title;
  }).join(' · ').slice(0, 120);
  const count = actionItems.length;
  const summaryLabel = count === 1 ? actionItems[0].kind === 'thought' ? 'Thought' : actionItems[0].title || 'Action' : `Actions · ${count}`;
  const collapsed = msg._actionsOpen !== true;
  const rowsHtml = actionItems.map((it, idx) => {
    if (it.kind === 'thought') {
      const short = it.label.replace(/\s+/g, ' ').slice(0, 120);
      const expanded = it.full.length > 120 || it.full.includes('\n');
      if (!expanded) return `<div class="hm-action-row"><span class="hm-tool-dot done"></span><span class="hm-action-title">Thought</span><span class="hm-action-sub">${escapeHtml(short)}</span></div>`;
      return `<div class="hm-action-row"><span class="hm-tool-dot done"></span><span class="hm-action-title">Thought</span><span class="hm-action-sub">${escapeHtml(short)}…</span></div><div class="hm-action-detail" style="padding-left:18px;white-space:pre-wrap;word-break:break-word;font-size:12px;color:var(--text-muted);">${escapeHtml(it.full.slice(0, 4000))}</div>`;
    }
    if (it.kind === 'tool') {
      const sub = it.label ? ` <span class="hm-action-sub">${escapeHtml(it.label.slice(0, 300))}</span>` : '';
      const detail = it.output ? `<div class="hm-action-detail" style="padding-left:18px;white-space:pre-wrap;word-break:break-word;font-size:12px;color:var(--text-muted);max-height:160px;overflow:auto;">${escapeHtml(it.output.slice(0, 4000))}</div>` : '';
      return `<div class="hm-action-row"><span class="hm-tool-dot ${it.dot}"></span><span class="hm-action-title">${escapeHtml(it.title)}</span>${sub}</div>${detail}`;
    }
    if (it.kind === 'diff') {
      const rawLines = it.patch.split('\n');
      const clipped = rawLines.length > 80;
      const lines = rawLines.slice(0, 80).map((ln) => {
        const cls = (typeof renderer !== 'undefined' && renderer.diffLineClass) ? renderer.diffLineClass(ln) : '';
        return `<span class="${cls}">${escapeHtml(ln)}</span>`;
      }).join('\n');
      const more = clipped ? `<div style="font-size:11px;color:var(--text-faint);padding-left:18px;">… ${rawLines.length - 80} more lines</div>` : '';
      return `<div class="hm-action-row"><span class="hm-tool-dot done"></span><span class="hm-action-title">Diff</span><span class="hm-action-sub">${escapeHtml(it.title)}</span></div><div class="hm-diff" style="margin-left:18px;"><pre style="margin:0;padding:6px 8px;font-family:var(--mono);font-size:11px;white-space:pre-wrap;word-break:break-word;max-height:160px;overflow:auto;"><code>${lines}</code></pre>${more}</div>`;
    }
    if (it.kind === 'skill') return `<div class="hm-action-row"><span class="hm-tool-dot done"></span><span class="hm-action-title">Skill</span><span class="hm-action-sub">${escapeHtml(it.title)}</span></div>`;
    return `<div class="hm-action-row"><span class="hm-tool-dot done"></span><span class="hm-action-title">${escapeHtml(it.title)}</span>${it.label ? `<span class="hm-action-sub">${escapeHtml(it.label.slice(0, 300))}</span>` : ''}</div>`;
  }).join('');
  host.innerHTML = `<details class="hm-actions"${collapsed ? '' : ' open'}><summary><span class="hm-actions-label">${escapeHtml(summaryLabel)}</span><span class="hm-actions-preview">${escapeHtml(preview)}</span><span class="hm-actions-chevron">▾</span></summary><div class="hm-actions-body">${rowsHtml}</div></details>`;
  const details = host.querySelector('details.hm-actions');
  if (details) details.addEventListener('toggle', () => { msg._actionsOpen = details.open; });
  for (const more of host.querySelectorAll('[data-diff-more]')) {
    more.addEventListener('click', () => {
      const idx = Number(more.getAttribute('data-diff-more'));
      const d = activity.diffs[idx];
      const pre = host.querySelector(`pre[data-diff="${idx}"]`);
      if (d && pre) {
        const full = String(d.patch || '').split('\n').map((ln) => {
          const cls = (typeof renderer !== 'undefined' && renderer.diffLineClass) ? renderer.diffLineClass(ln) : '';
          return `<span class="${cls}">${escapeHtml(ln)}</span>`;
        }).join('\n');
        pre.querySelector('code').innerHTML = full;
        pre.removeAttribute('data-collapsed');
        pre.style.maxHeight = 'none';
      }
      more.remove();
    });
  }
  for (const pre of host.querySelectorAll('pre[data-collapsed="1"]')) {
    pre.addEventListener('click', () => {
      pre.removeAttribute('data-collapsed');
      pre.style.maxHeight = 'none';
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
  const activity = getActivity(msg) || msg._activity;
  const hasActivity = Boolean(activity && (String(activity.thought || '').trim() || (activity.tools && activity.tools.length) || (activity.diffs && activity.diffs.length) || (activity.skills && activity.skills.length) || (activity.unknown && activity.unknown.length)));
  const text = String(msg.content || '').trim();
  if (!text && hasActivity) {
    body.style.display = 'none';
    body.innerHTML = '';
  } else {
    body.style.display = '';
    // ponytail: per-message memo — skip extractTokens+renderMarkdown when content unchanged
    const fk = failed.size ? [...failed].sort((a, b) => a - b).join(',') : '';
    const bk = bridged.size ? [...bridged].sort((a, b) => a - b).join(',') : '';
    const cacheKey = `${msg.content || ''}\0${fk}\0${bk}`;
    if (msg._renderKey === cacheKey && msg._renderHtml !== undefined) {
      body.innerHTML = msg._renderHtml;
      // tokens.media still needed for fallback error chain
      if (!msg._media) msg._media = renderer.extractTokens(msg.content || '').media;
      attachMediaFallbacks(body, msg);
    } else {
      const tokens = renderer.extractTokens(msg.content || '');
      msg._media = tokens.media;
      const html = renderMarkdown(msg.content, { failed, bridged }, tokens);
      msg._renderKey = cacheKey;
      msg._renderHtml = html;
      body.innerHTML = html;
      attachMediaFallbacks(body, msg);
    }
  }
  renderActivityBlocks(msg);
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
    div.innerHTML = `<div class="msg-role">${escapeHtml(roleLabel)}</div><div class="hm-activity" style="display:none"></div><div class="msg-body"></div>`;
    msg._el = div;
    els.messages.appendChild(div);
    renderMessageBody(msg);
  }
  scrollToBottomIfNear();
}

function openSettings(open) {
  if (open) closeQuickMenu();
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
  // skills items carry id/label, panel commands carry name — normalize.
  const name = String(item.name || item.id || '').trim();
  if (!name) return;
  const inserted = `/${name}`;
  // CRITIQUE_BRIEF_9 #6: replace the whole in-progress token (up to whitespace),
  // not just the caret-to-head span — a mid-token selection would keep a tail.
  const sp = el.value.search(/\s/);
  const tokenEnd = sp === -1 ? el.value.length : sp;
  slashInserted = name; // CRITIQUE_BRIEF_9 #4: token-exact suppression
  closeCommandPopover();
  setPromptValue(inserted + el.value.slice(tokenEnd));
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
    // Panel commands ride on top of the gateway skills (insertSkill builds
    // '/<name>' from .name, so these insert the command token for typing).
    const panelCmds = [
      { name: 'queue', label: '/queue', sublabel: 'Send after the current run finishes', group: 'Panel commands' },
      { name: 'steer', label: '/steer', sublabel: 'Inject into the current run (falls back to queue)', group: 'Panel commands' },
      { name: 'stop', label: '/stop', sublabel: 'Cancel the running turn', group: 'Panel commands' },
    ];
    const items = [...panelCmds, ...rows(payload).map(skillItem).filter(Boolean)];
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

// Shared text-file acceptance for every read path (@file: picker, folder
// browser, composer + button): NUL-byte binary detection (readAsText turns
// invalid UTF-8 into U+0000 — CRITIQUE_BRIEF_10 #3) + the 512 KB cap.
// Returns the (possibly truncated) content, or null after toasting.
function acceptTextContent(name, content) {
  if (content.includes('\u0000')) {
    showBanner(`Skipped binary file: ${name}`, 'info');
    return null;
  }
  if (content.length > 512 * 1024) {
    content = `${content.slice(0, 512 * 1024)}\n… (truncated at 512 KB)`;
  }
  return content;
}

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
  else if (kind === 'url') insertAtToken('@url:');
  else if (kind === 'folder') insertAtToken('@folder:');
  else if (kind === 'diff' || kind === 'staged') insertGitRow(kind);
  else if (kind === 'git') insertAtToken('@git:');
  else insertAtToken('@image:');
}

// Insert a command token ('@url:', '@image:', '@folder:', '@git:') in place
// of the nearest '@…' before the caret, caret right after the colon so the
// user can type/paste the URL/path/ref. No-op when there is no token before
// the caret (CRITIQUE_BRIEF_10 #12: no caret jump — atReplacePrefix returns
// null and never touches the prompt).
function insertAtToken(token) {
  closeCommandPopover();
  const r = atReplacePrefix(token);
  if (!r) return;
  setPromptValue(els.prompt.value, r.prefix.length + token.length);
}

// ── @folder: / @git: / @diff / @staged (TASK_BRIEF_12) ──────────

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
    setPromptValue(r.prefix + entry.chip + r.tail);
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
  // Keep the input in the document while the picker is open — Chrome side
  // panels drop change events from detached programmatic inputs.
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = '*/*';
  input.hidden = true;
  document.body.appendChild(input);
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
    const content = acceptTextContent(file.name, String(reader.result || ''));
    if (content === null) {
      done?.();
      return;
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
  const chips = s.chips.join(' ');
  setPromptValue(s.prefix + chips + (s.tail ? `${chips ? ' ' : ''}${s.tail}` : ''));
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
  const entry = queueAttached('url', url, content || title || '');
  setPromptValue(entry.chip + el.value.slice(head.length));
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
  const s = folderSession;
  if (!s) return;
  setPromptValue(els.prompt.value.startsWith(s.head)
    ? chip + els.prompt.value.slice(s.head.length)
    : `${els.prompt.value} ${chip}`.trim());
}

// A file picked in the folder browser is read through the bridge (the
// extension has no filesystem access), then fed through the SAME acceptance
// pipeline as the OS @file: picker — binary-ext + NUL-byte checks and the
// 512 KB cap — so both flows share one reader path (TASK_BRIEF_12 spec 2).
async function attachFolderFile(meta) {
  const { name, path } = meta;
  if (binaryExt.test(name)) {
    showBanner(`Skipped binary file: ${name}`, 'info');
    return false;
  }
  let res;
  try {
    res = await fetch(`${BRIDGE_BASE}/media?path=${encodeURIComponent(path)}`, {
      signal: AbortSignal.timeout(60000),
    });
  } catch {
    showBanner(`Could not read ${name} — bridge unreachable.`, 'info');
    return false;
  }
  if (!res.ok) {
    showBanner(`Could not read ${name} (${res.status}).`, 'info');
    return false;
  }
  const ctype = (res.headers.get('Content-Type') || '').split(';')[0].trim();
  const bytes = await res.arrayBuffer();
  if (ctype.startsWith('image/')) {
    // Synthetic File → the same image pipeline as paste/@file: (bridge save).
    ingestImageFile(new File([bytes], name, { type: ctype }));
    return true;
  }
  const content = acceptTextContent(name, new TextDecoder('utf-8').decode(bytes));
  if (content === null) return false;
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
  setPromptValue(entry.chip + el.value.slice(head.length));
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
  if (parseLocalCommand(v)) {
    // '/queue …', '/steer …', '/stop' are panel commands — no skills menu
    // floating over the argument text.
    if (cmdPopover?.owner === 'skills') closeCommandPopover();
    return;
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
  if (stored?.model && stored?.provider) {
    const rawProvider = String(stored.provider);
    const normalized = normalizeLock(stored);
    if (normalized.provider !== rawProvider) {
      try { localStorage.setItem(modelPrefKey(), JSON.stringify(normalized)); } catch {}
    }
    stored = normalized;
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
  const current = Boolean(payload && (typeof m === 'string' ? m === payload.model : m.name === payload.model) && normalizeProvider(provider.slug) === normalizeProvider(payload.provider));
  const free = typeof m === 'string'
    ? /free|cheap/i.test(name)
    : /free|cheap/i.test(String(m?.pricing ?? ''));
  const count = provider.total_models != null ? ` · ${provider.total_models}` : '';
  return {
    id: `${provider.slug}/${name}`,
    label: name,
    sublabel: free ? 'free' : '',
    group: `${provider.name}${count}`,
    meta: { provider: normalizeProvider(provider.slug), model: name, current },
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
    serverModel = normalizeLock({ provider: payload?.provider, model: payload?.model }) || { provider: payload?.provider, model: payload?.model };
    if (payload?.provider) payload.provider = normalizeProvider(payload.provider);
    if (Array.isArray(payload?.providers)) {
      for (const p of payload.providers) if (p?.slug) p.slug = normalizeProvider(p.slug) || p.slug;
    }
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
  const raw = item.meta;
  const normalized = normalizeLock(raw) || raw;
  const { provider, model } = normalized;
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
      const msg = errorMessage(payload, `Model lock failed (${res.status})`);
      showBanner(msg, isModelLockMismatch(msg) ? 'info' : 'error');
      return; // toast, don't close the popover — the user can retry
    }
  } catch (err) {
    modelPref = prev;
    updateModelPill();
    const msg = `Model lock failed: ${err.message || err}`;
    showBanner(msg, isModelLockMismatch(msg) ? 'info' : 'error');
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

    // Stage 2: full history + fingerprint reconciliation (text + activity).
    const serverMsgs = await getMessages(sid);
    if (activeSessionId !== sid || sending) return; // adoption-time guards
    const afp = (typeof renderer !== 'undefined' && renderer.activityFingerprint)
      ? serverMsgs.map((m) => renderer.activityFingerprint(m)).join('\u0001')
      : '';
    const fp = `${renderer.fingerprint(serverMsgs)}\u0000${afp}`;
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

// Seed poll state from freshly-loaded/just-streamed local messages (text + activity).
function syncPollState() {
  const afp = (typeof renderer !== 'undefined' && renderer.activityFingerprint)
    ? messages.map((m) => {
        const a = m._activity;
        if (a) return renderer.activityFingerprint({ thought: a.thought, tools: a.tools, diffs: a.diffs, skills: a.skills, unknown: a.unknown });
        return renderer.activityFingerprint(m);
      }).join('\u0001')
    : '';
  lastFingerprint = `${renderer.fingerprint(messages)}\u0000${afp}`;
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
  queuedTurns.length = 0; // stale context — queued messages don't carry over
  renderQueueStrip();
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
  queuedTurns.length = 0; // the queue belonged to the previous session
  renderQueueStrip();
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
  closeQuickMenu();
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

// ── Run control: /stop, /steer, /queue (gateway /v1/runs API) ────
// A client-side stream abort does NOT cancel the gateway run — it finishes
// server-side and the poll then renders the reply ("stop doesn't work").
// Stop therefore also POSTs /v1/runs/{run_id}/stop (cooperative interrupt;
// run_id rides on every SSE event). /steer injects into the running turn and
// falls back to /queue on a 409 (run not accepting input), matching the CLI.

function stopActiveRun() {
  const runId = activeRunId;
  abortController?.abort(); // client stream off
  activeRunId = null;
  if (!runId) return;
  hermesFetch(`/v1/runs/${encodeURIComponent(runId)}/stop`, {
    method: 'POST',
    body: '{}',
  })
    .then((res) => {
      showBanner(res.ok
        ? 'Stopped — the run was cancelled on the server.'
        : 'Stopped the stream, but the server may still finish the run.', 'info');
    })
    .catch(() => showBanner('Stopped the stream (could not reach the server to cancel the run).', 'info'));
}

async function steerActiveRun(text) {
  if (!activeRunId) {
    // Steer needs the run_id, and only runs this panel is streaming expose
    // theirs (the API has no session→run listing). Nothing to inject into
    // from here → normal turn (queue semantics: send now when idle).
    enqueueTurn(text, 'No run streaming in this panel — sending now. '
      + '(/steer only reaches runs started from this panel.)');
    return;
  }
  try {
    const res = await hermesFetch(`/v1/runs/${encodeURIComponent(activeRunId)}/steer`, {
      method: 'POST',
      body: JSON.stringify({ message: text }),
    });
    if (res.ok) {
      showBanner('Steered — the agent sees this after its next tool call.', 'info');
      return;
    }
    if (res.status === 409) {
      enqueueTurn(text, 'Run is not accepting steer input — queued as the next turn.');
      return;
    }
    const payload = await readJson(res);
    showBanner(`Steer failed: ${errorMessage(payload, res.status)}`);
  } catch (err) {
    showBanner(`Steer failed: ${err.message || err}`);
  }
}

function enqueueTurn(text, note) {
  if (!sending && !activeRunId) {
    sendMessage(text); // idle — queue modes only apply while the agent works
    return;
  }
  queuedTurns.push(text);
  renderQueueStrip();
  showBanner(note || 'Queued — sends when the current run finishes.', 'info');
}

function renderQueueStrip() {
  els.queueStrip.classList.toggle('hidden', queuedTurns.length === 0);
  els.queueStrip.innerHTML = '';
  queuedTurns.forEach((text, i) => {
    const chip = document.createElement('div');
    chip.className = 'chip';
    chip.title = text;
    const label = document.createElement('span');
    label.className = 'queue-chip-text';
    label.textContent = `⏳ ${text.length > 60 ? `${text.slice(0, 59)}…` : text}`;
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'chip-x';
    x.textContent = '×';
    x.title = 'Remove queued message';
    x.setAttribute('aria-label', 'Remove queued message');
    x.addEventListener('click', () => {
      queuedTurns.splice(i, 1);
      renderQueueStrip();
    });
    chip.append(label, x);
    els.queueStrip.appendChild(chip);
  });
}

// Panel-local slash commands (never sent to the gateway as chat text).
const LOCAL_COMMANDS = {
  queue: '/queue <message> — send after the current run finishes (sends now when idle)',
  steer: '/steer <message> — inject into the current run; falls back to queue',
  stop: '/stop — cancel the running turn',
};

function parseLocalCommand(value) {
  const m = /^\/(queue|steer|stop)(?:\s+([\s\S]*))?$/.exec(String(value || '').trim());
  return m ? { cmd: m[1], arg: (m[2] || '').trim() } : null;
}

// Returns true when the prompt value was a local command and was consumed
// (Enter must then not submit the form).
function handleLocalCommand(value) {
  const parsed = parseLocalCommand(value);
  if (!parsed) return false;
  closeCommandPopover();
  const { cmd, arg } = parsed;
  if (cmd === 'stop') {
    if (!sending && !activeRunId) {
      showBanner('Nothing is running.', 'info');
    } else {
      stopActiveRun();
    }
    els.prompt.value = '';
    autoResizePrompt();
    return true;
  }
  if (!arg) {
    showBanner(LOCAL_COMMANDS[cmd], 'info');
    return true;
  }
  els.prompt.value = '';
  autoResizePrompt();
  if (cmd === 'queue') enqueueTurn(arg);
  else steerActiveRun(arg);
  return true;
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
    // Plain message (+ @image: data URLs as lines). Browser use runs
    // agent-side through the live_browser MCP — no page context here.
    const body = {
      message: full,
    };
    // TASK_BRIEF_11: every turn carries the per-session model lock — the
    // stored preference first, else the server-reported current model.
    // Neither known → omit the lock (gateway default, pre-switcher behavior).
    const rawLock = modelPref || serverModel;
    const lock = normalizeLock(rawLock) || rawLock;
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
      const msg = errorMessage(payload, `Stream failed (${res.status})`);
      if (isModelLockMismatch(msg)) {
        showBanner(msg, 'info');
        throw new Error(msg);
      }
      throw new Error(msg);
    }

    const finalText = await readHermesSse(res, {
      signal: abortController.signal,
      onEvent: (type, data) => {
        if (data?.run_id) activeRunId = data.run_id; // run.started arrives first thing
        if (ingestActivityEvent(assistantMsg, type, data)) scheduleStreamingRender(assistantMsg);
      },
      onAssistant: (content) => {
        assistantMsg.content = content;
        scheduleStreamingRender(assistantMsg);
      },
    });

    clearTimeout(streamTimer);
    assistantMsg.content = finalText || assistantMsg.content || '';
    const act = assistantMsg._activity;
    const hasAct = Boolean(act && (String(act.thought || '').trim() || (act.tools && act.tools.length) || (act.diffs && act.diffs.length) || (act.skills && act.skills.length) || (act.unknown && act.unknown.length)));
    if (!assistantMsg.content && !hasAct) assistantMsg.content = '(empty reply)';
    assistantMsg.streaming = false;
    if (act) {
      for (const t of act.tools) if (t.status === 'running') t.status = 'done';
    }
    syncPollState();
    renderMessages();
    setConnection('online', baseUrl().replace(/^https?:\/\//, ''));
  } catch (err) {
    if (err?.name === 'AbortError') {
      assistantMsg.content = assistantMsg.content || '(stopped)';
      assistantMsg.streaming = false;
    } else {
      const mismatch = isModelLockMismatch(err.message || String(err));
      // Drop empty streaming bubble; show error instead. Keep activity bubbles even when content is empty.
      const act2 = assistantMsg._activity;
      const hasAct2 = Boolean(act2 && (String(act2.thought || '').trim() || (act2.tools && act2.tools.length) || (act2.diffs && act2.diffs.length) || (act2.skills && act2.skills.length) || (act2.unknown && act2.unknown.length)));
      if (!assistantMsg.content && !hasAct2) {
        if (mismatch) {
          messages = messages.filter((m) => m !== assistantMsg);
          showBanner(err.message || String(err), 'info');
        } else {
          messages = messages.filter((m) => m !== assistantMsg);
          messages.push({ role: 'assistant', content: err.message || String(err), error: true });
        }
      } else {
        assistantMsg.streaming = false;
        showBanner(err.message || String(err), mismatch ? 'info' : 'error');
      }
      setConnection('offline', 'Error');
    }
    clearTimeout(streamTimer);
    syncPollState();
    renderMessages();
  } finally {
    abortController = null;
    activeRunId = null;
    streamingSessionId = '';
    setSending(false);
    autoResizePrompt();
    els.prompt.focus();
    // /queue drain: the run finished — fire the next queued turn.
    if (queuedTurns.length && settings.apiKey) {
      sendMessage(queuedTurns.shift());
      renderQueueStrip();
    }
  }
}

// ── Event wiring ─────────────────────────────────────────────────

els.btnSettings.addEventListener('click', () => { closeQuickMenu(); openSettings(true); });
els.btnCloseSettings.addEventListener('click', () => openSettings(false));
els.btnNew.addEventListener('click', () => { closeQuickMenu(); beginNewChat(); });
els.btnSessions.addEventListener('click', (e) => {
  e.stopPropagation();
  openSessionMenu();
});
els.btnRefreshSessions.addEventListener('click', (e) => {
  e.stopPropagation();
  openSessionMenu();
});

// Quick menu (three-dot)
function closeQuickMenu() {
  els.quickMenu.classList.add('hidden');
  els.btnMenu.setAttribute('aria-expanded', 'false');
}
function openQuickMenu() {
  els.quickMenu.classList.remove('hidden');
  els.btnMenu.setAttribute('aria-expanded', 'true');
}
function toggleQuickMenu() {
  if (els.quickMenu.classList.contains('hidden')) openQuickMenu();
  else closeQuickMenu();
}
els.btnMenu.addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  closeSessionMenu();
  toggleQuickMenu();
});
els.btnBrowserMenu.addEventListener('click', () => {
  closeQuickMenu();
  // Toggle the browser panel (same as clicking the browser chip)
  els.btnBrowser.click();
});

document.addEventListener('click', (e) => {
  // Close session menu on outside click
  if (!els.sessionMenu.classList.contains('hidden')) {
    if (!els.sessionMenu.contains(e.target) && e.target !== els.btnSessions && !els.btnSessions.contains(e.target)) {
      closeSessionMenu();
    }
  }
  // Close quick menu on outside click
  if (!els.quickMenu.classList.contains('hidden')) {
    if (!els.quickMenu.contains(e.target) && e.target !== els.btnMenu && !els.btnMenu.contains(e.target)) {
      closeQuickMenu();
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

function collectSteerTextAndClear() {
  if (!els.prompt.value.trim() && attachments.length === 0 && attachedContext.length === 0) return null;
  const raw = els.prompt.value;
  const pending = [...attachments];
  const ctxBlocks = [];
  for (const item of attachedContext) {
    // During a steer the prompt holds the chip text already — expand it here;
    // otherwise plain typed text stays as-is.
    if (raw.includes(item.chip)) ctxBlocks.push(`[${{ file: 'File', url: 'URL', git: 'Git', folder: 'Folder' }[item.kind] || item.kind}: ${item.label}]\n${item.content}`);
  }
  let text = raw;
  if (ctxBlocks.length) text = `${text}${text ? '\n\n' : ''}--- Attached Context ---\n${ctxBlocks.join('\n\n')}`;
  text = text.trim();
  els.prompt.value = '';
  attachments.length = 0;
  attachedContext.length = 0;
  renderChips();
  slashInserted = null;
  slashDismissed = null;
  atDismissed = null;
  atUrlEscaped = false;
  autoResizePrompt();
  updateSendDisabled();
  if (pending.length) {
    (async () => {
      for (const a of pending) {
        try {
          const enc = await encodeForSend(a.dataUrl);
          const path = await saveImageToBridge(enc);
          const line = path ? `@image:${path}` : `@image:${await cappedDataUrl(enc)}`;
          if (sending) enqueueTurn(line, 'Image queued — sends after this run.');
          else sendMessage(line);
        } catch {}
      }
    })();
  }
  return text || null;
}

els.composer.addEventListener('submit', (e) => {
  e.preventDefault();
  if (sending) {
    if (handleLocalCommand(els.prompt.value)) return;
    const hasSteerContent = Boolean(els.prompt.value.trim() || attachments.length || attachedContext.length);
    if (!hasSteerContent) { stopActiveRun(); return; }
    const text = collectSteerTextAndClear();
    if (!text) return;
    steerActiveRun(text);
    return;
  }
  sendMessage(els.prompt.value);
});

els.btnSend.addEventListener('click', (e) => {
  if (sending) {
    e.preventDefault();
    if (handleLocalCommand(els.prompt.value)) return;
    const hasSteerContent = Boolean(els.prompt.value.trim() || attachments.length || attachedContext.length);
    if (!hasSteerContent) { stopActiveRun(); return; }
    const text = collectSteerTextAndClear();
    if (!text) return;
    steerActiveRun(text);
  }
});

els.prompt.addEventListener('input', () => {
  if (promptHistoryIndex !== -1) {
    promptHistoryIndex = -1;
    promptHistoryDraft = els.prompt.value;
  }
  autoResizePrompt();
  // TASK_BRIEF_9/10: '/' + '@' menus open/sync/close from the popover hook.
  updatePrefixMenu();
});
els.prompt.addEventListener('keydown', (e) => {
  if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.altKey && !e.ctrlKey && !e.metaKey && !isCommandPopoverOpen()) {
    const atBoundary = e.key === 'ArrowUp'
      ? els.prompt.selectionStart === 0 && els.prompt.selectionEnd === 0
      : els.prompt.selectionStart === els.prompt.value.length && els.prompt.selectionEnd === els.prompt.value.length;
    if (atBoundary && navigatePromptHistory(e.key === 'ArrowUp' ? 1 : -1)) {
      e.preventDefault();
      return;
    }
  }
  if (e.key === 'Escape' && sending && !isCommandPopoverOpen() && !els.prompt.value.startsWith('@url:')) {
    e.preventDefault();
    stopActiveRun();
    showBanner('Stopped — the run was cancelled on the server.', 'info');
    return;
  }
  if (sending && e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
    if (isCommandPopoverOpen()) { cmdHandleKey(e); return; }
    if (els.prompt.value.startsWith('@url:') && !atUrlEscaped) { e.preventDefault(); confirmAtUrl(); return; }
    if (els.prompt.value.startsWith('@folder:')) { e.preventDefault(); confirmAtFolder(); return; }
    if (els.prompt.value.startsWith('@git:')) { e.preventDefault(); confirmAtGit(); return; }
    if (!els.prompt.value.trim() && attachments.length === 0 && attachedContext.length === 0) return;
    e.preventDefault();
    if (handleLocalCommand(els.prompt.value)) return;
    const text = collectSteerTextAndClear();
    if (text) steerActiveRun(text);
    return;
  }
  // Panel-local commands (/queue, /steer, /stop) win over the skills popover
  // and over sending — checked first so '/steer do X' + Enter never submits.
  if (e.key === 'Enter' && !e.shiftKey && handleLocalCommand(els.prompt.value)) {
    e.preventDefault();
    return;
  }
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

// Attach button: permanent input in the DOM (Chrome side panels ignore
// click() on a freshly created, detached <input type="file">). Images go
// to the paste chip strip; text files become [File: …] attached-context chips.
function ingestComposerFiles(fileList) {
  const files = [...(fileList || [])];
  if (!files.length) return;
  for (const file of files) {
    if (!file) continue;
    if (file.type.startsWith('image/')) {
      ingestImageFile(file);
      continue;
    }
    // Reuse @file: reader path, but inject the chip into the live prompt
    // (no atFileSession — the + button is not a token round).
    handleComposerFile(file);
  }
}

function handleComposerFile(file) {
  const textMime = /^(text\/|application\/.*(json|xml)(;|$))/;
  if (binaryExt.test(file.name) || (file.type && !textMime.test(file.type))) {
    showBanner(`Skipped binary file: ${file.name}`, 'info');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const content = acceptTextContent(file.name, String(reader.result || ''));
    if (content === null) return;
    const entry = queueAttached('file', file.name, content);
    const pad = els.prompt.value && !/\s$/.test(els.prompt.value) ? ' ' : '';
    setPromptValue(`${els.prompt.value}${pad}${entry.chip}`);
  };
  reader.onerror = () => showBanner(`Could not read ${file.name}`, 'info');
  reader.readAsText(file);
}

els.btnAttach.addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (!els.attachInput) return;
  els.attachInput.value = ''; // allow re-picking the same file
  els.attachInput.click();
});
els.attachInput?.addEventListener('change', () => {
  ingestComposerFiles(els.attachInput.files);
  els.attachInput.value = '';
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !els.preview.classList.contains('hidden')) closePreview();
  else if (e.key === 'Escape' && !els.quickMenu.classList.contains('hidden')) {
    e.preventDefault();
    closeQuickMenu();
  }
});

// ── Browser-use (B1+) ────────────────────────────────────────────
// Status chip + agent-session card for the live-browser bridge
// (background.js owns the WS client and chrome.debugger; this panel is
// the UI). Attachment is AGENT-driven (demand-only debugger): the chip
// and card reflect what the agent is doing, not what the user attached.
// Manual attach survives under the Advanced disclosure.

const BROWSER_TABS_THROTTLE_MS = 400;
const BROWSER_POLL_MS = 2000;      // state round-trip while the panel is open
const BROWSER_TICK_MS = 1000;      // local re-render: countdown / pulse decay
const DRIVING_WINDOW_MS = 10_000;  // mirrors background.js
const IDLE_RELEASE_MS = 3 * 60_000; // mirrors background.js IDLE_DETACH_MS

let browserState = { ws: 'down', attached: false, tab: null }; // mirror of background
let browserTabs = [];
let browserTabTimer = null;
let browserPollTimer = null;

function drivingNow() {
  return Boolean(browserState.attached) && browserState.lastActivity > 0 &&
    Date.now() - browserState.lastActivity < DRIVING_WINDOW_MS;
}

function fmtAgo(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 3) return 'just now';
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function fmtIn(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function tabLabel(tab) {
  const s = String(tab?.title || tab?.url || 'tab');
  return s.length > 36 ? `${s.slice(0, 35)}…` : s;
}

function browserChipClass() {
  if (browserState.ws !== 'connected') return 'state-off';
  if (!browserState.attached) return 'state-ready'; // healthy resting state
  if (browserState.tab?.incognito) return 'state-attn';
  return 'state-on';
}

function renderBrowserChip() {
  const el = els.btnBrowser;
  el.classList.remove('state-on', 'state-attn', 'state-off', 'state-ready', 'driving');
  el.classList.add(browserChipClass());
  if (drivingNow()) el.classList.add('driving');
  if (browserState.ws !== 'connected') {
    els.browserChipText.textContent = '○ bridge down';
  } else if (!browserState.attached) {
    els.browserChipText.textContent = '○ browser ready';
  } else {
    const title = tabLabel(browserState.tab);
    const flag = browserState.tab?.incognito ? ' (incognito)' : '';
    els.browserChipText.textContent = drivingNow()
      ? `● driving — "${title}"${flag}`
      : `○ attached — "${title}"${flag}`;
  }
  els.btnBrowserDisconnect.textContent =
    browserState.ws === 'connected' || browserState.attached ? 'Disconnect agent' : 'Reconnect agent';
}

function renderBrowserTabs() {
  if (els.browserAdvanced.classList.contains('hidden')) return; // advanced closed — skip
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

// The agent-session card: connection state, what's being driven, and the
// idle-release countdown. Re-rendered by the 1 s tick so the countdown and
// "driving" pulse decay without new messages.
function renderBrowserStatus() {
  const el = els.browserStatus;
  el.textContent = '';
  el.classList.remove('state-on', 'state-off');
  const line = (cls, text) => {
    const d = document.createElement('div');
    d.className = cls;
    d.textContent = text;
    el.appendChild(d);
  };
  if (browserState.ws !== 'connected') {
    el.classList.add('state-off');
    line('browser-status-title', 'Bridge down');
    line('browser-status-sub',
      'Start browser-mcp.py (Hermes spawns it automatically), then reload the extension.');
    return;
  }
  if (!browserState.attached) {
    line('browser-status-title', 'Idle — debugger released');
    line('browser-status-sub',
      'No debugging banner is shown. The agent attaches a tab automatically when it next uses a browser tool.');
    return;
  }
  el.classList.add('state-on');
  const title = tabLabel(browserState.tab);
  const flag = browserState.tab?.incognito ? ' (incognito ⚠)' : '';
  if (drivingNow()) {
    line('browser-status-title', `Driving "${title}"${flag}`);
    line('browser-status-sub', `Agent is using browser tools — last action ${fmtAgo(Date.now() - browserState.lastActivity)}.`);
  } else if (browserState.lastActivity > 0) {
    line('browser-status-title', `Attached to "${title}"${flag}`);
    const left = browserState.lastActivity + IDLE_RELEASE_MS - Date.now();
    line('browser-status-sub', left > 0
      ? `Quiet — debugger auto-releases in ${fmtIn(left)}.`
      : 'Quiet — releasing the debugger…');
  } else {
    line('browser-status-title', `Attached to "${title}"${flag}`);
    line('browser-status-sub', 'Agent idle.');
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
  renderBrowserStatus();
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
  renderBrowserStatus();
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
    if (willOpen) {
      browserQueryState();
      loadBrowserTabs();
    }
  });
  els.btnBrowserRefresh.addEventListener('click', () => {
    browserQueryState();
    loadBrowserTabs();
  });
  els.btnBrowserCollapse.addEventListener('click', () => {
    els.browserPanel.classList.add('hidden');
  });
  els.btnBrowserAdvanced.addEventListener('click', () => {
    const willOpen = els.browserAdvanced.classList.contains('hidden');
    els.browserAdvanced.classList.toggle('hidden', !willOpen);
    els.btnBrowserAdvanced.setAttribute('aria-expanded', String(willOpen));
    els.btnBrowserAdvanced.textContent = willOpen
      ? '▾ Advanced — manual attach & pairing'
      : '▸ Advanced — manual attach & pairing';
    if (willOpen) {
      browserQueryState();
      loadBrowserTabs();
    }
  });
  els.btnBrowserDisconnect.addEventListener('click', () => {
    if (browserState.ws === 'connected' || browserState.attached) {
      browserDisconnect();
    } else {
      browserConnect();
    }
  });
  els.btnBrowserResetPairing.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'browser-reset-pairing' });
    browserState = { ws: 'down', attached: false, tab: null };
    renderBrowserChip();
    renderBrowserStatus();
    renderBrowserTabs();
    showBanner('Pairing reset — reconnecting with a fresh token', 'info');
  });
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'browser-state') {
      browserState = { ...browserState, ...msg };
      renderBrowserChip();
      renderBrowserStatus();
      renderBrowserTabs();
    }
  });
  for (const ev of ['onCreated', 'onRemoved', 'onActivated']) {
    chrome.tabs[ev].addListener?.(loadBrowserTabs);
  }
  chrome.tabs.onUpdated?.addListener((_id, info) => {
    if (info.title !== undefined || info.url !== undefined) loadBrowserTabs();
  });
  // State round-trip while the panel is open (driving/idle transitions and
  // fresh lastAction timestamps), plus a local 1 s tick so the idle-release
  // countdown and the driving pulse decay without any messages.
  browserPollTimer = setInterval(() => {
    if (!els.browserPanel.classList.contains('hidden')) browserQueryState();
  }, BROWSER_POLL_MS);
  setInterval(() => {
    renderBrowserChip();
    if (!els.browserPanel.classList.contains('hidden')) renderBrowserStatus();
  }, BROWSER_TICK_MS);
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
