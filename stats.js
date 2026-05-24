const counters = {
  apiCalls: 0,
  cacheHits: 0,
  cacheMisses: 0,
  totalLatencyMs: 0,
  rateLimitDrops: 0,
  errors: 0,
  editsSync: 0,
  deletesSync: 0,
};

const startedAt = Date.now();

function increment(key, amount = 1) {
  if (counters[key] === undefined) return;
  counters[key] += amount;
}

function recordApiCall(latencyMs) {
  counters.apiCalls += 1;
  counters.totalLatencyMs += latencyMs;
}

function snapshot() {
  const total = counters.cacheHits + counters.cacheMisses;
  const cacheHitRate = total > 0 ? counters.cacheHits / total : 0;
  const avgLatencyMs =
    counters.apiCalls > 0
      ? counters.totalLatencyMs / counters.apiCalls
      : 0;
  const uptimeMs = Date.now() - startedAt;

  return {
    ...counters,
    cacheHitRate,
    avgLatencyMs,
    uptimeMs,
    startedAt,
  };
}

module.exports = {
  increment,
  recordApiCall,
  snapshot,
};
