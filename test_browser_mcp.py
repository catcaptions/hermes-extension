#!/usr/bin/env python3
"""Unit tests for browser-mcp.py pure logic (no browser, no bridge needed).

Run:  py -3.14 -B test_browser_mcp.py
(-B / sys.dont_write_bytecode keep __pycache__/ out of the extension root —
Chrome/Edge refuse to load an unpacked extension containing it.)
"""
import importlib.util
import sys
from pathlib import Path

sys.dont_write_bytecode = True

_spec = importlib.util.spec_from_file_location(
    'browser_mcp', Path(__file__).with_name('browser-mcp.py'))
bm = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bm)

FAILURES = []


def check(name, cond, detail=''):
    if cond:
        print('ok   %s' % name)
    else:
        FAILURES.append(name)
        print('FAIL %s %s' % (name, detail))


# ── normalize_ref ─────────────────────────────────────────────────────────

check('ref plain', bm.normalize_ref('e5') == 'e5')
check('ref @', bm.normalize_ref('@e5') == 'e5')
check('ref []', bm.normalize_ref('[e5]') == 'e5')
check('ref case', bm.normalize_ref('E5') == 'e5')
check('ref padded', bm.normalize_ref('  e12 ') == 'e12')
check('selector passthrough', bm.normalize_ref('div#main') is None)
check('bare e is selector', bm.normalize_ref('e') is None)
check('email is selector', bm.normalize_ref('email') is None)
check('empty', bm.normalize_ref('') is None)


# ── compact_ax_tree ───────────────────────────────────────────────────────

def ax(node_id, parent, role, name='', bid=None, value=None, props=None):
    return {
        'nodeId': node_id, 'parentId': parent, 'backendDOMNodeId': bid,
        'role': {'type': 'role', 'value': role},
        'name': {'type': 'computedString', 'value': name},
        'value': {'type': 'string', 'value': value} if value is not None else None,
        'properties': [{'name': k, 'value': v} for k, v in (props or {}).items()],
    }


TREE = [
    ax(1, 0, 'WebArea', 'Example', bid=1),
    ax(2, 1, 'generic', bid=2),                      # structural container (kept)
    ax(3, 2, 'link', 'Pricing', bid=101),
    ax(4, 2, 'button', 'Sign in', bid=102, props={'focused': True}),
    ax(5, 4, 'StaticText', 'Sign in'),               # dropped (not interactive)
    ax(6, 1, 'generic', bid=6),                      # dropped (nothing kept below)
    ax(7, 1, 'heading', 'Hello', bid=7, props={'level': 2}),  # kept structural
    ax(8, 1, 'textbox', 'Email', bid=103, value='a@b.c'),
    ax(9, 1, 'checkbox', 'Subscribe', bid=104, props={'checked': True}),
]

lines, refs, truncated = bm.compact_ax_tree(TREE)
text = '\n'.join(lines)
check('no truncation by default', truncated is False)
check('interactive counted', len(refs) == 4, str(refs))
check('refs in tree order', list(refs) == ['e1', 'e2', 'e3', 'e4'], str(list(refs)))
check('ref bid mapping', refs['e1'] == 101 and refs['e2'] == 102)
check('link line', '- link "Pricing" [e1]' in text, text)
check('button + focused flag', '[focused=true]' in text)
check('textbox value', '= "a@b.c"' in text)
check('checkbox checked', '[checked=true]' in text)
check('static text dropped', 'StaticText' not in text)
check('empty generic dropped', len([l for l in lines if l.startswith('- generic')]) == 0)
check('structural container emitted for nesting', '- generic' not in text or
      any(l.startswith('- generic') and '  - ' in '\n'.join(lines) for l in lines))

lines2, refs2, trunc2 = bm.compact_ax_tree(TREE, max_items=1)
check('truncation flag', trunc2 is True)
check('truncation caps interactive items', len(refs2) == 1)

