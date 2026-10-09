import { PermissionFlagsBits as P } from 'discord.js';
import { modLog } from './modlog.js';
import { getSettings, runtime } from './runtime.js';
import { addWarn, applyEscalation } from './warns.js';

const log = (...args) => console.log(new Date().toISOString(), ...args);
const STRIKES_FOR_WARN = 3;
const STRIKE_WINDOW_MS = 10 * 60_000;

// ---- pure checks (no Discord, easy to test) -----------------------------------------------------

/** Share of upper-case letters among all letters, or null for texts with fewer than `minLength` letters. */
export function capsRatio(content, minLength) {
  const letters = content.replace(/[^\p{L}]/gu, '');
  if (letters.length < minLength) return null;
  const upper = letters.replace(/[^\p{Lu}]/gu, '').length;
  const lower = letters.replace(/[^\p{Ll}]/gu, '').length;
  return upper + lower === 0 ? null : (upper / (upper + lower)) * 100; // scripts without case (Hebrew) are ignored
}

export function capsViolation(content, cfg) {
  const ratio = capsRatio(content, cfg.minLength);
  return ratio !== null && ratio >= cfg.percent ? `too many capital letters (${Math.round(ratio)}%)` : null;
}

const URL_RE = /\bhttps?:\/\/([^\s/?#<>]+)/gi;

/** Hosts of every http(s) link in the text, lower-cased, without credentials or port. */
export function linkHosts(content) {
  return [...content.matchAll(URL_RE)].map((m) => m[1].toLowerCase().replace(/^.*@/, '').replace(/:\d+$/, ''));
}

export const hostAllowed = (host, allow) => allow.some((d) => host === d || host.endsWith(`.${d}`));

/** Allow-list mode: any link whose host is not on the list is a violation. */
export function linkViolation(content, cfg) {
  if (cfg.mode !== 'allowlist') return null;
  const bad = linkHosts(content).find((h) => !hostAllowed(h, cfg.allow));
  return bad ? `link to ${bad} is not allowed here` : null;
}

/** Remembers recent messages per member and spots floods and repeated text. */
export class SpamTracker {
  constructor() {
    this.events = new Map(); // userId -> [{ at, id, channelId, text }]
  }

  /** @returns { type: 'flood'|'duplicates', ids: [...], reason } | null */
  record({ userId, id, channelId, content, now = Date.now() }, cfg) {
    const horizon = Math.max(cfg.flood.seconds, cfg.duplicates.seconds) * 1000;
    const list = (this.events.get(userId) ?? []).filter((e) => now - e.at <= horizon);
    list.push({ at: now, id, channelId, text: content.trim().toLowerCase() });
    this.events.set(userId, list);

    if (cfg.flood.enabled) {
      const recent = list.filter((e) => now - e.at <= cfg.flood.seconds * 1000);
      if (recent.length >= cfg.flood.messages) {
        return { type: 'flood', ids: recent.map((e) => ({ id: e.id, channelId: e.channelId })), reason: `${recent.length} messages in ${cfg.flood.seconds}s` };
      }
    }
    if (cfg.duplicates.enabled && content.trim().length >= 3) {
      const same = list.filter((e) => now - e.at <= cfg.duplicates.seconds * 1000 && e.text === list.at(-1).text);
      if (same.length >= cfg.duplicates.count) {
        return { type: 'duplicates', ids: same.map((e) => ({ id: e.id, channelId: e.channelId })), reason: `same message ${same.length} times` };
      }
    }
    return null;
  }

  forget(userId) {
    this.events.delete(userId);
  }

  /** Drop members who have been quiet for a while so the map cannot grow forever. */
  sweep(now = Date.now(), maxAgeMs = 5 * 60_000) {
    for (const [userId, list] of this.events) {
      if (!list.length || now - list.at(-1).at > maxAgeMs) this.events.delete(userId);
    }
  }
}

// ---- enforcement --------------------------------------------------------------------------------

const tracker = new SpamTracker();
const strikes = new Map(); // userId -> [timestamps]
setInterval(() => {
  tracker.sweep();
  const now = Date.now();
  for (const [userId, times] of strikes) if (!times.some((t) => now - t < STRIKE_WINDOW_MS)) strikes.delete(userId);
}, 5 * 60_000).unref?.();

/** Staff, admins and the roles listed in the settings are never touched by the guards. */
export function isExempt(member, settings = getSettings()) {
  if (!member) return true;
  if (member.permissions.has(P.Administrator) || member.permissions.has(P.ManageMessages)) return true;
  const names = settings.automod.exemptRoles.map((n) => n.toLowerCase());
  return member.roles.cache.some((r) => names.includes(r.name.toLowerCase()));
}

const isTicket = (channel) => channel.topic?.startsWith('ticket:');

async function removeMessages(message, refs) {
  const byChannel = new Map();
  for (const ref of refs) byChannel.set(ref.channelId, [...(byChannel.get(ref.channelId) ?? []), ref.id]);
  for (const [channelId, ids] of byChannel) {
    const channel = message.guild.channels.cache.get(channelId);
    if (!channel) continue;
    await (ids.length > 1 ? channel.bulkDelete(ids, true) : channel.messages.delete(ids[0])).catch(() => {});
  }
}

/**
 * Counts a violation; the third one inside ten minutes becomes a real warning (and may escalate).
 * @returns { warned: boolean, outcome: string|null } outcome = what the escalation step did, if any
 */
async function addStrike(message, reason) {
  const now = Date.now();
  const list = (strikes.get(message.author.id) ?? []).filter((t) => now - t < STRIKE_WINDOW_MS);
  list.push(now);
  strikes.set(message.author.id, list);
  if (list.length < STRIKES_FOR_WARN) return { warned: false, outcome: null };
  strikes.delete(message.author.id);
  const { count } = await addWarn(message.guild.id, message.author.id, { by: { id: message.client.user.id, name: 'AutoMod' }, reason: `Repeated AutoMod violations (${reason})` });
  return { warned: true, outcome: await applyEscalation(message.guild, message.author, count) };
}

const notice = async (message, text) => {
  const sent = await message.channel.send({ content: `${message.author} ${text}`, allowedMentions: { users: [message.author.id] } }).catch(() => null);
  if (sent) setTimeout(() => sent.delete().catch(() => {}), 8000).unref?.();
};

/**
 * Runs the bot-side guards on a new message. Returns true when the message was handled (removed),
 * so the caller can skip XP and everything else. Never throws.
 */
export async function guardMessage(message, settings = getSettings()) {
  try {
    const cfg = settings.automod;
    if (!cfg.enabled || message.author.bot || !message.guild || !message.member) return false;
    if (isTicket(message.channel) || isExempt(message.member, settings)) return false;

    const hasText = runtime.features.content && typeof message.content === 'string';
    const content = hasText ? message.content : '';

    let violation = tracker.record({ userId: message.author.id, id: message.id, channelId: message.channelId, content, now: message.createdTimestamp }, cfg);
    if (!violation && hasText) {
      const reason = (cfg.caps.enabled && capsViolation(content, cfg.caps)) || linkViolation(content, cfg.links);
      if (reason) violation = { type: reason.startsWith('link') ? 'links' : 'caps', ids: [{ id: message.id, channelId: message.channelId }], reason };
    }
    if (!violation) return false;

    tracker.forget(message.author.id);
    await removeMessages(message, violation.ids);
    // From here the message is gone: whatever fails below must not make the caller treat it as a normal message
    // (no XP, no suggestion reactions on a deleted message).
    try {
      let extra = null;
      if (violation.type === 'flood') {
        const member = message.member;
        if (member.moderatable) {
          await member.timeout(cfg.flood.timeoutMinutes * 60_000, `AutoMod: ${violation.reason}`).catch((e) => log('flood timeout failed:', e.message));
          extra = `timed out for ${cfg.flood.timeoutMinutes} minute(s)`;
        }
        await notice(message, `slow down: ${violation.reason}.`);
      } else {
        await notice(message, `your message was removed: ${violation.reason}.`);
      }
      const strike = await addStrike(message, violation.reason);
      if (strike.warned) extra = [extra, `auto-warning issued${strike.outcome ? `, ${strike.outcome}` : ''}`].filter(Boolean).join('; ');
      await modLog(message.guild, { action: `AutoMod: ${violation.type}`, moderator: message.client.user, target: message.author, reason: violation.reason, extra: extra ?? undefined });
    } catch (e) {
      log('AutoMod follow-up failed (the message was still removed):', e.message);
    }
    return true;
  } catch (e) {
    log('guardMessage failed:', e.message);
    return false;
  }
}
