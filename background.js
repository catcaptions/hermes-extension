// Hermes Extension — MV3 service worker.
// 1) sidePanel behavior (toolbar click opens the panel).
// 2) Browser-use layer B1 (TASK_BRIEF_B1): WebSocket client for the local
//    browser-mcp.py hub (ws://127.0.0.1:8644) + chrome.debugger relay.
//    The extension connects OUT to the hub, pairs with a token, and tunnels
//    CDP commands to the USER'S real tabs. Protocol: see PROTOCOL.md.

const WS_URL = 'ws://127.0.0.1:8644';
const RECONNECT_BACKOFF = [1000, 2000, 4000, 8000, 16000]; // ms, then capped
const KEEPALIVE_ALARM = 'hermes-browser-keepalive';
const TAB_BUSY_MSG = 'TAB_BUSY';
// A gateway (or anything else) can shadow ws://127.0.0.1:8644 while
// browser-mcp.py is down — only a hello-ack from the hub proves the peer.
const ACK_TIMEOUT_MS = 5000;

// chrome.alarms minimum period is 30 s (MV3); 20 s from the brief gets
// clamped by Chrome anyway, so use 30 s directly.
const KEEPALIVE_PERIOD_MIN = 0.5;

// Demand-only debugger: every chrome.debugger.attach re-shows Chrome's
// "Hermes Extension started debugging this browser" banner, so the debugger
// is attached ONLY while the hub is actually driving the browser. When no
// agent command (cdp/tabs/status) arrives for this long, release the
// debugger — the banner disappears until the next tool call re-attaches.
const IDLE_DETACH_MS = 3 * 60 * 1000;
// "Driving" window for the sidepanel UI: hub commands this recent mean the
// agent is actively working (chip pulse / session card text).
const DRIVING_WINDOW_MS = 10 * 1000;