# Custom ref naming keeps refs stable across snapshots (same bid -> same ref).
seen = {}
def stable_name(bid):
    return seen.setdefault(bid, 'e%d' % (len(seen) + 1))
lines3, refs3, _ = bm.compact_ax_tree(TREE, ref_name=stable_name)
check('custom ref names', list(refs3.values()) == [101, 102, 103, 104])
check('stable names reused', seen[101] == 'e1')


# ── HubState ──────────────────────────────────────────────────────────────

hs = bm.HubState()
r1 = hs.add_ref(101)
r2 = hs.add_ref(102)
check('ref sequence', r1 == 'e1' and r2 == 'e2')
check('ref_for reuses', hs.ref_for(101) == 'e1')
check('ref_for mints', hs.ref_for(999) == 'e3')
check('get_ref', hs.get_ref('e2') == 102 and hs.get_ref('zz') is None)
hs.on_navigated()
check('nav clears refs', hs.get_ref('e1') is None)
hs.on_attach({'id': 42, 'title': 't', 'url': 'u'})
check('attach sets tab', hs.tab['id'] == 42)
hs.push_console('error', 'boom')
hs.push_console('info', 'hello')
check('console since_seq', [e['text'] for e in hs.since(hs.console, 0)] == ['boom', 'hello'])
check('console since_seq skips', [e['text'] for e in hs.since(hs.console, 1)] == ['hello'])
hs.note_request('r1', 'http://x/1')
hs.push_network(hs._req_urls.get('r1', ''), 200, 'text/html')
check('network buffer', hs.network[0]['url'] == 'http://x/1' and hs.network[0]['status'] == 200)
hs.on_detach()
check('detach clears', hs.tab is None and not hs.network and not hs.console)


# ── key events (unknown keys rejected before any CDP call) ────────────────

check('enter key mapped', bm.KEY_EVENTS['enter'] == ('Enter', 'Enter', 13))
try:
    bm._press_key_cdp('notakey')
    check('unknown key raises', False)
except bm.ToolError as e:
    check('unknown key raises', 'KEY_UNKNOWN' in str(e))
try:
    bm._press_key_cdp('')
    check('empty key raises', False)
except bm.ToolError:
    check('empty key raises', True)

# Printable char + named key: record the CDP calls via a stub.
calls = []
bm._cdp = lambda method, params=None, **kw: (calls.append((method, params)), {})[1]
bm._tab = lambda: {'id': 1}
bm._press_key_cdp('a')
down = [p for m, p in calls if p and p.get('type') == 'keyDown']
up = [p for m, p in calls if p and p.get('type') == 'keyUp']
check('char keydown text', down[0]['text'] == 'a' and down[0]['key'] == 'a')
check('char keyup', up[0]['key'] == 'a')
calls.clear()
bm._press_key_cdp('Enter')
check('enter vk', calls[0][1]['windowsVirtualKeyCode'] == 13 and
      calls[0][1]['key'] == 'Enter')


# ── password guard (structural, via stubbed CDP) ─────────────────────────

def fake_cdp(method, params=None, **kw):
    if method == 'DOM.pushNodesByBackendIdsToFrontend':
        return {'nodeIds': [params['backendNodeIds'][0] + 100]}
    if method == 'DOM.getAttributes':
        if params.get('nodeId') == 107:  # bid 7 -> password field
            return {'attributes': ['type', 'password']}
        return {'attributes': ['type', 'text', 'name', 'q']}
    return {}

bm._cdp = fake_cdp
check('password detected', bm._is_password_field(7) is True)
check('text field not password', bm._is_password_field(8) is False)
try:
    bm._guard_typing(7, '')
    check('guard blocks', False)
except bm.ToolError as e:
    check('guard blocks', 'SENSITIVE_ACTION' in str(e))
try:
    bm._guard_typing(7, 'user_approved')
    check('guard allows approved', True)
except bm.ToolError:
    check('guard allows approved', False)
