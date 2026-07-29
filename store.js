const STORE_MAX = 1000;
const STORE_TTL_MS = 24 * 60 * 60 * 1000;
const TOMBSTONE_TTL_MS = 60 * 1000;

const store = new Map();
const tombstones = new Map();

// Reverse index: webhook (relayed copy) message id -> origin of the source
// message it was translated from. A report usually lands on a translated copy
// in a target channel, whose Discord author is the webhook — not the real user.
// This lets us recover the true source message and its actual author.
const reverse = new Map();

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

// Drop reverse-index entries for every relay under a store entry.
function purgeReverse(entry) {
  if (!entry?.relays) return;
  for (const r of entry.relays) reverse.delete(r.webhookMessageId);
}

function ensureCapacity() {
  while (store.size >= STORE_MAX) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    purgeReverse(store.get(oldest));
    store.delete(oldest);
  }
}

function getEntry(channelId, messageId) {
  const k = key(channelId, messageId);
  const entry = store.get(k);
  if (!entry) return null;
  if (Date.now() - entry.t > STORE_TTL_MS) {
    purgeReverse(entry);
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
  authorId,
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
  reverse.set(webhookMessageId, {
    sourceChannelId,
    sourceMessageId,
    authorId,
  });
}

// Resolve a relayed (webhook) message id back to its source message + author.
// Returns null if unknown (evicted, or from before a restart).
function resolveReverse(webhookMessageId) {
  return reverse.get(webhookMessageId) || null;
}

function getRelays(sourceChannelId, sourceMessageId) {
  const entry = getEntry(sourceChannelId, sourceMessageId);
  return entry ? entry.relays : [];
}

function removeRelays(sourceChannelId, sourceMessageId) {
  const k = key(sourceChannelId, sourceMessageId);
  purgeReverse(store.get(k));
  store.delete(k);
}

module.exports = {
  recordRelay,
  getRelays,
  removeRelays,
  resolveReverse,
  markDeleted,
  wasDeleted,
};
