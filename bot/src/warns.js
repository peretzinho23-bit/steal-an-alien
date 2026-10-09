import { KEYS } from './shared/kv.js';
import { createWarnStore, stepForCount } from './shared/warnStore.js';
import { getSettings, runtime } from './runtime.js';

const log = (...args) => console.log(new Date().toISOString(), ...args);

// The warning storage is shared with the website, so both sides write exactly the same data.
const store = () => createWarnStore(runtime.kv);
export const getWarns = (guildId, userId) => store().get(guildId, userId);
export const addWarn = (guildId, userId, entry) => store().add(guildId, userId, entry);
export const removeWarn = (guildId, userId, id) => store().remove(guildId, userId, id);
export const clearWarns = (guildId, userId) => store().clear(guildId, userId);
export { stepForCount };

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
// Only the bot writes these, so the list lives in memory after one read and the scheduler never polls the store.

let pending = null;
async function loadTempBans() {
  pending ??= (await runtime.kv.get(KEYS.tempbans)) ?? [];
  return pending;
}
export const resetTempBanCache = () => {
  pending = null;
};

export async function addTempBan({ guildId, userId, until, by, reason }) {
  const list = await loadTempBans();
  pending = list.filter((b) => !(b.guildId === guildId && b.userId === userId));
  pending.push({ guildId, userId, until, by, reason });
  await runtime.kv.set(KEYS.tempbans, pending);
}

/** Unbans everyone whose time is up. Returns how many were lifted. */
export async function processTempBans(client, now = Date.now()) {
  const list = await loadTempBans();
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
  pending = keep;
  await runtime.kv.set(KEYS.tempbans, keep);
  return lifted;
}
