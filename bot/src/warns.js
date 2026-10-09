import { KEYS } from './shared/kv.js';
import { getSettings, runtime } from './runtime.js';

const MAX_WARNS = 100;
const log = (...args) => console.log(new Date().toISOString(), ...args);

export async function getWarns(guildId, userId) {
  return (await runtime.kv.get(KEYS.warns(guildId, userId))) ?? [];
}

/** { [guildId]: { [userId]: count } }: lets the dashboard list everyone who has warnings. */
async function setIndex(guildId, userId, count) {
  const index = (await runtime.kv.get(KEYS.warnUsers)) ?? {};
  index[guildId] ??= {};
  if (count > 0) index[guildId][userId] = count;
  else delete index[guildId][userId];
  await runtime.kv.set(KEYS.warnUsers, index);
}

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

export async function addWarn(guildId, userId, { by, reason }) {
  const list = await getWarns(guildId, userId);
  const warn = { id: newId(), at: Date.now(), by: by ?? null, reason: String(reason).slice(0, 400) };
  list.push(warn);
  const kept = list.slice(-MAX_WARNS);
  await runtime.kv.set(KEYS.warns(guildId, userId), kept);
  await setIndex(guildId, userId, kept.length);
  return { warn, count: kept.length };
}

export async function removeWarn(guildId, userId, id) {
  const list = await getWarns(guildId, userId);
  const next = list.filter((w) => w.id !== id);
  if (next.length === list.length) return null;
  await runtime.kv.set(KEYS.warns(guildId, userId), next);
  await setIndex(guildId, userId, next.length);
  return next.length;
}

export async function clearWarns(guildId, userId) {
  const had = (await getWarns(guildId, userId)).length;
  await runtime.kv.del(KEYS.warns(guildId, userId));
  await setIndex(guildId, userId, 0);
  return had;
}

/** The punishment configured for exactly this number of warnings (each step fires once), or null. */
export const stepForCount = (escalation, count) => escalation.find((s) => s.at === count) ?? null;

/**
 * Applies the escalation step for `count` warnings. Returns a short human sentence about what happened
 * (or null when no step matches), never throws.
 */
export async function applyEscalation(guild, user, count, settings = getSettings()) {
  const step = stepForCount(settings.automod.warns.escalation, count);
  if (!step) return null;
  const reason = `Reached ${count} warnings`;
  try {
    const member = await guild.members.fetch(user.id).catch(() => null);
    if (step.action === 'timeout') {
      if (!member?.moderatable) return `could not time out (missing permission or higher role)`;
      await member.timeout(step.minutes * 60_000, reason);
      return `timed out for ${step.minutes} minute(s)`;
    }
    if (step.action === 'kick') {
      if (!member?.kickable) return `could not kick (missing permission or higher role)`;
      await member.kick(reason);
      return 'kicked';
    }
    await guild.members.ban(user.id, { reason });
    return 'banned';
  } catch (e) {
    log(`Escalation ${step.action} failed for ${user.id}:`, e.message);
    return `escalation failed: ${e.message}`;
  }
}

// ---- temporary bans -----------------------------------------------------------------------------

export async function addTempBan({ guildId, userId, until, by, reason }) {
  const list = (await runtime.kv.get(KEYS.tempbans)) ?? [];
  const next = list.filter((b) => !(b.guildId === guildId && b.userId === userId));
  next.push({ guildId, userId, until, by, reason });
  await runtime.kv.set(KEYS.tempbans, next);
}

/** Unbans everyone whose time is up. Returns how many were lifted. */
export async function processTempBans(client, now = Date.now()) {
  const list = (await runtime.kv.get(KEYS.tempbans)) ?? [];
  if (!list.length) return 0;
  const due = list.filter((b) => b.until <= now);
  if (!due.length) return 0;
  let lifted = 0;
  const keep = list.filter((b) => b.until > now);
  for (const ban of due) {
    try {
      const guild = client.guilds.cache.get(ban.guildId);
      await guild?.members.unban(ban.userId, 'Temporary ban expired');
      lifted++;
    } catch (e) {
      // 10026 = the ban no longer exists (someone unbanned manually): fine. Anything else: retry next tick.
      if (e.code !== 10026) keep.push(ban);
      else lifted++;
    }
  }
  await runtime.kv.set(KEYS.tempbans, keep);
  return lifted;
}
