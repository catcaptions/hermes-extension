// Hermes Minimal — MV3 service worker.
// 1) sidePanel behavior (toolbar click opens the panel).
// 2) Browser-use layer B1 (TASK_BRIEF_B1): WebSocket client for the local
//    browser-mcp.py hub (ws://127.0.0.1:8644) + chrome.debugger relay.
//    The extension connects OUT to the hub, pairs with a token, and tunnels
//    CDP commands to the USER'S real tabs. Protocol: see PROTOCOL.md.

const WS_URL = 'ws://127.0.0.1:8644';
const RECONNECT_BACKOFF = [1000, 2000, 4000, 8000, 16000]; // ms, then capped
const KEEPALIVE_ALARM = 'hermes-browser-keepalive';
const TAB_BUSY_MSG = 'TAB_BUSY';

// chrome.alarms minimum period is 30 s (MV3); 20 s from the brief gets
// clamped by Chrome anyway, so use 30 s directly.
const KEEPALIVE_PERIOD_MIN = 0.5;

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

// ── WS client ────────────────────────────────────────────────────

let ws = null;
let wsRetry = 0;
let wsTimer = null;
let wsEnabled = true; // false after the user hits Disconnect (kill-switch)

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
  const { liveBrowserToken } = await chrome.storage.local.get('liveBrowserToken');
  const token = liveBrowserToken || crypto.randomUUID();
  if (!liveBrowserToken) await chrome.storage.local.set({ liveBrowserToken: token });
  wsSend({
    cmd: 'hello',
    token,
    extId: chrome.runtime.id,
    version: chrome.runtime.getManifest().version,
    browser: BROWSER_NAME,
  });
  broadcastBrowserState();
  autoAttachToActiveTab('paired'); // follow the user's current tab automatically
}

function onWsClose() {
  ws = null;
  broadcastBrowserState();
  scheduleReconnect();
}

async function onWsMessage(e) {
  let msg;
  try { msg = JSON.parse(e.data); } catch { return; }
  if (msg.cmd === 'ping') { wsSend({ cmd: 'pong' }); return; }
  if (msg.cmd === 'cdp') await handleCdp(msg);
  else if (msg.cmd === 'status') await handleStatus(msg);
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

// Current truth: the storage-attached tab, verified live against
// chrome.debugger targets (survives SW restarts).
async function getBrowserState() {
  const attachedTabId = await getAttachedTabId();
  if (attachedTabId == null) {
    return { attached: false, tab: null, debugger: 'none', browser: BROWSER_NAME };
  }
  try {
    const targets = await chrome.debugger.getTargets();
    if (!targets.some((t) => t.tabId === attachedTabId && t.attached)) {
      return { attached: false, tab: null, debugger: 'none', browser: BROWSER_NAME };
    }
    const tab = await chrome.tabs.get(attachedTabId);
    return {
      attached: true,
      tab: { id: tab.id, title: tab.title, url: tab.url, incognito: Boolean(tab.incognito) },
      debugger: 'attached',
      browser: BROWSER_NAME,
    };
  } catch {
    return { attached: false, tab: null, debugger: 'none', browser: BROWSER_NAME };
  }
}

async function broadcastBrowserState() {
  const state = await getBrowserState();
  chrome.runtime.sendMessage({
    type: 'browser-state',
    ws: ws && ws.readyState === WebSocket.OPEN ? 'connected' : 'down',
    ...state,
  }).catch(() => {});
}

// ── Attach / detach ──────────────────────────────────────────────

async function attachTab(tabId) {
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (err) {
    const message = String(err?.message || err);
    if (/another debugger is already attached/i.test(message)) {
      return { ok: false, error: TAB_BUSY_MSG, message };
    }
    return { ok: false, error: message };
  }
  let info = null;
  try {
    const tab = await chrome.tabs.get(tabId);
    info = { id: tab.id, title: tab.title, url: tab.url, incognito: Boolean(tab.incognito) };
  } catch {}
  await chrome.storage.local.set({ attachedTabId: tabId, lastAttached: info });
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

// ── Auto-attach: follow the user's current tab ───────────────────
// After pairing, and on every tab switch, attach the debugger to the
// active tab so the hub always drives the tab the user is looking at.
async function autoAttachToActiveTab(reason) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return; // bridge down
  const current = await getAttachedTabId();
  let active = null;
  try {
    [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {}
  if (!active || active.id === current) return;
  const res = await attachTab(active.id);
  if (!res.ok) {
    // TAB_BUSY (DevTools open) is expected; retried on the next tab event.
    console.log(`auto-attach(${reason}): tab ${active.id} — ${res.error}`);
  }
}

chrome.tabs.onActivated.addListener(() => autoAttachToActiveTab('activated'));
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.status === 'complete') autoAttachToActiveTab('updated');
});

// chrome.debugger events are forwarded to the hub as-is (consumed from B2
// on: epoch invalidation, console/network buffers).
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId == null) return; // non-tab targets only
  wsSend({ cmd: 'event', method, params, tabId: source.tabId });
});

chrome.debugger.onDetach.addListener(async (source, reason) => {
  if (source.tabId == null) return;
  await clearAttached(source.tabId);
  updateKeepAlive();
  wsSend({ cmd: 'detach', tabId: source.tabId, reason });
  broadcastBrowserState();
});

// ── Keep-alive ───────────────────────────────────────────────────

// The SW dies after ~30 s idle; an attached-but-quiet tab produces no CDP
// events, so a chrome.alarms tick (min 30 s) keeps it alive and pings the
// hub. Only armed while at least one tab is attached.
async function updateKeepAlive() {
  const tabId = await getAttachedTabId();
  if (tabId != null) {
    await chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_PERIOD_MIN });
  } else {
    await chrome.alarms.clear(KEEPALIVE_ALARM);
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) wsSend({ cmd: 'ping' });
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
  if (msg.type === 'browser-get-state') {
    getBrowserState().then(async (state) => {
      sendResponse({
        type: 'browser-state',
        ws: ws && ws.readyState === WebSocket.OPEN ? 'connected' : 'down',
        ...state,
      });
    });
    return true;
  }
  return false;
});

async function disconnectAll() {
  // Kill-switch: close the WS, detach every debugger session, pause
  // auto-reconnect until the user reconnects from the sidepanel.
  wsEnabled = false;
  clearTimeout(wsTimer);
  try { ws?.close(); } catch {}
  ws = null;
  const tabId = await getAttachedTabId();
  if (tabId != null) await detachTab(tabId);
  await chrome.alarms.clear(KEEPALIVE_ALARM);
  broadcastBrowserState();
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
