const test = require('node:test');
const assert = require('node:assert');

process.env.DEEPSEEK_API_KEY ||= 'test-key';
process.env.DISCORD_CHANNEL_KR_ID ||= '1';
process.env.DISCORD_CHANNEL_EN_ID ||= '2';
process.env.DISCORD_CHANNEL_JP_ID ||= '3';
process.env.DISCORD_CHANNEL_CN_ID ||= '4';

const { normalizeTranslatedText } = require('../text');
const { splitForDiscord } = require('../relay');

test('chat translations keep the 3-line cap', () => {
  assert.strictEqual(normalizeTranslatedText('a\n\nb\nc\nd'), 'a\nb\nc');
});

test('multi-line posts keep paragraph breaks and all lines', () => {
  const src = 'one\n\ntwo\nthree\n\nfour';
  const out = normalizeTranslatedText(src, { maxLines: 8, keepBlank: true });
  assert.strictEqual(out, src);
});

test('long text splits at paragraph boundaries under the Discord limit', () => {
  const para = 'x'.repeat(900);
  const text = [para, para, para].join('\n\n');
  const parts = splitForDiscord(text);
  assert.strictEqual(parts.length, 2);
  assert.ok(parts.every((p) => p.length <= 1990));
  assert.strictEqual(parts.join('\n\n'), text);
});

test('a single very long line is cut into pieces', () => {
  const parts = splitForDiscord('y'.repeat(4500));
  assert.ok(parts.length >= 3);
  assert.ok(parts.every((p) => p.length <= 1990));
  assert.strictEqual(parts.join(''), 'y'.repeat(4500));
});

test('short text is one part', () => {
  assert.deepStrictEqual(splitForDiscord('hi'), ['hi']);
});
