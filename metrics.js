const fs = require('fs').promises;
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
let dirEnsured = false;

function pad(n) {
  return String(n).padStart(2, '0');
}

function fileNameFor(d) {
  return `metrics-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.jsonl`;
}

function todayFile() {
  return path.join(DATA_DIR, fileNameFor(new Date()));
}

async function ensureDir() {
  if (dirEnsured) return;
  await fs.mkdir(DATA_DIR, { recursive: true });
  dirEnsured = true;
}

function record(event) {
  const line = JSON.stringify({ t: Date.now(), ...event }) + '\n';
  (async () => {
    try {
      await ensureDir();
      await fs.appendFile(todayFile(), line, 'utf8');
    } catch (err) {
      console.error(
        'metrics write failed',
        err?.message || err
      );
    }
  })();
}

async function readRecent(maxAgeMs) {
  await ensureDir();
  const cutoff = Date.now() - maxAgeMs;
  const events = [];

  const now = new Date();
  const yesterday = new Date(now.getTime() - 86400000);
  const files = [
    path.join(DATA_DIR, fileNameFor(yesterday)),
    todayFile(),
  ];

  for (const file of files) {
    let content;
    try {
      content = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of content.split('\n')) {
      if (!line) continue;
      try {
        const event = JSON.parse(line);
        if (event.t >= cutoff) events.push(event);
      } catch {
        // skip malformed line (likely crash mid-write)
      }
    }
  }

  return events;
}

function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return 0;
  const idx = Math.min(
    sortedArr.length - 1,
    Math.floor(sortedArr.length * p)
  );
  return sortedArr[idx];
}

function summarize(events) {
  const total = events.length;
  const hits = events.filter((e) => e.hit).length;
  const errors = events.filter((e) => e.err).length;
  const apiCalls = events.filter((e) => !e.hit);
  const latencies = apiCalls
    .filter((e) => typeof e.ms === 'number')
    .map((e) => e.ms)
    .sort((a, b) => a - b);

  const avg = latencies.length
    ? Math.round(
        latencies.reduce((a, b) => a + b, 0) / latencies.length
      )
    : 0;

  const byPair = {};
  for (const e of apiCalls) {
    if (typeof e.ms !== 'number') continue;
    const key = `${e.src}→${e.tgt}`;
    if (!byPair[key]) byPair[key] = [];
    byPair[key].push(e.ms);
  }
  for (const [key, arr] of Object.entries(byPair)) {
    arr.sort((a, b) => a - b);
    byPair[key] = {
      count: arr.length,
      p50: percentile(arr, 0.5),
      p95: percentile(arr, 0.95),
      avg: Math.round(
        arr.reduce((a, b) => a + b, 0) / arr.length
      ),
    };
  }

  return {
    total,
    hits,
    misses: apiCalls.length,
    errors,
    hitRate: total > 0 ? hits / total : 0,
    latency: {
      avg,
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      p99: percentile(latencies, 0.99),
    },
    byPair,
  };
}

module.exports = {
  record,
  readRecent,
  summarize,
};