try:
    bm._guard_typing(8, '')
    check('guard ignores non-password', True)
except bm.ToolError:
    check('guard ignores non-password', False)


# ── refresh_tab (A3) ──────────────────────────────────────────────────────

rt = bm.HubState()
rt.on_attach({'id': 7, 'title': 'old', 'url': 'http://old'})
rt.add_ref(101)
rt.push_console('info', 'keep')
rt.domains_done = True
rt.refresh_tab(url='http://new/page', title='T' * 1200)
check('refresh updates url', rt.tab['url'] == 'http://new/page')
check('refresh updates title', rt.tab['title'] == 'T' * 1000)
check('refresh keeps refs', rt.get_ref('e1') == 101)
check('refresh keeps console', len(rt.console) == 1)
check('refresh keeps domains', rt.domains_done is True)
rt2 = bm.HubState()
rt2.refresh_tab(url='http://x', title='t')
check('refresh no-op unattached', rt2.tab is None)


# ── A5: getDocument materializes before performSearch ─────────────────────

calls = []
def rec_cdp(method, params=None, **kw):
    calls.append(method)
    if method == 'DOM.performSearch':
        return {'resultCount': 1, 'searchId': 's1'}
    if method == 'DOM.getSearchResults':
        return {'nodeIds': [1]}
    if method == 'DOM.describeNode':
        return {'backendNodeId': 555}
    return {}

bm._cdp = rec_cdp
bm.hub_state = bm.HubState()
bid, ref = bm._resolve_target('#username')
check('css resolve returns bid', bid == 555)
check('getDocument before performSearch',
      calls.index('DOM.getDocument') < calls.index('DOM.performSearch'),
      str(calls))


# ── A1: callFunctionOn uses functionDeclaration ───────────────────────────

calls = []
def cfo_cdp(method, params=None, **kw):
    calls.append((method, params))
    if method == 'DOM.resolveNode':
        return {'object': {'objectId': 'obj1'}}
    return {'result': {'value': 'ok'}}

bm._cdp = cfo_cdp
res = bm._call_on_element(555, 'function() { return 1; }', [])
cfo = [p for m, p in calls if m == 'Runtime.callFunctionOn'][0]
check('callFunctionOn uses functionDeclaration', 'functionDeclaration' in cfo)
check('callFunctionOn no function key', 'function' not in cfo)
check('element call returns value', res == 'ok')


# ── parse_xy (coordinate targets) ──────────────────────────────────────────

check('xy plain', bm.parse_xy('350,120') == (350.0, 120.0))
check('xy floats', bm.parse_xy('-10.5, 0') == (-10.5, 0.0))
check('xy padded', bm.parse_xy(' 12 , 34 ') == (12.0, 34.0))
check('xy single number is not coords', bm.parse_xy('350') is None)
check('xy ref is not coords', bm.parse_xy('e5') is None)
check('xy selector is not coords', bm.parse_xy('div>a') is None)
check('xy empty', bm.parse_xy('') is None)
check('xy none', bm.parse_xy(None) is None)


# ── _scroll_deltas ─────────────────────────────────────────────────────────

check('deltas down', bm._scroll_deltas('down', 600) == (0, 600))
check('deltas up', bm._scroll_deltas('up', 300) == (0, -300))
check('deltas left', bm._scroll_deltas('left', 250) == (-250, 0))
check('deltas right', bm._scroll_deltas('right', 100) == (100, 0))
check('deltas case-insensitive', bm._scroll_deltas('DOWN', 50) == (0, 50))
try:
    bm._scroll_deltas('sideways', 100)
    check('deltas bad direction raises', False)
except bm.ToolError as e:
    check('deltas bad direction raises', 'BAD_DIRECTION' in str(e))


# ── key modifiers ──────────────────────────────────────────────────────────

