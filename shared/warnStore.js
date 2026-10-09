import { KEYS } from './kv.js';

/**
 * Warnings are stored the same way whether a moderator warns from Discord or from the dashboard:
 * one list per member, plus an index of everyone who has warnings (for the dashboard's list).
 */

export const MAX_WARNS = 100;

/** The punishment configured for exactly this number of warnings (each step fires once), or null. */
export const stepForCount = (escalation, count) => escalation.find((s) => s.at === count) ?? null;

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

export function createWarnStore(kv) {
  const get = async (guildId, userId) => (await kv.get(KEYS.warns(guildId, userId))) ?? [];

  async function setIndex(guildId, userId, count) {
    const index = (await kv.get(KEYS.warnUsers)) ?? {};
    index[guildId] ??= {};
    if (count > 0) index[guildId][userId] = count;
    else delete index[guildId][userId];
    await kv.set(KEYS.warnUsers, index);
  }

  return {
    get,

    /** `by` must be plain data: { id, name }. */
    async add(guildId, userId, { by, reason }) {
      const list = await get(guildId, userId);
      const warn = { id: newId(), at: Date.now(), by: by ? { id: String(by.id), name: String(by.name) } : null, reason: String(reason).slice(0, 400) };
      list.push(warn);
      const kept = list.slice(-MAX_WARNS);
      await kv.set(KEYS.warns(guildId, userId), kept);
      await setIndex(guildId, userId, kept.length);
      return { warn, count: kept.length };
    },

    /** @returns how many are left, or null when there is no warning with that id */
    async remove(guildId, userId, id) {
      const list = await get(guildId, userId);
      const next = list.filter((w) => w.id !== id);
      if (next.length === list.length) return null;
      await kv.set(KEYS.warns(guildId, userId), next);
      await setIndex(guildId, userId, next.length);
      return next.length;
    },

    async clear(guildId, userId) {
      const had = (await get(guildId, userId)).length;
      await kv.del(KEYS.warns(guildId, userId));
      await setIndex(guildId, userId, 0);
      return had;
    },

    /** { [userId]: count } for one server */
    async users(guildId) {
      return ((await kv.get(KEYS.warnUsers)) ?? {})[guildId] ?? {};
    },
  };
}
