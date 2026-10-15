'use strict';

const buckets = new Map();

function allow(key, limit = 60, now = Date.now()) {
  const max = Math.max(1, Math.floor(Number(limit) || 60));
  const current = buckets.get(key);
  const bucket = !current || current.resetAt <= now ? { count: 0, resetAt: now + 60000 } : current;
  bucket.count += 1;
  buckets.set(key, bucket);
  if (buckets.size > 5000) {
    for (const [entryKey, entry] of buckets) if (entry.resetAt <= now) buckets.delete(entryKey);
  }
  return { ok: bucket.count <= max, remaining: Math.max(0, max - bucket.count), resetAt: bucket.resetAt };
}

function limit() {
  const configured = Number(process.env.PDL_MCP_RATE_LIMIT);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 60;
}

module.exports = { allow, limit };