calls = []
bm._cdp = lambda method, params=None, **kw: (calls.append((method, params)), {})[1]
bm._tab = lambda: {'id': 1}
bm._press_key_cdp('ctrl+a')
down = [p for m, p in calls if p and p.get('type') == 'keyDown'][0]
up = [p for m, p in calls if p and p.get('type') == 'keyUp'][0]
check('ctrl modifier bitmask', down['modifiers'] == 2 and up['modifiers'] == 2)
check('modified key has no text', down['text'] is None)
check('combo key resolved', down['key'] == 'a' and down['code'] == 'A')
calls.clear()
bm._press_key_cdp('shift+tab')
check('shift+tab bitmask', calls[0][1]['modifiers'] == 8 and
      calls[0][1]['key'] == 'Tab')
calls.clear()
bm._press_key_cdp('a')
check('plain char still types text', calls[0][1]['text'] == 'a' and
      'modifiers' not in calls[0][1])
try:
    bm._press_key_cdp('foo+bar')
    check('bad combo raises', False)
except bm.ToolError as e:
    check('bad combo raises', 'KEY_UNKNOWN' in str(e))


# ── browser_drag / browser_click / browser_scroll input sequences ─────────

def mouse_calls(record):
    return [(p.get('type'), p) for m, p in record if m == 'Input.dispatchMouseEvent']

# Drag by coordinates (no element resolution needed) — press, interpolated
# moves with the button held, release at the target.
calls = []
bm._cdp = lambda method, params=None, **kw: (calls.append((method, params)), {})[1]
bm._tab = lambda: {'id': 1}
bm.browser_drag('10,20', '110,220', steps=4)
mc = mouse_calls(calls)
types = [t for t, _ in mc]
check('drag starts with hover+press', types[0] == 'mouseMoved' and types[1] == 'mousePressed')
check('drag ends with release', types[-1] == 'mouseReleased')
check('drag press at source', mc[1][1]['x'] == 10 and mc[1][1]['y'] == 20)
check('drag release at target', mc[-1][1]['x'] == 110 and mc[-1][1]['y'] == 220)
held = [p for t, p in mc if t == 'mouseMoved' and p.get('buttons') == 1]
check('drag moves hold button', len(held) >= 3, str(len(held)))
check('drag moves interpolate', held[0]['x'] > 10 and held[-1]['x'] <= 110)

# Coordinate click — no element lookup, straight mouse at the point.
calls = []
bm._cdp = lambda method, params=None, **kw: (calls.append((method, params)), {})[1]
bm.browser_click('350,120')
mc = mouse_calls(calls)
check('coord click presses at point',
      mc[1][1]['x'] == 350 and mc[1][1]['y'] == 120 and mc[1][1]['type'] == 'mousePressed')

# Element scroll: target + direction -> mouseWheel at the element center.
calls = []
bm._cdp = lambda method, params=None, **kw: (calls.append((method, params)), {})[1]
bm._resolve_target = lambda t: (55, 'e1')
bm._box_center = lambda bid: (100, 200)
bm.browser_scroll('down', 300, target='e1')
wheels = [p for m, p in calls if p and p.get('type') == 'mouseWheel']
check('element scroll dispatches wheel', len(wheels) == 1)
check('wheel at element center', wheels[0]['x'] == 100 and wheels[0]['y'] == 200)
check('wheel delta sign/amount', wheels[0]['deltaX'] == 0 and wheels[0]['deltaY'] == 300)

# Page scroll default direction is still 'down'.
calls = []
bm._cdp = lambda method, params=None, **kw: (calls.append((method, params)), {})[1]
bm.browser_scroll()
evals = [p for m, p in calls if m == 'Runtime.evaluate']
check('page scroll default down', evals and 'window.scrollBy(0, 600)' in evals[0]['expression'])


print()
if FAILURES:
    print('FAILED: %d (%s)' % (len(FAILURES), ', '.join(FAILURES)))
    sys.exit(1)
print('ALL PASS')
