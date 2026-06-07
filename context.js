// Per-channel rolling buffer of recent source-language messages, used as
// reference context for translation. Read-only / backward-looking: a new
// message references prior lines, but already-relayed translations are never
// revised. One buffer per source channel; shared across all fan-out targets.

const MAX_ENTRIES = 6;
const MAX_AGE_MS = 10 * 60 * 1000;

const buffers = new Map();

function sanitizeLine(text) {
  return String(text || '')
    // Never let placeholder brackets leak into context — they are reserved
    // for the target message's mention/emoji round-trip only.
    .replace(/[⟪⟫]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

function sanitizeName(name) {
  const clean = String(name || '')
    .replace(/[⟪⟫]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
  return clean || 'user';
}

function push(channelId, name, text) {
  const line = sanitizeLine(text);
  if (!line) return;
  const arr = buffers.get(channelId) || [];
  arr.push({ name: sanitizeName(name), text: line, t: Date.now() });
  while (arr.length > MAX_ENTRIES) arr.shift();
  buffers.set(channelId, arr);
}

function recent(channelId) {
  const arr = buffers.get(channelId);
  if (!arr || arr.length === 0) return [];
  const cutoff = Date.now() - MAX_AGE_MS;
  return arr.filter((e) => e.t >= cutoff);
}

module.exports = {
  push,
  recent,
  sanitizeName,
  sanitizeLine,
};
