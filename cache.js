const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const MEM_MAX = 100_000;
const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'translation_cache.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS cache (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    ts INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_cache_ts ON cache(ts);
`);

const stmtGet = db.prepare('SELECT value, ts FROM cache WHERE key = ?');
const stmtSet = db.prepare(
  'INSERT OR REPLACE INTO cache (key, value, ts) VALUES (?, ?, ?)'
);
const stmtPrune = db.prepare('DELETE FROM cache WHERE ts < ?');
const stmtCount = db.prepare('SELECT COUNT(*) AS n FROM cache');

const memCache = new Map();

function memGet(key) {
  const entry = memCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.t > TTL_MS) {
    memCache.delete(key);
    return null;
  }
  memCache.delete(key);
  memCache.set(key, entry);
  return entry.v;
}

function memSet(key, value, ts) {
  if (memCache.size >= MEM_MAX) {
    const oldest = memCache.keys().next().value;
    if (oldest !== undefined) memCache.delete(oldest);
  }
  memCache.set(key, { v: value, t: ts });
}

function normalize(text) {
  return text.trim().replace(/\s+/g, ' ');
}

function buildKey(text, sourceLang, targetLang) {
  return `${sourceLang}|${targetLang}|${normalize(text)}`;
}

function get(text, sourceLang, targetLang) {
  const key = buildKey(text, sourceLang, targetLang);

  const memHit = memGet(key);
  if (memHit !== null) return memHit;

  const row = stmtGet.get(key);
  if (row && Date.now() - row.ts <= TTL_MS) {
    memSet(key, row.value, row.ts);
    return row.value;
  }
  return null;
}

function set(text, sourceLang, targetLang, value) {
  const key = buildKey(text, sourceLang, targetLang);
  const now = Date.now();
  memSet(key, value, now);
  stmtSet.run(key, value, now);
}

function pruneExpired() {
  const cutoff = Date.now() - TTL_MS;
  const { changes } = stmtPrune.run(cutoff);
  return changes;
}

function size() {
  return {
    mem: memCache.size,
    disk: stmtCount.get().n,
  };
}

const initialPruned = pruneExpired();
if (initialPruned > 0) {
  console.log(`cache: pruned ${initialPruned} expired entries on startup`);
}

const pruneTimer = setInterval(() => {
  try {
    const n = pruneExpired();
    if (n > 0) console.log(`cache: pruned ${n} expired entries`);
  } catch (err) {
    console.error('cache prune failed', err?.message || err);
  }
}, PRUNE_INTERVAL_MS);
pruneTimer.unref();

module.exports = {
  get,
  set,
  size,
  pruneExpired,
  normalize,
  _db: db,
};
