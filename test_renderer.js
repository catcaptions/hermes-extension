/**
 * Renderer unit tests (node, no frameworks).
 * Run: node test_renderer.js
 * Covers CRITIQUE.md findings #1, #2, #3, #10, #16, #19 as pinned behavior.
 */
'use strict';

const assert = require('node:assert');
const { extractTokens, mediaUrl, fingerprint, fixAttributeSentinels } = require('./renderer.js');

let passed = 0;
const failures = [];

function t(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failures.push({ name, err });
  }
}

// ── media extraction ────────────────────────────────────────────

t('media: uppercase IMAGE: windows path is extracted', () => {
  const src = 'Here it is:\nIMAGE:C:\\Users\\lasis\\AppData\\Roaming\\Hermes\\composer-images\\composer_2026-08-08_13-29-39-364_50bb75.png\nDone.';
  const { scrubbed, media } = extractTokens(src);
  assert.strictEqual(media.length, 1);
  assert.strictEqual(media[0], 'C:\\Users\\lasis\\AppData\\Roaming\\Hermes\\composer-images\\composer_2026-08-08_13-29-39-364_50bb75.png');
  assert.ok(!scrubbed.includes('IMAGE:'));
  assert.match(scrubbed, /⟦HIMG:[0-9a-f]+:0⟧/);
});

t('media: all case variants image:/IMAGE:/MEDIA:/media:/Media:', () => { // critique #2
  for (const prefix of ['image:', 'IMAGE:', 'MEDIA:', 'media:', 'Media:']) {
    const { media } = extractTokens(`${prefix}C:\\tmp\\a.png`);
    assert.strictEqual(media.length, 1, `prefix ${prefix}`);
    assert.strictEqual(media[0], 'C:\\tmp\\a.png', `prefix ${prefix}`);
  }
});

t('media: posix absolute path', () => {
  const { media } = extractTokens('MEDIA:/home/u/.hermes/cache/a.png');
  assert.strictEqual(media.length, 1);
  assert.strictEqual(media[0], '/home/u/.hermes/cache/a.png');
});

t('media: path with spaces is taken verbatim', () => {
  const { media } = extractTokens('IMAGE:C:\\Program Files\\x\\my image.png');
  assert.strictEqual(media.length, 1);
  assert.strictEqual(media[0], 'C:\\Program Files\\x\\my image.png');
});

t('media: not inside fenced code', () => { // requirement #5 / critique #3
  const src = '```\nIMAGE:C:\\x\\y.png\n```';
  const { media, scrubbed } = extractTokens(src);
  assert.strictEqual(media.length, 0);
  assert.ok(scrubbed.includes('IMAGE:C:\\x\\y.png'));
});

t('media: not inside 4-space indented code block', () => { // critique #3
  const src = 'Some intro\n\n    IMAGE:C:\\x\\y.png\n\nAfter';
  const { media } = extractTokens(src);
  assert.strictEqual(media.length, 0);
});

t('media: math inside indented code stays literal too', () => { // critique #3
  const src = '\n\n    $x$ and $$y$$\n';
  const { math } = extractTokens(src);
  assert.strictEqual(math.length, 0);
});

t('media: blockquote/list-prefixed lines stay literal (pinned)', () => { // critique #10
  for (const src of ['> IMAGE:C:\\x\\y.png', '- IMAGE:C:\\x\\y.png', '1. IMAGE:C:\\x\\y.png']) {
    const { media } = extractTokens(src);
    assert.strictEqual(media.length, 0, src);
  }
});

t('media: 4-space line after a list item is a continuation, not code (GFM)', () => {
  const { media } = extractTokens('- item\n    IMAGE:C:\\x\\y.png');
  assert.strictEqual(media.length, 1);
});

t('media: blank line before 4-space line makes it an indented code block', () => {
  const { media } = extractTokens('Para\n\n    IMAGE:C:\\x\\y.png\n');
  assert.strictEqual(media.length, 0);
});

t('media: empty value is not extracted', () => {
  const { media } = extractTokens('IMAGE:\n');
  assert.strictEqual(media.length, 0);
});

t('media: wins over math on the same line (pinned)', () => { // critique #19
  const { media, math } = extractTokens('IMAGE:C:\\$$x$$.png');
  assert.strictEqual(media.length, 1);
  assert.strictEqual(math.length, 0);
});

// ── inline math ─────────────────────────────────────────────────

t('math: simple inline $x$', () => {
  const { math } = extractTokens('Solve $x$ now');
  assert.strictEqual(math.length, 1);
  assert.strictEqual(math[0].tex, 'x');
  assert.strictEqual(math[0].display, false);
});

t('math: multi-char inline with spaces inside', () => {
  const { math } = extractTokens('$e^{i\\pi} + 1 = 0$');
  assert.strictEqual(math.length, 1);
  assert.strictEqual(math[0].display, false);
});

