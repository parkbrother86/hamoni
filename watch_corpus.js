// Real-time tail of the translation corpus log.
//
// Shows the last N entries, then keeps watching for new ones and prints them
// as they arrive (tail -f style). Read-only — safe to run alongside the bot.
//
// Usage:
//   node watch_corpus.js              # last 100, poll every 1s
//   node watch_corpus.js 50           # last 50
//   node watch_corpus.js 100 500      # last 100, poll every 500ms
//   node watch_corpus.js --src kr     # filter to source_lang = kr
//
// Stop with Ctrl+C.

const path = require('path');
const Database = require('better-sqlite3');

const args = process.argv.slice(2);
let limit = 100;
let intervalMs = 1000;
let filterSrc = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--src') {
    filterSrc = args[++i];
  } else if (/^\d+$/.test(a)) {
    if (limit === 100 && intervalMs === 1000 && i === 0) limit = Number(a);
    else intervalMs = Number(a);
  }
}

const DB_PATH = path.join(__dirname, 'data', 'translation_cache.db');
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

// Flag mapping for visual differentiation
const FLAG = { kr: 'KR', en: 'EN', jp: 'JP', cn: 'CN' };

function pad(n, w) {
  return String(n).padStart(w, '0');
}

function fmtTime(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}:${pad(d.getSeconds(), 2)}`;
}

function printRow(r) {
  console.log(`\n[${fmtTime(r.ts)}] #${r.id}  [${FLAG[r.source_lang]}] ${r.source_text}`);
  const langs = ['kr', 'en', 'jp', 'cn'];
  for (const lang of langs) {
    if (lang === r.source_lang) continue;
    const v = r[lang];
    if (!v) continue;
    console.log(`           → [${FLAG[lang]}] ${v}`);
  }
}

// Initial backfill: last N entries (oldest first so the stream feels natural)
const baseWhere = filterSrc ? 'WHERE source_lang = ?' : '';
const params = filterSrc ? [filterSrc, limit] : [limit];
const initial = db.prepare(`
  SELECT id, ts, source_channel_id, source_lang, source_text, kr, en, jp, cn
  FROM translation_log
  ${baseWhere}
  ORDER BY id DESC
  LIMIT ?
`).all(...params);

initial.reverse();
let lastId = 0;
for (const r of initial) {
  printRow(r);
  if (r.id > lastId) lastId = r.id;
}

const filterDesc = filterSrc ? ` (filter: src=${filterSrc})` : '';
console.log(
  `\n${'─'.repeat(70)}\n` +
  `Showed last ${initial.length} entries${filterDesc}. ` +
  `Watching for new... (poll every ${intervalMs}ms, Ctrl+C to stop)\n` +
  `${'─'.repeat(70)}`
);

const tailParams = filterSrc ? [filterSrc] : [];
const tailWhere = filterSrc ? 'AND source_lang = ?' : '';
const tailStmt = db.prepare(`
  SELECT id, ts, source_channel_id, source_lang, source_text, kr, en, jp, cn
  FROM translation_log
  WHERE id > ? ${tailWhere}
  ORDER BY id ASC
`);

setInterval(() => {
  try {
    const newRows = tailStmt.all(lastId, ...tailParams);
    for (const r of newRows) {
      printRow(r);
      lastId = r.id;
    }
  } catch (err) {
    console.error('poll failed:', err?.message || err);
  }
}, intervalMs);