function detectBrowserName() {
  // userAgentData.brands[0] is often the low-entropy placeholder
  // "Not=A?Brand" — scan for the real brand instead.
  const brands = navigator.userAgentData?.brands;
  if (brands) {
    for (const b of brands) {
      const name = (b.brand || '').toLowerCase();
      if (name.includes('chrome')) return 'Chrome';
      if (name.includes('edge') || name.includes('edg')) return 'Edge';
      if (name.includes('chromium')) return 'Chromium';
    }
  }
  const ua = navigator.userAgent;
  if (/Edg\//i.test(ua)) return 'Edge';
  if (/Chrome\//i.test(ua)) return 'Chrome';
  return 'Chrome';
}

const BROWSER_NAME = detectBrowserName();

// chrome.debugger cannot attach to browser-internal pages (chrome://settings,
// edge://newtab, about:blank, chrome-extension://…, devtools://, view-source:…).
const INTERNAL_TAB_RE = /^(chrome|edge|about|chrome-extension|chrome-devtools|devtools|view-source|chrome-search):/i;

function isInternalTab(tab) {
  return INTERNAL_TAB_RE.test(tab?.url || '');
}

// ── WS client ────────────────────────────────────────────────────

let ws = null;
let wsRetry = 0;
let wsTimer = null;
let wsEnabled = true; // false after the user hits Disconnect (kill-switch)
let paired = false;   // true only after a successful hello-ack from the hub
let ackTimer = null;
// Last agent-driven hub command (cdp/tabs/status). Heartbeats and keep-alive
// pings do NOT count — they are exactly the "connected but nobody using it"
// case the idle release exists for.
let lastHubActivity = Date.now();

function wsSend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function scheduleReconnect() {
  clearTimeout(wsTimer);
  const delay = RECONNECT_BACKOFF[Math.min(wsRetry, RECONNECT_BACKOFF.length - 1)];
  wsRetry++;
  wsTimer = setTimeout(connectWs, delay);
}

function connectWs() {
  if (!wsEnabled) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return; // an existing socket is live — never double-connect
  }
  clearTimeout(wsTimer);
  try {
    ws = new WebSocket(WS_URL);
  } catch {
    scheduleReconnect();
    return;
  }
  ws.addEventListener('open', onWsOpen);
  ws.addEventListener('message', onWsMessage);
  ws.addEventListener('close', onWsClose);
  ws.addEventListener('error', () => {
    try { ws.close(); } catch {}
  });
}

async function onWsOpen() {
  wsRetry = 0;
  const { liveBrowserToken, rotatePairing } = await chrome.storage.local.get([
    'liveBrowserToken', 'rotatePairing',
  ]);
  const rotate = rotatePairing === true;
  let token = liveBrowserToken;
  if (!token || rotate) {
    // Reset pairing: mint a fresh token; rotate:true re-pins it on the hub.
    token = crypto.randomUUID();
    await chrome.storage.local.set({ liveBrowserToken: token });
  }
  if (rotate) await chrome.storage.local.remove('rotatePairing'); // one-shot
  wsSend({
    cmd: 'hello',
    token,
    extId: chrome.runtime.id,
    version: chrome.runtime.getManifest().version,
    browser: BROWSER_NAME,
    ...(rotate ? { rotate: true } : {}),
  });
  // Nothing counts until the hub answers. A missing/garbage ack means the
  // peer is NOT browser-mcp.py (gateway shadow, stale server) — close and
  // let the backoff retry the real hub.
  clearTimeout(ackTimer);
  ackTimer = setTimeout(() => {
    try { ws?.close(); } catch {}
  }, ACK_TIMEOUT_MS);
}

function onWsClose() {
  paired = false;
  clearTimeout(ackTimer);
  ws = null;
  broadcastBrowserState();
  scheduleReconnect();
}

async function onWsMessage(e) {
  let msg;
  try { msg = JSON.parse(e.data); } catch { return; }
  if (msg.cmd === 'hello-ack') {
    clearTimeout(ackTimer);
    if (msg.ok === true) {
      paired = true;
      broadcastBrowserState();
      // Demand-only debugger: NO attach here. Pairing is transport, not
      // agent activity — attaching now would flash the debugging banner
      // with nobody driving. The hub attaches a tab on the first tool call.
    } else {
      try { ws.close(); } catch {} // hub said no — back off and retry
    }
    return;
  }
  if (msg.cmd === 'ping') { wsSend({ cmd: 'pong' }); return; }
  if (msg.cmd === 'cdp' || msg.cmd === 'tabs' || msg.cmd === 'status') {
    const wasDriving = Date.now() - lastHubActivity < DRIVING_WINDOW_MS;
    lastHubActivity = Date.now(); // agent activity — push the idle release back
    if (!wasDriving) broadcastBrowserState(); // idle→driving edge: refresh the chip
  }
  if (msg.cmd === 'cdp') await handleCdp(msg);
  else if (msg.cmd === 'status') await handleStatus(msg);
  else if (msg.cmd === 'tabs') await handleTabs(msg);
}

// ── Debugger relay ───────────────────────────────────────────────

function getAttachedTabId() {
  return chrome.storage.local.get('attachedTabId').then(
    (s) => (s.attachedTabId != null ? s.attachedTabId : null)
  );
}

async function handleCdp(msg) {
  const attachedTabId = await getAttachedTabId();
  if (msg.tabId !== attachedTabId) {
    return wsSend({ id: msg.id, ok: false, error: 'TAB_NOT_ATTACHED' });
  }
  try {
    const result = await chrome.debugger.sendCommand(
      { tabId: msg.tabId }, msg.method, msg.params || {}
    );
    wsSend({ id: msg.id, ok: true, result });
  } catch (err) {
    wsSend({ id: msg.id, ok: false, error: String(err?.message || err) });
  }
}

async function handleStatus(msg) {
  const state = await getBrowserState();
  wsSend({ id: msg.id, ok: true, result: state });
}

// B2: browser_tabs tool backing — list/activate/close/new/attach/detach.
function tabInfo(t) {
  return { id: t.id, title: t.title, url: t.url, active: Boolean(t.active), incognito: Boolean(t.incognito) };
}

async function findTabByHint(msg) {
  const tabs = await chrome.tabs.query({});
  if (msg.tabId) {
    const hit = tabs.find((t) => t.id === msg.tabId);
    return hit || null;
  }
  const urlNeedle = String(msg.url || '').toLowerCase();
  const titleNeedle = String(msg.title || '').toLowerCase();
  if (!urlNeedle && !titleNeedle) return null;
  return tabs.find((t) => {
    const url = String(t.url || '').toLowerCase();
    const title = String(t.title || '').toLowerCase();
    if (urlNeedle && url.includes(urlNeedle)) return true;
    if (titleNeedle && title.includes(titleNeedle)) return true;
    return false;
  }) || null;
}

async function resolveTabForAttach(msg) {
  // Explicit id / url / title first; otherwise the focused tab (agent default).
  const hinted = await findTabByHint(msg);
  if (hinted) return hinted;
  if (msg.tabId || msg.url || msg.title) return null; // hint given but missed
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!active) return null;
  if (!isInternalTab(active)) return active;
  // Active tab is internal (undebuggable) — fall back to the first
  // non-internal tab in the window; if all are internal, return the active
  // tab anyway so the caller surfaces a clean attach error.
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const nonInternal = tabs.filter((t) => !isInternalTab(t));
  if (nonInternal.length > 0) {
    return nonInternal.find((t) => !t.active) || nonInternal[0];
  }
  return active;
}

