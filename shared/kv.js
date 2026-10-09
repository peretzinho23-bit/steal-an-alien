import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Tiny async key-value store shared by the bot and the website.
 *   get(key) -> value | null       set(key, value)       del(key)
 *   push(key, item, max) -> newest first, capped        list(key, count) -> items
 * Values must be JSON-serialisable. Two backends: Upstash Redis (REST) and a local JSON file.
 */

const TIMEOUT_MS = 8000;

export class UpstashKv {
  kind = 'upstash';

  constructor(url, token, fetchImpl = globalThis.fetch) {
    this.url = url.replace(/\/+$/, '');
    this.token = token;
    this.fetch = fetchImpl;
  }

  async #call(path, body) {
    const res = await this.fetch(`${this.url}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`KV request failed (${res.status}): ${json.error ?? 'unknown error'}`);
    return json;
  }

  async #cmd(...args) {
    const json = await this.#call('', args);
    if (json.error) throw new Error(`KV error: ${json.error}`);
    return json.result;
  }

  async get(key) {
    const raw = await this.#cmd('GET', key);
    return raw == null ? null : JSON.parse(raw);
  }

  async set(key, value) {
    await this.#cmd('SET', key, JSON.stringify(value));
  }

  async del(key) {
    await this.#cmd('DEL', key);
  }

  async push(key, item, max = 200) {
    const results = await this.#call('/pipeline', [
      ['LPUSH', key, JSON.stringify(item)],
      ['LTRIM', key, 0, max - 1],
    ]);
    const failed = results.find((r) => r.error);
    if (failed) throw new Error(`KV error: ${failed.error}`);
  }

  async list(key, count = 50) {
    const raw = await this.#cmd('LRANGE', key, 0, count - 1);
    return (raw ?? []).map((s) => JSON.parse(s));
  }

  /** Removes and returns the OLDEST item of a pushed list (queue semantics), or null. */
  async pop(key) {
    const raw = await this.#cmd('RPOP', key);
    return raw == null ? null : JSON.parse(raw);
  }
}

/** Bot-only fallback when no Redis is configured: one JSON file, debounced atomic writes. */
export class FileKv {
  kind = 'file';

  constructor(file) {
    this.file = file;
    this.data = {};
    this.timer = null;
    if (existsSync(file)) {
      try {
        this.data = JSON.parse(readFileSync(file, 'utf8'));
      } catch (e) {
        const aside = `${file}.corrupt-${Date.now()}`;
        renameSync(file, aside);
        console.error(`kv file was unreadable (${e.message}); moved to ${aside}`);
      }
    }
  }

  async get(key) {
    return this.data[key] === undefined ? null : structuredClone(this.data[key]);
  }

  async set(key, value) {
    this.data[key] = structuredClone(value);
    this.#schedule();
  }

  async del(key) {
    delete this.data[key];
    this.#schedule();
  }

  async push(key, item, max = 200) {
    const list = Array.isArray(this.data[key]) ? this.data[key] : [];
    list.unshift(structuredClone(item));
    this.data[key] = list.slice(0, max);
    this.#schedule();
  }

  async list(key, count = 50) {
    return structuredClone((Array.isArray(this.data[key]) ? this.data[key] : []).slice(0, count));
  }

  async pop(key) {
    const list = Array.isArray(this.data[key]) ? this.data[key] : [];
    if (!list.length) return null;
    const item = list.pop();
    this.#schedule();
    return structuredClone(item);
  }

  #schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), 1500);
    this.timer.unref?.();
  }

  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data), 'utf8');
    renameSync(tmp, this.file);
  }
}

/** Upstash (or Vercel KV, same API) from the environment, else the file fallback, else null. */
export function kvFromEnv(env = process.env, { file } = {}) {
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  if (url && token) return new UpstashKv(url, token);
  return file ? new FileKv(file) : null;
}

/** Keys used by both sides, in one place so they cannot drift. */
export const KEYS = {
  settings: 'saa:settings',
  audit: 'saa:audit',
  leaderboard: 'saa:leaderboard',
  warnUsers: 'saa:warn-users',
  warns: (guildId, userId) => `saa:warns:${guildId}:${userId}`,
  tempbans: 'saa:tempbans',
  rooms: 'saa:rooms',
  lockdown: 'saa:lockdown',
  heartbeat: 'saa:heartbeat',
  jobs: 'saa:jobs',
  jobResults: 'saa:job-results',
};