t('math: escaped dollar does not open a span', () => { // critique #1
  const { scrubbed, math } = extractTokens('price \\$5 and $x$');
  assert.strictEqual(math.length, 1);
  assert.strictEqual(math[0].tex, 'x');
  assert.ok(scrubbed.includes('\\$5'));
});

t('math: "$5 and $10" is not math (money)', () => { // critique #1
  const { math, scrubbed } = extractTokens('$5 and $10');
  assert.strictEqual(math.length, 0);
  assert.ok(scrubbed.includes('$5 and $10'));
});

t('math: no whitespace adjacent to the $ delimiters', () => { // critique #1
  for (const src of ['$ x$', '$x $', '$ x $', '$ $']) {
    const { math } = extractTokens(src);
    assert.strictEqual(math.length, 0, src);
  }
});

t('math: escaped dollar inside content', () => {
  const { math } = extractTokens('$a\\$b$');
  assert.strictEqual(math.length, 1);
  assert.strictEqual(math[0].tex, 'a\\$b');
});

t('math: \\(...\\) inline form', () => {
  const { math } = extractTokens('Inline \\(e^{i\\pi}\\) done');
  assert.strictEqual(math.length, 1);
  assert.ok(math[0].tex.includes('e^{i\\pi}'));
  assert.strictEqual(math[0].display, false);
});

t('math: unclosed $ stays literal', () => {
  const { math, scrubbed } = extractTokens('cost $5');
  assert.strictEqual(math.length, 0);
  assert.ok(scrubbed.includes('cost $5'));
});

t('math: known limitation - inline code spans are not protected (pinned)', () => {
  const { math } = extractTokens('use `$x$` here');
  assert.strictEqual(math.length, 1);
});

// ── block / display math ────────────────────────────────────────

t('math: display $$...$$ single line', () => {
  const { math } = extractTokens('$$\\int_0^1 x dx$$');
  assert.strictEqual(math.length, 1);
  assert.ok(math[0].display);
});

t('math: display $$...$$ multiline', () => {
  const src = '$$\n\\int_0^1 x\\,dx = \\frac{1}{2}\n$$';
  const { math } = extractTokens(src);
  assert.strictEqual(math.length, 1);
  assert.ok(math[0].display);
  assert.ok(math[0].tex.includes('\\frac{1}{2}'));
});

t('math: \\[...\\] block form, multiline', () => {
  const { math } = extractTokens('\\[\nE = mc^2\n\\]');
  assert.strictEqual(math.length, 1);
  assert.ok(math[0].display);
});

t('math: mid-line $$...$$ renders as display math (pinned)', () => { // critique #16
  const { math, scrubbed } = extractTokens('text $$x$$ text');
  assert.strictEqual(math.length, 1);
  assert.ok(math[0].display);
  assert.ok(!scrubbed.includes('$$'));
});

t('math: two separate blocks on one line', () => {
  const { math } = extractTokens('$$a$$ and $$b$$');
  assert.strictEqual(math.length, 2);
  assert.ok(math.every((m) => m.display));
});

t('math: unclosed $$ stays literal', () => {
  const { math } = extractTokens('$$\n\\int_0^1 x dx\n');
  assert.strictEqual(math.length, 0);
});

t('math: display does not swallow inline math on the same line (BUG-2)', () => {
  const { math, scrubbed } = extractTokens('text $$a$$ and $b$ here');
  assert.strictEqual(math.length, 2);
  assert.strictEqual(math[0].tex, 'a');
  assert.ok(math[0].display);
  assert.strictEqual(math[1].tex, 'b');
  assert.ok(!math[1].display);
  assert.ok(!scrubbed.includes('$b$'));
});

t('math: inline before display on the same line (BUG-2)', () => {
  const { math } = extractTokens('$x$ and $$y$$');
  assert.strictEqual(math.length, 2);
  assert.ok(math[0].display); // block pass runs first
  assert.strictEqual(math[0].tex, 'y');
  assert.strictEqual(math[1].tex, 'x');
  assert.ok(!math[1].display);
});

t('math: back-to-back $$ and $ on one line (BUG-2)', () => {
  const { math } = extractTokens('$$a$$$b$');
  assert.strictEqual(math.length, 2);
  assert.strictEqual(math[0].tex, 'a');
  assert.strictEqual(math[1].tex, 'b');
});

t('math: not inside fenced code', () => {
  const { math, scrubbed } = extractTokens('```\n$x$\n$$y$$\n```');
  assert.strictEqual(math.length, 0);
  assert.ok(scrubbed.includes('$$y$$'));
});

// ── sentinel round trip / ordering ──────────────────────────────

