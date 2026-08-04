// Report accumulation (신고 누적).
//
// Deliberately separate from strikes.js — different file, different store, no
// path to automatic punishment. strikes = confirmed violations (what the user
// actually said). reportLoad = reports received (what others claim). The second
// is hearsay and is gameable by coordinated reporting, so it exists ONLY to
// surface a case to a human operator.
//
// Why it exists: rage-baiting is written to survive per-message judgment. Every
// individual line is defensible, so the judge clears it and no trace remains —
// while the person who takes the bait produces an overt violation and gets
// punished. Recording cleared verdicts too is what makes "three unrelated
// people independently reported this user" visible at all.
//
// Never: drive an automatic action, reach the judge's prompt, or be shown to
// anyone but operators.

const fs = require('fs');
const path = require('path');

const { MODERATION } = require('./config');

const CFG = MODERATION.reportLoad;
const STORE_PATH = path.join(__dirname, 'data', 'reportload.json');
const DAY_MS = 24 * 60 * 60 * 1000;

let store = {};

function load() {
  try {
    if (fs.existsSync(STORE_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
      if (parsed && typeof parsed === 'object') store = parsed;
    }
  } catch (err) {
    console.error('reportload: load failed —', err?.message || err);
    store = {};
  }
}

function save() {
  try {
    const dir = path.dirname(STORE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${STORE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
    fs.renameSync(tmp, STORE_PATH);
  } catch (err) {
    console.error('reportload: save failed —', err?.message || err);
  }
}

load();

function entryFor(userId) {
  let e = store[userId];
  if (!e) {
    e = { events: [], watch: false, ignoreUntil: 0 };
    store[userId] = e;
  }
  if (!Array.isArray(e.events)) e.events = [];
  return e;
}

function pruneOld(entry) {
  const cutoff = Date.now() - CFG.historyMaxDays * DAY_MS;
  const before = entry.events.length;
  entry.events = entry.events.filter((ev) => ev.ts >= cutoff);
  return entry.events.length !== before;
}

// Record a report against `userId`. Called for EVERY report, cleared or upheld.
function record({
  userId,
  reporterId,
  messageId,
  verdict, // 'cleared' | 'upheld'
  ruleId,
  suspectedRule,
  bystander,
  excerpt,
}) {
  if (!userId || !reporterId) return;
  const entry = entryFor(userId);
  entry.events.push({
    ts: Date.now(),
    reporterId,
    messageId: messageId || null,
    verdict: verdict === 'upheld' ? 'upheld' : 'cleared',
    ruleId: ruleId || null,
    suspectedRule: (suspectedRule || '').slice(0, 60) || null,
    bystander: !!bystander,
    excerpt: (excerpt || '').slice(0, CFG.excerptMaxLength) || null,
  });
  pruneOld(entry);
  save();
}

// Per-reporter credibility: share of that reporter's reports that were upheld.
// Used to damp the influence of habitual false reporters WITHOUT punishing
// them — this is what the "report_abuse" idea becomes once it is a statistic
// rather than a rule the judge has to adjudicate.
function reporterCredibility(reporterId) {
  let total = 0;
  let upheld = 0;
  for (const entry of Object.values(store)) {
    for (const ev of entry.events || []) {
      if (ev.reporterId !== reporterId) continue;
      total++;
      if (ev.verdict === 'upheld') upheld++;
    }
  }
  if (total < 3) return 1; // too few samples to judge — stay neutral
  return 0.4 + 0.6 * (upheld / total);
}

// Aggregate the signal for one user over the configured window.
function summarize(userId) {
  const entry = store[userId];
  const empty = {
    total: 0, cleared: 0, upheld: 0,
    distinctReporters: 0, bystanderReporters: 0,
    weightedScore: 0, burst: false,
    reasons: [], excerpts: [],
    watch: false, ignoreUntil: 0,
  };
  if (!entry) return empty;

  const cutoff = Date.now() - CFG.windowDays * DAY_MS;
  const events = (entry.events || []).filter((ev) => ev.ts >= cutoff);
  if (events.length === 0) {
    return { ...empty, watch: !!entry.watch, ignoreUntil: entry.ignoreUntil || 0 };
  }

  // Distinct reporters, not raw count: one person reporting ten times is one
  // voice, and counting raw reports would hand the signal to a single user.
  const byReporter = new Map();
  for (const ev of events) {
    const cur = byReporter.get(ev.reporterId);
    if (!cur || (ev.bystander && !cur.bystander)) {
      byReporter.set(ev.reporterId, { bystander: ev.bystander, ts: ev.ts });
    }
  }

  let weightedScore = 0;
  let bystanderReporters = 0;
  for (const [reporterId, info] of byReporter) {
    if (info.bystander) bystanderReporters++;
    // A bystander's report carries more signal: the person you are arguing
    // with reporting you is expected and says little.
    weightedScore += reporterCredibility(reporterId) * (info.bystander ? 1 : 0.5);
  }

  // Burst damping: organic complaints arrive spread out, a pile-on does not.
  const times = [...byReporter.values()].map((v) => v.ts).sort((a, b) => a - b);
  const burst =
    times.length >= 3 &&
    times[times.length - 1] - times[0] <= CFG.burstWindowMin * 60 * 1000;
  if (burst) weightedScore *= 0.5;

  const reasons = {};
  for (const ev of events) {
    const k = ev.suspectedRule || ev.ruleId || '기타';
    reasons[k] = (reasons[k] || 0) + 1;
  }

  return {
    total: events.length,
    cleared: events.filter((e) => e.verdict === 'cleared').length,
    upheld: events.filter((e) => e.verdict === 'upheld').length,
    distinctReporters: byReporter.size,
    bystanderReporters,
    weightedScore: Math.round(weightedScore * 100) / 100,
    burst,
    reasons: Object.entries(reasons).sort((a, b) => b[1] - a[1]),
    excerpts: events.filter((e) => e.excerpt).slice(-3).map((e) => e.excerpt),
    watch: !!entry.watch,
    ignoreUntil: entry.ignoreUntil || 0,
  };
}

// Whether this user now warrants operator review. Never an enforcement gate.
function shouldAlert(userId) {
  const s = summarize(userId);
  if (Date.now() < s.ignoreUntil) return false;
  const threshold = s.watch
    ? CFG.watchDistinctReporters
    : CFG.alertDistinctReporters;
  if (s.distinctReporters >= threshold) return true;
  return s.bystanderReporters >= CFG.alertBystanderReporters;
}

function setWatch(userId, on) {
  const entry = entryFor(userId);
  entry.watch = !!on;
  save();
  return entry.watch;
}

function ignore(userId) {
  const entry = entryFor(userId);
  entry.ignoreUntil = Date.now() + CFG.ignoreDays * DAY_MS;
  save();
  return entry.ignoreUntil;
}

function history(userId, limit = 15) {
  const entry = store[userId];
  if (!entry) return [];
  return entry.events.slice(-limit);
}

module.exports = {
  record,
  summarize,
  shouldAlert,
  setWatch,
  ignore,
  history,
  reporterCredibility,
  _reload: load,
};