async function handleTabs(msg) {
  try {
    if (msg.action === 'list') {
      const tabs = await chrome.tabs.query({});
      const attachedTabId = await getAttachedTabId();
      wsSend({
        id: msg.id,
        ok: true,
        result: {
          tabs: tabs.map(tabInfo),
          attachedTabId,
        },
      });
    } else if (msg.action === 'attach') {
      const tab = await resolveTabForAttach(msg);
      if (!tab) {
        return wsSend({ id: msg.id, ok: false, error: 'TAB_NOT_FOUND' });
      }
      const res = await attachTab(tab.id);
      if (!res.ok) {
        return wsSend({ id: msg.id, ok: false, error: res.error || 'ATTACH_FAILED', message: res.message });
      }
      wsSend({ id: msg.id, ok: true, result: { attached: true, tab: res.tab || tabInfo(tab) } });
    } else if (msg.action === 'detach') {
      const current = await getAttachedTabId();
      const tabId = msg.tabId || current;
      if (tabId == null) {
        return wsSend({ id: msg.id, ok: true, result: { attached: false, tab: null } });
      }
      await detachTab(tabId);
      wsSend({ id: msg.id, ok: true, result: { attached: false, tab: null } });
    } else if (msg.action === 'activate') {
      // Focus the tab AND attach the debugger before replying — otherwise the
      // agent's next CDP call races auto-attach and gets TAB_NOT_ATTACHED.
      const tab = await resolveTabForAttach(msg);
      if (!tab) {
        return wsSend({ id: msg.id, ok: false, error: 'TAB_NOT_FOUND' });
      }
      const focused = await chrome.tabs.update(tab.id, { active: true });
      if (focused?.windowId != null) {
        await chrome.windows.update(focused.windowId, { focused: true }).catch(() => {});
      }
      const res = await attachTab(tab.id);
      if (!res.ok) {
        return wsSend({
          id: msg.id,
          ok: false,
          error: res.error || 'ATTACH_FAILED',
          message: res.message,
        });
      }
      wsSend({
        id: msg.id,
        ok: true,
        result: { tab: res.tab || tabInfo(focused || tab), attached: true },
      });
    } else if (msg.action === 'close') {
      await chrome.tabs.remove(msg.tabId);
      wsSend({ id: msg.id, ok: true, result: {} });
    } else if (msg.action === 'new') {
      const tab = await chrome.tabs.create({ url: msg.url || 'about:blank' });
      // New tab: attach immediately so navigate/snapshot work without a second call.
      const res = await attachTab(tab.id);
      if (!res.ok) {
        return wsSend({
          id: msg.id,
          ok: false,
          error: res.error || 'ATTACH_FAILED',
          message: res.message,
        });
      }
      wsSend({ id: msg.id, ok: true, result: { tab: res.tab || tabInfo(tab), attached: true } });
    } else {
      wsSend({ id: msg.id, ok: false, error: 'unknown tabs action' });
    }
  } catch (err) {
    wsSend({ id: msg.id, ok: false, error: String(err?.message || err) });
  }
}

