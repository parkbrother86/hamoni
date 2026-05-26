// Translation corpus logger.
//
// For each user message, after fan-out completes, store one row containing the
// source + all four-language translations side-by-side. This is a multilingual
// parallel corpus that accumulates over time — useful for offline analysis,
// frequency stats, and future fine-tuning.
//
// Storage: same SQLite DB as the cache (data/translation_cache.db), separate
// table `translation_log`. Cache reuses the existing handle (cache._db).
//
// Privacy: only channel_id is stored, NOT user_id. Source text is verbatim.
// No TTL — this is research data, not a cache.

const cache = require('./cache');
const db = cache._db;

db.exec(`
  CREATE TABLE IF NOT EXISTS translation_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    source_channel_id TEXT,
    source_lang TEXT NOT NULL,
    source_text TEXT NOT NULL,
    kr TEXT,
    en TEXT,
    jp TEXT,
    cn TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_log_ts ON translation_log(ts);
  CREATE INDEX IF NOT EXISTS idx_log_source_lang ON translation_log(source_lang);
  CREATE INDEX IF NOT EXISTS idx_log_source_text ON translation_log(source_text);
`);

const stmtInsert = db.prepare(`
  INSERT INTO translation_log
    (ts, source_channel_id, source_lang, source_text, kr, en, jp, cn)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const stmtCount = db.prepare('SELECT COUNT(*) AS n FROM translation_log');

function record({ sourceChannelId, sourceLang, sourceText, translations }) {
  try {
    // translations is { en: "...", jp: "...", cn: "..." } (no source lang itself).
    // We fill source lang column with the original text so each row is a
    // complete 4-way parallel sentence.
    const all = { ...translations, [sourceLang]: sourceText };
    stmtInsert.run(
      Date.now(),
      sourceChannelId || null,
      sourceLang,
      sourceText,
      all.kr || null,
      all.en || null,
      all.jp || null,
      all.cn || null
    );
  } catch (err) {
    // Logging must NEVER break the relay. Just warn and move on.
    console.error('corpus_log record failed', err?.message || err);
  }
}

function count() {
  return stmtCount.get().n;
}

module.exports = { record, count };
