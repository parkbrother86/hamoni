// Real-time tail of the translation corpus log.
//
// Two ways to run:
//
// 1) Ad-hoc viewing (interactive, when you want to look):
//      node watch_corpus.js              # last 100 + live stream
//      node watch_corpus.js 50           # last 50
//      node watch_corpus.js --src kr     # filter source_lang = kr
//
// 2) Daemon mode (24/7 background via PM2, attach when you want):
//      pm2 start watch_corpus.js --name hamoni-watcher -- --backfill 0
//      pm2 save
//      pm2 logs hamoni-watcher --lines 30      # attach to live stream
//      # Ctrl+C in pm2 logs → detach (watcher keeps running)
//      pm2 stop hamoni-watcher                 # actually stop watcher
//
// Read-only — safe to run alongside the bot. SQLite WAL handles concurrency.

const path = require('path');
const Database = require('better-sqlite3');

const argv = process.argv.slice(2);
let backfill = 100;
let intervalMs = 1000;
let filterSrc = null;

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--src') {
    filterSrc = argv[++i];
  } else if (a === '--backfill') {
    backfill = Number(argv[++i]);
  } else if (a === '--interval') {
    intervalMs = Number(argv[++i]);
  } else if (/^\d+$/.test(a)) {
    // Backward-compatible positional: first number = backfill, second = interval
    if (i === 0) backfill = Number(a);
    else intervalMs = Number(a);
  }
}

if (!Number.isFinite(backfill) || backfill < 0) backfill = 100;
if (!Number.isFinite(intervalMs) || intervalMs < 100) intervalMs = 1000;

const DB_PATH = path.join(__dirname, 'data', 'translation_cache.db');
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

const FLAG = { kr: 'KR', en: 'EN', jp: 'JP', cn: 'CN' };

function pad(n, w) { return String(n).padStart(w, '0'); }
function fmtTime(ts) {
  const d = new Date(ts);
  return `${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)} ${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}:${pad(d.getSeconds(), 2)}`;
}

function printRow(r) {
  console.log(`\n[${fmtTime(r.ts)}] #${r.id}  [${FLAG[r.source_lang]}] ${r.source_text}`);
  for (const lang of ['kr', 'en', 'jp', 'cn']) {
    if (lang === r.source_lang) continue;
    const v = r[lang];
    if (!v) continue;
    console.log(`                          → [${FLAG[lang]}] ${v}`);
  }
}

// Backfill (optional): show last N rows so the viewer has context.
let lastId = 0;

if (backfill > 0) {
  const baseWhere = filterSrc ? 'WHERE source_lang = ?' : '';
  const params = filterSrc ? [filterSrc, backfill] : [backfill];
  const initial = db.prepare(`
    SELECT id, ts, source_channel_id, source_lang, source_text, kr, en, jp, cn
    FROM translation_log
    ${baseWhere}
    ORDER BY id DESC
    LIMIT ?
  `).all(...params);

  initial.reverse();
  for (const r of initial) {
    printRow(r);
    if (r.id > lastId) lastId = r.id;
  }

  const filterDesc = filterSrc ? ` (src=${filterSrc})` : '';
  console.log(
    `\n${'─'.repeat(72)}\n` +
    `Backfilled ${initial.length} entries${filterDesc}. Watching for new... ` +
    `(poll ${intervalMs}ms, Ctrl+C to stop)\n` +
    `${'─'.repeat(72)}`
  );
} else {
  // Daemon mode — skip backfill. Find the current max id so we don't replay
  // history when the watcher is restarted.
  const maxRow = db.prepare('SELECT MAX(id) AS m FROM translation_log').get();
  lastId = maxRow?.m || 0;
  const filterDesc = filterSrc ? ` (src=${filterSrc})` : '';
  console.log(
    `[watch_corpus] daemon mode${filterDesc} — starting from id ${lastId} ` +
    `(poll ${intervalMs}ms)`
  );
}

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
    console.error('[watch_corpus] poll failed:', err?.message || err);
  }
}, intervalMs);

// Graceful exit so PM2 can stop the process cleanly.
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