// Current truth: the storage-attached tab, verified live against
// chrome.debugger targets (survives SW restarts).
function activityInfo() {
  // For the sidepanel's agent-session card: when the agent last acted, and
  // whether it's inside the "driving" window right now.
  return {
    lastActivity: lastHubActivity,
    driving: Date.now() - lastHubActivity < DRIVING_WINDOW_MS,
  };
}

async function getBrowserState() {
  const attachedTabId = await getAttachedTabId();
  if (attachedTabId == null) {
    return { attached: false, tab: null, debugger: 'none', browser: BROWSER_NAME, ...activityInfo() };
  }
  try {
    const targets = await chrome.debugger.getTargets();
    if (!targets.some((t) => t.tabId === attachedTabId && t.attached)) {
      return { attached: false, tab: null, debugger: 'none', browser: BROWSER_NAME, ...activityInfo() };
    }
    const tab = await chrome.tabs.get(attachedTabId);
    return {
      attached: true,
      tab: { id: tab.id, title: tab.title, url: tab.url, incognito: Boolean(tab.incognito) },
      debugger: 'attached',
      browser: BROWSER_NAME,
      ...activityInfo(),
    };
  } catch {
    return { attached: false, tab: null, debugger: 'none', browser: BROWSER_NAME, ...activityInfo() };
  }
}

async function broadcastBrowserState() {
  const state = await getBrowserState();
  chrome.runtime.sendMessage({
    type: 'browser-state',
    ws: paired ? 'connected' : 'down', // ack-gated: connected only when the hub paired us
    ...state,
  }).catch(() => {});
}

// ── Attach / detach ──────────────────────────────────────────────

async function attachTab(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab && isInternalTab(tab)) {
    return {
      ok: false,
      error: 'TAB_INTERNAL',
      message: 'chrome.debugger cannot attach to browser-internal pages (chrome://, edge://, about: etc.)',
    };
  }
  const previous = await getAttachedTabId();
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (err) {
    const message = String(err?.message || err);
    if (/another debugger is already attached/i.test(message)) {
      return { ok: false, error: TAB_BUSY_MSG, message };
    }
    return { ok: false, error: message };
  }
  if (previous != null && previous !== tabId) {
    // Free the previous session now that the new one is live (best-effort).
    // Attach-first ordering: a TAB_BUSY on the new tab leaves the old
    // session attached instead of overwriting the storage id.
    try { await chrome.debugger.detach({ tabId: previous }); } catch {}
  }
  let info = null;
  try {
    const tab = await chrome.tabs.get(tabId);
    info = { id: tab.id, title: tab.title, url: tab.url, incognito: Boolean(tab.incognito) };
  } catch {}
  await chrome.storage.local.set({ attachedTabId: tabId });
  // B2: tell the hub the attach landed so it can reset refs/buffers and
  // enable CDP domains for the new tab.
  wsSend({ cmd: 'attach', tabId, tab: info || { id: tabId } });
  updateKeepAlive();
  broadcastBrowserState();
  return { ok: true, tab: info };
}

async function detachTab(tabId) {
  try { await chrome.debugger.detach({ tabId }); } catch {}
  await clearAttached(tabId);
  updateKeepAlive();
  broadcastBrowserState();
  return { ok: true };
}

async function clearAttached(tabId) {
  const current = await getAttachedTabId();
  if (tabId == null || current === tabId) {
    await chrome.storage.local.set({ attachedTabId: null });
  }
}

// ── Auto-follow: REMOVED (demand-only debugger) ──────────────────
// The old behavior attached the debugger on pairing and on every tab
// switch / page load so the hub always drove the focused tab. That
// re-showed Chrome's "started debugging this browser" banner with zero
// agent activity (and re-attached right after the user clicked Cancel).
// Now the debugger attaches ONLY when the hub asks (a tool call) or the
// user clicks Attach in the sidepanel — and auto-detaches when idle
// (see the keep-alive alarm below).

// chrome.debugger events are forwarded to the hub (consumed from B2 on:
// epoch invalidation, console/network buffers). Keyed by the ACTIVE tab:
// leaked or non-active sessions must not reach the hub (their events would
// poison the epoch/ref logic).
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId == null) return; // non-tab targets only
  getAttachedTabId().then((attachedTabId) => {
    if (attachedTabId === source.tabId) {
      wsSend({ cmd: 'event', method, params, tabId: source.tabId });
    }
  });
});

