import { HttpError } from './http.js';

/**
 * Sliding-window limiter kept in memory. On a serverless host every warm instance has its own counters, so this is
 * a safety net against runaway scripts and double-clicks, not a hard guarantee.
 */
const buckets = new Map();

export function limit(key, max, windowMs, now = Date.now()) {
  const recent = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= max) {
    buckets.set(key, recent);
    throw new HttpError(429, 'Too many requests. Wait a few seconds and try again.');
  }
  recent.push(now);
  buckets.set(key, recent);
  if (buckets.size > 5000) for (const [k, v] of buckets) if (!v.length || now - v.at(-1) > windowMs) buckets.delete(k);
}

export const resetLimits = () => buckets.clear();
