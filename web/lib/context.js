import { createDiscord } from './discord.js';
import { kvFromEnv } from './shared/kv.js';

/**
 * Everything a request needs, built once per warm server instance from environment variables.
 * Tests build their own with fakes instead of calling this.
 */
export function loadConfig(env = process.env) {
  return {
    guildId: env.GUILD_ID ?? '',
    botToken: env.DISCORD_BOT_TOKEN ?? env.DISCORD_TOKEN ?? '',
    clientId: env.DISCORD_CLIENT_ID ?? '',
    clientSecret: env.DISCORD_CLIENT_SECRET ?? '',
    sessionSecret: env.SESSION_SECRET ?? '',
    baseUrl: env.BASE_URL ?? '',
    // Never honoured on Vercel, and the router also insists on localhost. See auth.js.
    allowDevLogin: env.ALLOW_DEV_LOGIN === '1' && !env.VERCEL,
  };
}

/** Which required settings are missing, for a clear message instead of a crash. */
export function configProblems(config) {
  const need = [
    ['GUILD_ID', config.guildId],
    ['DISCORD_BOT_TOKEN', config.botToken],
    ['DISCORD_CLIENT_ID', config.clientId],
    ['DISCORD_CLIENT_SECRET', config.clientSecret],
    ['SESSION_SECRET', config.sessionSecret.length >= 24 ? 'ok' : ''],
  ];
  return need.filter(([, v]) => !v).map(([k]) => k);
}

/** Memoises an async function for `ttlMs`, so a busy dashboard does not hammer Discord for the same list. */
export function cached(fn, ttlMs, now = () => Date.now()) {
  let value;
  let at = -Infinity;
  let pending = null;
  const wrapper = async () => {
    if (now() - at < ttlMs) return value;
    pending ??= fn()
      .then((v) => {
        value = v;
        at = now();
        return v;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };
  wrapper.clear = () => {
    at = -Infinity;
  };
  return wrapper;
}

export function createServices(env = process.env, overrides = {}) {
  const config = loadConfig(env);
  const discord = overrides.discord ?? createDiscord({ token: config.botToken, guildId: config.guildId });
  const kv = overrides.kv !== undefined ? overrides.kv : kvFromEnv(env, { file: env.KV_FILE || undefined }); // KV_FILE: local testing only, never use it on Vercel
  const now = overrides.now ?? (() => Date.now());
  return {
    config,
    discord,
    kv, // null when no Redis is configured: settings, warnings, activity log and the job queue are then unavailable
    now,
    // short-lived caches of rarely changing server data
    guild: cached(() => discord.guild(), 30_000, now),
    roles: cached(() => discord.roles(), 30_000, now),
    channels: cached(() => discord.channels(), 30_000, now),
    botUser: cached(() => discord.request('GET', '/users/@me'), 10 * 60_000, now),
    sleep: overrides.sleep,
    fetch: overrides.fetch ?? globalThis.fetch,
  };
}
