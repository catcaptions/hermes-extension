/**
 * Renderer unit tests (node, no frameworks).
 * Run: node test_renderer.js
 * Covers CRITIQUE.md findings #1, #2, #3, #10, #16, #19 as pinned behavior.
 */
'use strict';

const assert = require('node:assert');
const marked = require('./vendor/marked.min.js');
const { extractTokens, mediaUrl, mediaKind, fingerprint, fixAttributeSentinels } = require('./renderer.js');

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

// ── @image: / @media: desktop attachments (IMAGE_DIAGNOSIS #1) ───

t('media: @image: prefix is extracted (desktop attachment)', () => {
  const src = '@image:C:\\Users\\lasis\\AppData\\Roaming\\Hermes\\composer-images\\a.png';
  const { media, scrubbed } = extractTokens(src);
  assert.strictEqual(media.length, 1);
  assert.strictEqual(media[0], 'C:\\Users\\lasis\\AppData\\Roaming\\Hermes\\composer-images\\a.png');
  assert.ok(!scrubbed.includes('@image:'));
  assert.match(scrubbed, /⟦HIMG:[0-9a-f]+:0⟧/);
});

t('media: @media: prefix is extracted', () => {
  const { media } = extractTokens('@media:C:\\x\\d.mp3');
  assert.strictEqual(media.length, 1);
  assert.strictEqual(media[0], 'C:\\x\\d.mp3');
});

t('media: mixed text around @image: line', () => {
  const src = 'text\n@image:C:\\x\\e.png\ntext';
  const { media } = extractTokens(src);
  assert.strictEqual(media.length, 1);
});

t('media: @image: inside fenced code is NOT extracted (guard preserved)', () => {
  const src = '```\n@image:C:\\x\\y.png\n```';
  const { media, scrubbed } = extractTokens(src);
  assert.strictEqual(media.length, 0);
  assert.ok(scrubbed.includes('@image:C:\\x\\y.png'));
});

t('media: @image: with spaces in path → encoded file URL', () => {
  assert.strictEqual(mediaUrl('C:\\Users\\lasis\\My Folder\\pic.png'), 'file:///C:/Users/lasis/My%20Folder/pic.png');
});

t('media: mediaKind routes extensions', () => {
  for (const f of ['a.png', 'a.jpg', 'a.jpeg', 'a.gif', 'a.webp', 'a.bmp', 'a.avif', 'a.svg', 'a.PNG']) {
    assert.strictEqual(mediaKind(f), 'img', f);
  }
  for (const f of ['a.mp3', 'a.ogg', 'a.wav', 'a.m4a', 'a.aac', 'a.flac', 'a.opus']) {
    assert.strictEqual(mediaKind(f), 'audio', f);
  }
  for (const f of ['a.mp4', 'a.webm', 'a.mov', 'a.mkv']) {
    assert.strictEqual(mediaKind(f), 'video', f);
  }
  assert.strictEqual(mediaKind('a.txt'), 'other');
  assert.strictEqual(mediaKind('a.png?x=1'), 'img');
  assert.strictEqual(mediaKind('noext'), 'other');
  assert.strictEqual(mediaKind(''), 'other');
});

// ── data: URL attachments (TASK_BRIEF_2 task 2) ─────────────────

t('media: @image:data: URL is extracted', () => {
  const src = '@image:data:image/png;base64,iVBORw0KGgo=';
  const { media, scrubbed } = extractTokens(src);
  assert.strictEqual(media.length, 1);
  assert.strictEqual(media[0], 'data:image/png;base64,iVBORw0KGgo=');
  assert.ok(!scrubbed.includes('@image:data:'));
});

t('media: @image:data: inside fenced code is NOT extracted', () => {
  const src = '```\n@image:data:image/png;base64,x\n```';
  const { media, scrubbed } = extractTokens(src);
  assert.strictEqual(media.length, 0);
  assert.ok(scrubbed.includes('@image:data:image/png;base64,x'));
});

t('mediaKind: data:image/* is img', () => {
  for (const u of ['data:image/png;base64,x', 'data:image/jpeg;base64,x', 'data:image/webp;base64,x', 'data:image/gif;base64,x']) {
    assert.strictEqual(mediaKind(u), 'img', u);
  }
});

t('mediaUrl: data:image passes through unchanged', () => {
  assert.strictEqual(mediaUrl('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
});

t('mediaUrl: non-image data: garbage stays null', () => {
  assert.strictEqual(mediaUrl('data:text/plain,hi'), null);
  assert.strictEqual(mediaUrl('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
});

// ── @url: link attachments (IMAGE_DIAGNOSIS #4) ─────────────────

t('url: backtick-quoted @url: becomes a sentinel', () => {
  const src = 'See @url:`https://canvasui.dev/` for details';
  const { url, scrubbed } = extractTokens(src);
  assert.strictEqual(url.length, 1);
  assert.strictEqual(url[0], 'https://canvasui.dev/');
  assert.ok(!scrubbed.includes('@url:'));
  assert.match(scrubbed, /⟦HURL:[0-9a-f]+:0⟧/);
});

t('url: bare @url: mid-sentence, trailing punctuation stripped', () => {
  const { url } = extractTokens('check @url:https://example.com/x. done');
  assert.strictEqual(url.length, 1);
  assert.strictEqual(url[0], 'https://example.com/x');
});

t('url: not inside fenced code', () => {
  const src = '```\n@url:https://example.com/x\n```';
  const { url, scrubbed } = extractTokens(src);
  assert.strictEqual(url.length, 0);
  assert.ok(scrubbed.includes('@url:https://example.com/x'));
});

t('url: dollars inside a URL are not read as math', () => {
  const { url, math } = extractTokens('@url:https://x.com/$a$');
  assert.strictEqual(url.length, 1);
  assert.strictEqual(url[0], 'https://x.com/$a$');
  assert.strictEqual(math.length, 0);
});

t('attr: url sentinel in link destination is percent-encoded (BUG-3 class)', () => {
  const out = fixAttributeSentinels('<p><a href="⟦HURL:abc:0⟧">go</a></p>', 'abc', [], ['https://x.com/a b']);
  assert.strictEqual(out, '<p><a href="https://x.com/a%20b">go</a></p>');
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

// ── blank-line structure (TASK_BRIEF_7) ──────────────────────────

t('blankline: hr marker is not merged into a setext heading (TASK_BRIEF_7)', () => {
  const src = "Here's the draft:\n\n---\n\nDear team,";
  const { scrubbed } = extractTokens(src);
  assert.strictEqual(scrubbed, "Here's the draft:\n\n---\n\nDear team,");
  assert.ok(!/\n[^\n]---\n/.test(scrubbed), 'no run/blank adjacency: --- must stay standalone');
});

t('blankline: hr marker renders as <hr>, not <h2> (TASK_BRIEF_7, marked)', () => {
  const { scrubbed } = extractTokens("Here's the draft:\n\n---\n\nDear team,");
  const html = marked.parse(scrubbed, { gfm: true, breaks: true });
  assert.ok(html.includes('<hr>'), 'horizontal rule rendered');
  assert.ok(!html.includes('<h2>'), 'no false setext heading');
});

t('blankline: paragraphs keep their blank-line separation (no merge)', () => {
  const { scrubbed } = extractTokens('para one\n\npara two');
  assert.strictEqual(scrubbed, 'para one\n\npara two');
  const html = marked.parse(scrubbed, { gfm: true, breaks: true });
  assert.ok(html.includes('<p>para one</p>\n<p>para two</p>'), 'two separate <p> blocks');
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
