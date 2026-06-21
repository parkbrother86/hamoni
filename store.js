const STORE_MAX = 1000;
const STORE_TTL_MS = 24 * 60 * 60 * 1000;
const TOMBSTONE_TTL_MS = 60 * 1000;

const store = new Map();
const tombstones = new Map();

function key(channelId, messageId) {
  return `${channelId}:${messageId}`;
}

function cleanTombstones(now) {
  for (const [k, t] of tombstones) {
    if (now - t > TOMBSTONE_TTL_MS) tombstones.delete(k);
  }
}

function markDeleted(channelId, messageId) {
  const now = Date.now();
  tombstones.set(key(channelId, messageId), now);
  cleanTombstones(now);
}

function wasDeleted(channelId, messageId) {
  const k = key(channelId, messageId);
  const t = tombstones.get(k);
  if (t === undefined) return false;
  if (Date.now() - t > TOMBSTONE_TTL_MS) {
    tombstones.delete(k);
    return false;
  }
  return true;
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
  markDeleted,
  wasDeleted,
};
