// Norm-setting campaign messages.
//
// Triggered by message VOLUME rather than a clock: a reminder posted into a
// dead channel is just noise, whereas one posted while people are actually
// talking is read. A minimum interval still applies as a floor, otherwise a
// burst of activity would fire several in a row.
//
// The messages carry real weight for the rage-baiting problem: telling people
// up front that firing back gets them sanctioned too is the cheapest way to
// stop the pattern where the provoker walks and whoever took the bait is
// punished. Prevention beats adjudication here.
//
// campaigns.json is hot-reloaded (same idiom as rules.json / glossary.json) so
// copy can be tuned without a redeploy.

const fs = require('fs');
const path = require('path');

const { MODERATION, LANG_BY_CHANNEL_ID } = require('./config');

const CFG = MODERATION.campaign;
const CAMPAIGNS_PATH = path.join(__dirname, 'campaigns.json');

let MESSAGES = [];

function load() {
  try {
    if (!fs.existsSync(CAMPAIGNS_PATH)) {
      MESSAGES = [];
      return;
    }
    const parsed = JSON.parse(fs.readFileSync(CAMPAIGNS_PATH, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('campaigns.json must be an array');
    MESSAGES = parsed.filter((m) => m && typeof m.id === 'string');
    console.log(`campaign: loaded ${MESSAGES.length} message(s)`);
  } catch (err) {
    console.error('campaign: load failed —', err?.message || err);
    // keep the previous good copy rather than going silent
  }
}

load();

try {
  let pending = null;
  const watcher = fs.watch(path.dirname(CAMPAIGNS_PATH), (_e, filename) => {
    if (filename !== 'campaigns.json') return;
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      load();
    }, 200);
  });
  watcher.unref?.();
} catch {
  // fs.watch unsupported here — hot-reload disabled, load() already ran
}

// channelId -> { count, lastTs, index }
const state = new Map();

function stateFor(channelId) {
  let s = state.get(channelId);
  if (!s) {
    s = { count: 0, lastTs: 0, index: 0 };
    state.set(channelId, s);
  }
  return s;
}

// Called when a moderation notice or cooldown nudge was just posted, so a
// campaign line does not stack on top of it.
function markNotice(channelId) {
  const s = stateFor(channelId);
  s.lastNoticeTs = Date.now();
}

// Count a human message; returns the campaign entry to post, or null.
function observe(channelId) {
  if (!CFG.enabled || MESSAGES.length === 0) return null;
  if (!LANG_BY_CHANNEL_ID[channelId]) return null;

  const s = stateFor(channelId);
  s.count++;
  if (s.count < CFG.everyMessages) return null;

  const now = Date.now();
  // Floor on frequency: a burst must not fire several reminders back to back.
  if (now - s.lastTs < CFG.minIntervalMin * 60 * 1000) return null;
  // Don't pile onto a warning or a cooldown nudge that just went out.
  if (s.lastNoticeTs && now - s.lastNoticeTs < CFG.quietAfterNoticeMin * 60 * 1000) {
    return null;
  }

  s.count = 0;
  s.lastTs = now;
  const entry = MESSAGES[s.index % MESSAGES.length];
  s.index = (s.index + 1) % MESSAGES.length; // rotate so it does not nag
  return entry;
}

async function post(client, channelId, entry) {
  const lang = LANG_BY_CHANNEL_ID[channelId] || 'kr';
  const content = entry[lang] || entry.kr;
  if (!content) return;
  try {
    const channel = await client.channels.fetch(channelId);
    await channel.send({ content, allowedMentions: { parse: [] } });
  } catch (err) {
    console.error('campaign: post failed —', err?.message || err);
  }
}

function size() {
  return MESSAGES.length;
}

module.exports = {
  observe,
  post,
  markNotice,
  size,
  _reload: load,
};
