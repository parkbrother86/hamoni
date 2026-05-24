const STORE_MAX = 1000;
const STORE_TTL_MS = 24 * 60 * 60 * 1000;

const store = new Map();

function key(channelId, messageId) {
  return `${channelId}:${messageId}`;
}

function ensureCapacity() {
  while (store.size >= STORE_MAX) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

function getEntry(channelId, messageId) {
  const k = key(channelId, messageId);
  const entry = store.get(k);
  if (!entry) return null;
  if (Date.now() - entry.t > STORE_TTL_MS) {
    store.delete(k);
    return null;
  }
  return entry;
}

function recordRelay({
  sourceChannelId,
  sourceMessageId,
  targetChannelId,
  webhookMessageId,
  snippet,
}) {
  const k = key(sourceChannelId, sourceMessageId);
  let entry = store.get(k);
  if (!entry) {
    ensureCapacity();
    entry = { t: Date.now(), relays: [] };
    store.set(k, entry);
  }
  entry.relays.push({
    targetChannelId,
    webhookMessageId,
    snippet,
  });
}

function getRelays(sourceChannelId, sourceMessageId) {
  const entry = getEntry(sourceChannelId, sourceMessageId);
  return entry ? entry.relays : [];
}

function removeRelays(sourceChannelId, sourceMessageId) {
  store.delete(key(sourceChannelId, sourceMessageId));
}

module.exports = {
  recordRelay,
  getRelays,
  removeRelays,
};