t('extractTokens: sentinel indices align with arrays', () => {
  const src = 'A $x$ and\nIMAGE:C:\\a.png\nand $$y$$\n$z$';
  const { scrubbed, math, media, nonce } = extractTokens(src);
  assert.strictEqual(math.length, 3);
  assert.strictEqual(media.length, 1);
  assert.strictEqual(math[1].tex, 'x');     // inline after block, in order
  assert.strictEqual(math[2].tex, 'z');
  assert.strictEqual(media[0], 'C:\\a.png');
  assert.ok(scrubbed.includes(`⟦HIMG:${nonce}:0⟧`));
  assert.ok(scrubbed.includes(`⟦HMTH:${nonce}:0⟧`));
  assert.ok(scrubbed.includes(`⟦HMTH:${nonce}:1⟧`));
  assert.ok(scrubbed.includes(`⟦HMTH:${nonce}:2⟧`));
  assert.ok(!scrubbed.includes('$z$'));
  assert.ok(scrubbed.includes('A ') && scrubbed.includes(' and') && scrubbed.includes('and '));
});

t('extractTokens: empty input', () => {
  const { scrubbed, math, media } = extractTokens('');
  assert.strictEqual(scrubbed, '');
  assert.deepStrictEqual(math, []);
  assert.deepStrictEqual(media, []);
});

// ── mediaUrl ────────────────────────────────────────────────────

t('mediaUrl: windows drive path', () => {
  assert.strictEqual(mediaUrl('C:\\Users\\a b\\c.png'), 'file:///C:/Users/a%20b/c.png');
});

t('mediaUrl: lowercase windows drive', () => {
  assert.strictEqual(mediaUrl('c:\\x\\y.png'), 'file:///c:/x/y.png');
});

t('mediaUrl: posix absolute', () => {
  assert.strictEqual(mediaUrl('/home/u/x.png'), 'file:///home/u/x.png');
});

t('mediaUrl: http(s) unchanged', () => {
  assert.strictEqual(mediaUrl('https://e.com/a.png'), 'https://e.com/a.png');
  assert.strictEqual(mediaUrl('http://e.com/a.png'), 'http://e.com/a.png');
});

t('mediaUrl: hash in filename is encoded', () => {
  assert.strictEqual(mediaUrl('C:\\x\\a#b.png'), 'file:///C:/x/a%23b.png');
});

t('mediaUrl: spaces and parens encoded', () => {
  assert.strictEqual(mediaUrl('/x/y (1).png'), 'file:///x/y%20(1).png');
});

t('mediaUrl: garbage is null', () => {
  assert.strictEqual(mediaUrl('foobar'), null);
  assert.strictEqual(mediaUrl(''), null);
  assert.strictEqual(mediaUrl('  '), null);
});

// ── attribute sentinel exemption (BUG-3) ─────────────────────────

t('attr: math in link destination becomes percent-encoded TeX, not HTML', () => {
  const math = [{ tex: 'x^2', display: false }];
  const out = fixAttributeSentinels('<p><a href="⟦HMTH:abc:0⟧">go</a></p>', 'abc', math);
  assert.strictEqual(out, '<p><a href="x%5E2">go</a></p>');
});

t('attr: alt and title attributes are exempted too', () => {
  const math = [{ tex: 'a_b', display: false }];
  const out = fixAttributeSentinels('<img src="u.png" alt="⟦HMTH:abc:0⟧" title="⟦HMTH:abc:0⟧">', 'abc', math);
  assert.strictEqual(out, '<img src="u.png" alt="a_b" title="a_b">');
});

t('attr: text-node sentinels are left for the generic replacement', () => {
  const math = [{ tex: 'x', display: false }];
  const out = fixAttributeSentinels('<p>⟦HMTH:abc:0⟧</p>', 'abc', math);
  assert.strictEqual(out, '<p>⟦HMTH:abc:0⟧</p>');
});

t('attr: no sentinels is a no-op; media sentinels untouched', () => {
  const out = fixAttributeSentinels('<p>⟦HIMG:abc:0⟧</p>', 'abc', []);
  assert.strictEqual(out, '<p>⟦HIMG:abc:0⟧</p>');
});

// ── fingerprint ─────────────────────────────────────────────────

t('fingerprint: stable and sensitive', () => {
  const a = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }];
  assert.strictEqual(fingerprint(a), fingerprint(a));
  assert.notStrictEqual(fingerprint(a), fingerprint([a[0]]));
  assert.notStrictEqual(fingerprint(a), fingerprint([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo!' }]));
});

t('fingerprint: ignores display-only flags', () => {
  const base = [{ role: 'user', content: 'hi' }];
  const withFlag = [{ role: 'user', content: 'hi', streaming: true }];
  assert.strictEqual(fingerprint(base), fingerprint(withFlag));
});

// ── summary ─────────────────────────────────────────────────────

if (failures.length) {
  for (const { name, err } of failures) {
    console.error(`FAIL: ${name}\n  ${err.message}`);
  }
  console.error(`\n${failures.length} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`ALL PASS (${passed})`);
