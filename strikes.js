// Per-user moderation strike ledger, persisted to data/strikes.json.
//
// data/ is gitignored (runtime data), so strike history is private and never
// committed. Strikes survive restarts (unlike the in-memory relay store), which
// matters because timeouts escalate with cumulative count.
//
// Escalation ladder (see config.MODERATION.strike):
//   strike 1..(start-1) : delete + public warning, no timeout
//   strike >= start     : delete + timeout of (count - start + 1)^2 hours
//   With start = 2: 2 -> 1h, 3 -> 4h, 4 -> 9h, 5 -> 16h, 6 -> 25h, ...
//   Squared rather than linear: +1h per strike was too shallow to register on a
//   repeat offender, who could rack up violations for weeks before the ladder
//   reached a duration they noticed.

const fs = require('fs');
const path = require('path');

const { MODERATION } = require('./config');

const STRIKES_PATH = path.join(__dirname, 'data', 'strikes.json');
const MAX_HISTORY = 50; // cap per-user history to keep the file bounded
// Discord refuses a timeout longer than 28 days, and a refused call applies
// NOTHING — not a shorter timeout. The squared ladder runs past this on its own,
// so it is clamped here rather than left to fail at the API. Same bound the
// manual-timeout modal enforces (modactions.js).
const MAX_TIMEOUT_HOURS = 672; // 28 days

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
  const step = count - start + 1;
  return Math.min(step * step, MAX_TIMEOUT_HOURS);
}

module.exports = {
  MAX_TIMEOUT_HOURS,
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
