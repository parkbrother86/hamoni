// Twin links between moderation cards (unified log <-> language log), kept in
// SQLite so closing a card still closes its twin after a restart.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'cards.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS card_twins (
    message_id TEXT PRIMARY KEY,
    twin_channel_id TEXT NOT NULL,
    twin_message_id TEXT NOT NULL,
    twin_lang TEXT NOT NULL,
    created INTEGER NOT NULL
  );
`);
const stmtSet = db.prepare(
  'INSERT OR REPLACE INTO card_twins VALUES (@message_id, @twin_channel_id, @twin_message_id, @twin_lang, @created)'
);
const stmtGet = db.prepare('SELECT * FROM card_twins WHERE message_id = ?');

module.exports = {
  set: (row) => stmtSet.run({ ...row, created: Date.now() }),
  get: (messageId) => stmtGet.get(messageId) || null,
};
