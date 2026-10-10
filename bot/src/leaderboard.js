import { levelFromXp, rankForLevel } from './levels/math.js';
import { runtime } from './runtime.js';
import { KEYS } from './shared/kv.js';

const log = (...args) => console.log(new Date().toISOString(), ...args);
export const LEADERBOARD_MAX = 50;

const text = (v) => (typeof v === 'string' && v.length > 0 ? v : null);

/** Name and avatar from what the bot already has in memory (no API calls): member cache first, then the user cache. */
function identity(guild, userId) {
  const member = guild.members?.cache?.get?.(userId) ?? null;
  const user = member?.user ?? guild.client?.users?.cache?.get?.(userId) ?? null;
  let avatar = null;
  try {
    avatar = text(user?.displayAvatarURL?.({ size: 128 }));
  } catch {
    avatar = null;
  }
  return { name: text(member?.displayName) ?? text(user?.username), avatar };
}

/**
 * The snapshot the website's "ranks" page reads: top members of one guild, best first, plain JSON only.
 * Pure apart from reading the store and the in-memory caches of the guild. Never makes Discord API calls.
 * @param store LevelStore (bot/src/levels/store.js)
 * @param guild a discord.js guild, or any object with the same id / members.cache / client.users.cache shape
 */
export function buildLeaderboard(store, guild, limit = LEADERBOARD_MAX, now = Date.now()) {
  const max = Math.min(LEADERBOARD_MAX, Math.max(1, Math.trunc(Number(limit)) || LEADERBOARD_MAX));
  const entries = store.ranking(guild.id).slice(0, max).map(([id, e]) => {
    const { level, current, needed } = levelFromXp(e.xp);
    const { name, avatar } = identity(guild, id);
    return { id, name, avatar, xp: e.xp, level, current, needed, rank: rankForLevel(level)?.name ?? null };
  });
  return { at: now, entries };
}

/**
 * Writes the snapshot to the shared store for every guild the bot is in (skipping guilds with no XP yet).
 * Each guild gets its own key (KEYS.leaderboard + ":" + guildId). The website reads KEYS.leaderboard, which holds the
 * guild with the most ranked members. Never throws.
 * @param levels the LevelSystem (client.levels) or a LevelStore directly
 * @returns { published: number }
 */
export async function publishLeaderboard(client, levels) {
  try {
    const store = levels?.store ?? levels;
    if (typeof store?.ranking !== 'function' || !runtime.kv) return { published: 0 };
    let published = 0;
    let primary = null;
    for (const guild of client?.guilds?.cache?.values?.() ?? []) {
      try {
        const ranked = store.ranking(guild.id).length;
        if (!ranked) continue;
        const snapshot = buildLeaderboard(store, guild);
        await runtime.kv.set(`${KEYS.leaderboard}:${guild.id}`, snapshot);
        published++;
        if (!primary || ranked > primary.ranked) primary = { ranked, snapshot };
      } catch (e) {
        log(`leaderboard for guild ${guild?.id} failed:`, e.message);
      }
    }
    if (primary) await runtime.kv.set(KEYS.leaderboard, primary.snapshot);
    return { published };
  } catch (e) {
    log('leaderboard publish failed:', e.message);
    return { published: 0 };
  }
}
