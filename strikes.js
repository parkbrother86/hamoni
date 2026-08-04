// Per-user moderation strike ledger, persisted to data/strikes.json.
//
// data/ is gitignored (runtime data), so strike history is private and never
// committed. Strikes survive restarts (unlike the in-memory relay store), which
// matters because timeouts escalate with cumulative count.
//
// Escalation ladder (see config.MODERATION.strike):
//   strike 1..(start-1) : delete + public warning, no timeout
//   strike >= start     : delete + timeout of (count - start + 1) hours
//   With start = 3: 3 -> 1h, 4 -> 2h, 5 -> 3h, ... (+1h per additional strike).

const fs = require('fs');
const path = require('path');

const { MODERATION } = require('./config');

const STRIKES_PATH = path.join(__dirname, 'data', 'strikes.json');
const MAX_HISTORY = 50; // cap per-user history to keep the file bounded

let store = {};

function load() {
  try {
    if (fs.existsSync(STRIKES_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(STRIKES_PATH, 'utf8'));
      if (parsed && typeof parsed === 'object') store = parsed;
    }
  } catch (err) {
    console.error('strikes: load failed —', err?.message || err);
    store = {};
  }
}

function save() {
  try {
    const dir = path.dirname(STRIKES_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // temp + rename for atomic write (avoid a torn file on crash)
    const tmp = `${STRIKES_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
    fs.renameSync(tmp, STRIKES_PATH);
  } catch (err) {
    console.error('strikes: save failed —', err?.message || err);
  }
}

load();

function get(userId) {
  return store[userId]?.count || 0;
}

// Record a new upheld violation. Returns the new cumulative count.
function add(userId, { ruleId, messageId }) {
  let entry = store[userId];
  if (!entry) {
    entry = { count: 0, history: [] };
    store[userId] = entry;
  }
  entry.count += 1;
  entry.lastTs = Date.now();
  entry.history.push({ ruleId, messageId, ts: entry.lastTs });
  if (entry.history.length > MAX_HISTORY) {
    entry.history = entry.history.slice(-MAX_HISTORY);
  }
  save();
  return entry.count;
}

// Undo the most recent strike (false-positive recovery). Returns new count.
function decrement(userId) {
  const entry = store[userId];
  if (!entry || entry.count <= 0) return 0;
  entry.count -= 1;
  entry.history.pop();
  entry.lastTs = Date.now();
  save();
  return entry.count;
}

function getHistory(userId) {
  return store[userId]?.history ? store[userId].history.slice() : [];
}

// Full manual reset — clears count + history (admin forgiveness).
function reset(userId) {
  if (store[userId]) {
    delete store[userId];
    save();
  }
  return 0;
}

// Manually set the cumulative count (clamped >= 0), keeping history.
function set(userId, n) {
  const count = Math.max(0, Math.floor(Number(n) || 0));
  let entry = store[userId];
  if (!entry) {
    entry = { count: 0, history: [] };
    store[userId] = entry;
  }
  entry.count = count;
  entry.lastTs = Date.now();
  save();
  return count;
}

// Strikes that still count toward escalation: those inside the expiry window.
// History is never deleted — only the ladder ignores old entries, so a member
// is not held at the edge of a timeout forever by a strike from months ago.
function activeCount(userId) {
  const entry = store[userId];
  if (!entry) return 0;
  const days = MODERATION.strike.strikeExpiryDays;
  if (!days) return entry.count;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const recent = (entry.history || []).filter((h) => (h.ts || 0) >= cutoff).length;
  // Entries predating history tracking fall back to the raw count.
  return Math.min(entry.count, Math.max(recent, 0));
}

// Timeout duration in hours for a given (active) strike count.
function timeoutHours(count) {
  const start = MODERATION.strike.timeoutStartStrike;
  if (count < start) return 0;
  return count - start + 1;
}

module.exports = {
  get,
  add,
  decrement,
  reset,
  set,
  getHistory,
  activeCount,
  timeoutHours,
  _reload: load,
};
