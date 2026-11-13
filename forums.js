// Forum translation groups: the same forum in four languages.
//
// Which forums belong together is server data, not code (channel IDs stay out
// of the public repo), so it lives in data/forums.json:
//
//   { "groups": {
//       "suggestions": { "kind": "user",  "kr": "<forumId>", "en": "...", "jp": "...", "cn": "..." },
//       "devnotes":    { "kind": "notes", "kr": "...", ... } } }
//
// kind "user":  posts and comments by members, translated with the chat model.
// kind "notes": posts by staff (translated with the quality model), comments by
//               members (chat model).
//
// A post in one forum gets a mirrored post in the other three. The link
// between them (a "thread group") must outlive restarts and the 24 h relay
// store, so it is kept in SQLite (data/threads.db).

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const LANGS = ['kr', 'en', 'jp', 'cn'];
const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'forums.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

let GROUPS = {};
const FORUM_BY_ID = new Map(); // forumId -> { group, lang, kind }
// Staff text channels in four languages (announcements, roadmap, rules):
// "channels": { "announce": { "kr": "...", "en": "...", "jp": "...", "cn": "..." } }
// A staff post in one is translated (quality model) into the other three.
let STAFF = {};
const STAFF_BY_ID = new Map(); // channelId -> { group, lang }
// Moderation log layout: "logs": { "all": "<unified log>", "kr": "...", ... }
// and community manager roles: "cmRoles": { "kr": "<roleId>", ... }.
let LOGS = {};
let CM_ROLES = {};
let STAFF_CFG = {}; // "staff": { "draft": "<draft channel id>" }

function loadConfig() {
  GROUPS = {};
  FORUM_BY_ID.clear();
  STAFF = {};
  STAFF_BY_ID.clear();
  LOGS = {};
  CM_ROLES = {};
  STAFF_CFG = {};
  if (!fs.existsSync(CONFIG_PATH)) {
    console.log('forums: data/forums.json not found — forum translation off');
    return;
  }
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  for (const [group, g] of Object.entries(raw.groups || {})) {
    const kind = g.kind === 'notes' ? 'notes' : 'user';
    const forums = {};
    for (const lang of LANGS) {
      const id = String(g[lang] || '').trim();
      if (!id) throw new Error(`forums.json: group ${group} is missing ${lang}`);
      forums[lang] = id;
      FORUM_BY_ID.set(id, { group, lang, kind });
    }
    GROUPS[group] = { kind, forums };
  }
  for (const [group, g] of Object.entries(raw.channels || {})) {
    const chans = {};
    for (const lang of LANGS) {
      const id = String(g[lang] || '').trim();
      if (!id) throw new Error(`forums.json: channel group ${group} is missing ${lang}`);
      chans[lang] = id;
      STAFF_BY_ID.set(id, { group, lang });
    }
    STAFF[group] = chans;
  }
  LOGS = { ...(raw.logs || {}) };
  CM_ROLES = { ...(raw.cmRoles || {}) };
  STAFF_CFG = { ...(raw.staff || {}) };
  console.log(`forums: ${Object.keys(GROUPS).length} forum groups, ${Object.keys(STAFF).length} staff channel groups loaded`);
}
loadConfig();

const db = new Database(path.join(DATA_DIR, 'threads.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS thread_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    grp TEXT NOT NULL,
    origin_lang TEXT NOT NULL,
    kr TEXT, en TEXT, jp TEXT, cn TEXT,
    created INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_tg_kr ON thread_groups(kr);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_tg_en ON thread_groups(en);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_tg_jp ON thread_groups(jp);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_tg_cn ON thread_groups(cn);
`);
const stmtFind = db.prepare(
  'SELECT * FROM thread_groups WHERE kr = @id OR en = @id OR jp = @id OR cn = @id'
);
const stmtInsert = db.prepare(
  'INSERT INTO thread_groups (grp, origin_lang, kr, en, jp, cn, created) VALUES (@grp, @origin_lang, @kr, @en, @jp, @cn, @created)'
);
const stmtDelete = db.prepare('DELETE FROM thread_groups WHERE id = ?');

// Forum info for a forum channel id, or null.
function forumInfo(forumId) {
  return FORUM_BY_ID.get(forumId) || null;
}

// Staff channel route for a channel id: { group, lang, targets: [{lang, id}] } or null.
function staffChannel(channelId) {
  const info = STAFF_BY_ID.get(channelId);
  if (!info) return null;
  const chans = STAFF[info.group];
  return {
    ...info,
    targets: LANGS.filter((l) => l !== info.lang).map((lang) => ({ lang, id: chans[lang] })),
  };
}

// Language of any relayed channel id (chat, staff channel, grouped forum or
// a thread inside one). Needs the client only for threads.
async function langOfChannel(client, channelId) {
  if (!channelId) return null;
  const { LANG_BY_CHANNEL_ID } = require('./config');
  if (LANG_BY_CHANNEL_ID[channelId]) return LANG_BY_CHANNEL_ID[channelId];
  const st = STAFF_BY_ID.get(channelId);
  if (st) return st.lang;
  const f = FORUM_BY_ID.get(channelId);
  if (f) return f.lang;
  try {
    const ch = await client.channels.fetch(channelId);
    if (ch?.isThread?.()) return FORUM_BY_ID.get(ch.parentId)?.lang || null;
  } catch {}
  return null;
}

function logChannels() {
  return LOGS;
}

// Language whose community managers may act on cards in this channel.
function langOfLogChannel(channelId) {
  return LANGS.find((l) => LOGS[l] === channelId) || null;
}

function cmRole(lang) {
  return CM_ROLES[lang] || null;
}

function staffConfig() {
  return STAFF_CFG;
}

// The four channel ids of a staff channel group (announce, roadmap, rules).
function staffChannelIds(group) {
  return STAFF[group] || null;
}

// Thread group row for any of its four thread ids, or null.
function findThreadGroup(threadId) {
  return stmtFind.get({ id: threadId }) || null;
}

function saveThreadGroup({ group, originLang, threads }) {
  stmtInsert.run({
    grp: group,
    origin_lang: originLang,
    kr: threads.kr || null,
    en: threads.en || null,
    jp: threads.jp || null,
    cn: threads.cn || null,
    created: Date.now(),
  });
}

function deleteThreadGroup(row) {
  stmtDelete.run(row.id);
}

// Language of a thread inside a group row.
function langOfThread(row, threadId) {
  return LANGS.find((l) => row[l] === threadId) || null;
}

module.exports = {
  LANGS,
  GROUPS: () => GROUPS,
  forumInfo,
  staffChannel,
  langOfChannel,
  logChannels,
  langOfLogChannel,
  cmRole,
  staffConfig,
  staffChannelIds,
  findThreadGroup,
  saveThreadGroup,
  deleteThreadGroup,
  langOfThread,
  reload: loadConfig,
};
