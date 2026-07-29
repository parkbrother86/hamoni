// Report-abuse defense for the reasoner path.
//
// The judge model (deepseek-v4-pro) is slow and heavy, so the report entrypoint
// must be protected from flooding. Three layers, checked in this order:
//
//   1. Verdict cache (dedup) — a message already judged returns its cached
//      outcome instantly. 10 people reporting the same message = 1 LLM call.
//      This also prevents double-strikes on the same message.
//   2. Per-reporter hourly cap — one user cannot spam reports.
//   3. Global token bucket — coordinated multi-account floods are soft-rejected.
//
// All state is in-memory (resets on restart) — abuse windows are short-lived,
// so persistence is unnecessary here (unlike strikes).

const { MODERATION } = require('./config');

const { perReporterPerHour, globalPerMinute, verdictCacheMs } =
  MODERATION.limits;

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

// sourceMessageId -> { outcome, ts }
const verdictCache = new Map();
// reporterId -> array of timestamps within the trailing hour
const reporterHits = new Map();
// global reasoner-call timestamps within the trailing minute
let globalHits = [];

function getCached(sourceMessageId) {
  const hit = verdictCache.get(sourceMessageId);
  if (!hit) return null;
  if (Date.now() - hit.ts > verdictCacheMs) {
    verdictCache.delete(sourceMessageId);
    return null;
  }
  return hit.outcome;
}

function setCached(sourceMessageId, outcome) {
  verdictCache.set(sourceMessageId, { outcome, ts: Date.now() });
}

function prune(list, windowMs, now) {
  const cutoff = now - windowMs;
  let i = 0;
  while (i < list.length && list[i] < cutoff) i++;
  return i > 0 ? list.slice(i) : list;
}

// Reserve one reasoner call for `reporterId`. Consumes a slot from both the
// per-reporter and global budgets when allowed. Call ONLY after a verdict-cache
// miss (cached outcomes are free and must not consume budget).
// Returns { ok: true } or { ok: false, reason }.
function reserve(reporterId) {
  const now = Date.now();

  const hits = prune(reporterHits.get(reporterId) || [], HOUR_MS, now);
  if (hits.length >= perReporterPerHour) {
    reporterHits.set(reporterId, hits);
    return { ok: false, reason: 'reporter' };
  }

  globalHits = prune(globalHits, MINUTE_MS, now);
  if (globalHits.length >= globalPerMinute) {
    reporterHits.set(reporterId, hits);
    return { ok: false, reason: 'global' };
  }

  hits.push(now);
  reporterHits.set(reporterId, hits);
  globalHits.push(now);
  return { ok: true };
}

module.exports = {
  getCached,
  setCached,
  reserve,
};
