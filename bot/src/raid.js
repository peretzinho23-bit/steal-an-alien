import { EmbedBuilder, time } from 'discord.js';
import { lockdownOn } from './lockdown.js';
import { logChannel, modLog } from './modlog.js';
import { getSettings } from './runtime.js';
import { tryDmSafe } from './dm.js';

const log = (...args) => console.log(new Date().toISOString(), ...args);
const DAY_MS = 86_400_000;
const MAX_TIMEOUT_MS = 28 * DAY_MS;
const RAID_COOLDOWN_MS = 5 * 60_000;

/** Join times inside the window; true when there are at least `joins` of them. Pure. */
export function detectRaid(timestamps, now, { joins, seconds }) {
  const recent = timestamps.filter((t) => now - t <= seconds * 1000);
  return { raid: recent.length >= joins, count: recent.length };
}

/** Days old and what is left of the minimum age; null when the account is old enough or the check is off. Pure. */
export function accountTooNew(createdAtMs, now, { minAccountAgeDays, accountAgeAction }) {
  if (accountAgeAction === 'none' || minAccountAgeDays <= 0) return null;
  const age = now - createdAtMs;
  const needed = minAccountAgeDays * DAY_MS;
  return age < needed ? { ageDays: age / DAY_MS, remainingMs: needed - age } : null;
}

export class RaidGuard {
  constructor() {
    this.joins = []; // [{ at, userId }]
    this.lastAlert = -Infinity;
  }

  /** Records a join and says whether it completes a raid pattern (at most once per cooldown). */
  record(userId, now, cfg) {
    this.joins = this.joins.filter((j) => now - j.at <= Math.max(cfg.seconds, 60) * 1000);
    this.joins.push({ at: now, userId });
    const { raid, count } = detectRaid(this.joins.map((j) => j.at), now, cfg);
    if (!raid || now - this.lastAlert < RAID_COOLDOWN_MS) return null;
    this.lastAlert = now;
    return { count, userIds: this.joins.filter((j) => now - j.at <= cfg.seconds * 1000).map((j) => j.userId) };
  }

  /** True while the cooldown after the last alert runs, i.e. the raid we already reported is still going on. */
  isRaiding(now) {
    return now - this.lastAlert < RAID_COOLDOWN_MS;
  }
}

const guard = new RaidGuard();

/** Account-age check for a new member. Returns a short sentence about what it did, or null. */
export async function checkAccountAge(member, settings = getSettings(), now = Date.now()) {
  const r = settings.raid;
  const tooNew = accountTooNew(member.user.createdTimestamp, now, r);
  if (!tooNew) return null;
  const days = tooNew.ageDays.toFixed(1);
  try {
    if (r.accountAgeAction === 'kick') {
      await tryDmSafe(member.user, `Your Discord account is only ${days} day(s) old. ${member.guild.name} needs accounts older than ${r.minAccountAgeDays} day(s). Please come back later.`);
      if (!member.kickable) return `account is ${days} days old but I cannot kick them`;
      await member.kick(`Account younger than ${r.minAccountAgeDays} day(s)`);
      return `kicked: account is ${days} days old`;
    }
    if (!member.moderatable) return `account is ${days} days old but I cannot time them out`;
    await member.timeout(Math.min(tooNew.remainingMs, MAX_TIMEOUT_MS), `Account younger than ${r.minAccountAgeDays} day(s)`);
    return `timed out until the account is ${r.minAccountAgeDays} day(s) old (now ${days})`;
  } catch (e) {
    log('account age action failed:', e.message);
    return `account-age action failed: ${e.message}`;
  }
}

/** Raid response chosen in the dashboard. Never throws. */
export async function handleJoin(member, settings = getSettings(), now = Date.now()) {
  try {
    return await handleJoinUnsafe(member, settings, now);
  } catch (e) {
    log('join check failed:', e.message);
    return { raid: false, ageAction: null };
  }
}

async function handleJoinUnsafe(member, settings, now) {
  const r = settings.raid;
  if (!r.enabled || member.user.bot) return { raid: false, ageAction: null };
  const ageAction = await checkAccountAge(member, settings, now);
  if (ageAction) {
    await modLog(member.guild, { action: 'Account age check', moderator: member.client.user, target: member.user, extra: ageAction });
  }

  const hit = guard.record(member.id, now, r);
  if (!hit) {
    // Alerts are once per cooldown, but with the kick response every joiner during that raid must still be removed
    if (r.action === 'kick' && guard.isRaiding(now) && member.kickable) {
      await member.kick('Raid response (joined during a raid)').catch((e) => log('raid kick failed:', e.message));
      await modLog(member.guild, { action: 'Raid: kicked joiner', moderator: member.client.user, target: member.user, extra: 'joined during an active raid' });
    }
    return { raid: false, ageAction };
  }
  try {
    const channel = logChannel(member.guild);
    await channel?.send({
      embeds: [
        new EmbedBuilder()
          .setColor(0xed4245)
          .setTitle('🚨 Possible raid')
          .setDescription(`${hit.count} members joined within ${r.seconds} seconds. Configured response: **${r.action}**.`)
          .addFields({ name: 'Detected', value: time(Math.floor(now / 1000), 'T') }),
      ],
    });
    if (r.action === 'lockdown') {
      await lockdownOn(member.guild, { minutes: r.lockdownMinutes, by: member.client.user, reason: 'Automatic raid response' });
    } else if (r.action === 'kick') {
      let kicked = 0;
      const ids = [...new Set([member.id, ...hit.userIds])]; // the joiner who completed the pattern is always included
      for (const userId of ids) {
        const m = userId === member.id ? member : member.guild.members.cache.get(userId);
        if (m?.kickable && await m.kick('Raid response').then(() => true).catch(() => false)) kicked++;
      }
      await modLog(member.guild, { action: 'Raid: kicked recent joiners', moderator: member.client.user, extra: `${kicked} of ${ids.length}` });
    }
  } catch (e) {
    log('raid response failed:', e.message);
  }
  return { raid: true, ageAction };
}