chrome.debugger.onDetach.addListener(async (source, reason) => {
  if (source.tabId == null) return;
  await clearAttached(source.tabId);
  updateKeepAlive();
  wsSend({ cmd: 'detach', tabId: source.tabId, reason });
  broadcastBrowserState();
});

// ── Keep-alive + idle release ────────────────────────────────────

// The SW dies after ~30 s idle; an attached-but-quiet tab produces no CDP
// events, so a chrome.alarms tick (min 30 s) keeps it alive and pings the
// hub. Only armed while at least one tab is attached. The same tick also
// enforces the idle release: no hub command for IDLE_DETACH_MS → detach
// the debugger (banner gone; the hub re-attaches on the next tool call).
async function updateKeepAlive() {
  const tabId = await getAttachedTabId();
  if (tabId != null) {
    await chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_PERIOD_MIN });
  } else {
    await chrome.alarms.clear(KEEPALIVE_ALARM);
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  if (Date.now() - lastHubActivity >= IDLE_DETACH_MS) {
    const tabId = await getAttachedTabId();
    if (tabId == null) return;
    console.log('idle release: no hub command for %ss — detaching debugger from tab %s',
      IDLE_DETACH_MS / 1000, tabId);
    await detachTab(tabId);
    // detachTab doesn't notify the hub (the hub-side tabs detach clears its
    // own state from the reply) — extension-initiated detaches must say so.
    wsSend({ cmd: 'detach', tabId, reason: 'idle' });
    return;
  }
  wsSend({ cmd: 'ping' });
});

// ── sidepanel messaging ──────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('browser-')) {
    return false;
  }
  if (msg.type === 'browser-attach') {
    attachTab(msg.tabId).then(sendResponse);
    return true;
  }
  if (msg.type === 'browser-detach') {
    detachTab(msg.tabId).then(sendResponse);
    return true;
  }
  if (msg.type === 'browser-disconnect') {
    disconnectAll().then(sendResponse);
    return true;
  }
  if (msg.type === 'browser-connect') {
    wsEnabled = true;
    connectWs();
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'browser-reset-pairing') {
    resetPairing().then(sendResponse);
    return true;
  }
  if (msg.type === 'browser-get-state') {
    getBrowserState().then(async (state) => {
      sendResponse({
        type: 'browser-state',
        ws: paired ? 'connected' : 'down',
        ...state,
      });
    });
    return true;
  }
  return false;
});

async function disconnectAll() {
  // Kill-switch: close the WS, detach EVERY debugger session, pause
  // auto-reconnect until the user reconnects from the sidepanel.
  wsEnabled = false;
  clearTimeout(wsTimer);
  try { ws?.close(); } catch {}
  ws = null;
  try {
    const targets = await chrome.debugger.getTargets();
    for (const t of targets) {
      if (t.tabId != null && t.attached) {
        try { await chrome.debugger.detach({ tabId: t.tabId }); } catch {}
      }
    }
  } catch {}
  await chrome.storage.local.set({ attachedTabId: null });
  await chrome.alarms.clear(KEEPALIVE_ALARM);
  broadcastBrowserState();
  return { ok: true };
}

async function resetPairing() {
  // Recovery from a 4401 lockout (e.g. wiped storage or a second profile):
  // set the one-shot rotate flag and drop the stored token — the next
  // hello sends a fresh token with rotate:true and the hub re-pins this
  // browser's slot. Reconnect immediately.
  wsEnabled = true;
  await chrome.storage.local.set({ rotatePairing: true });
  await chrome.storage.local.remove('liveBrowserToken');
  clearTimeout(wsTimer);
  try { ws?.close(); } catch {}
  ws = null;
  connectWs();
  return { ok: true };
}

// ── Boot ─────────────────────────────────────────────────────────

async function boot() {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {});
  connectWs();
  await updateKeepAlive(); // re-arm after an SW restart with a tab attached
  if ((await getAttachedTabId()) != null) broadcastBrowserState();
}

boot();
