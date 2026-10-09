/**
 * Server settings edited from the dashboard and enforced by the bot.
 * normalizeSettings() is the single gate: whatever comes in (a form, an old saved version, garbage)
 * comes out complete, typed and inside safe limits.
 */

export const SETTINGS_VERSION = 1;

export const PRESETS = ['profanity', 'sexual', 'slurs']; // Discord keyword presets 1, 2, 3
export const ESCALATION_ACTIONS = ['timeout', 'kick', 'ban'];
export const RAID_ACTIONS = ['lockdown', 'kick', 'none'];
export const AGE_ACTIONS = ['none', 'timeout', 'kick'];
export const LINK_MODES = ['off', 'allowlist'];

export const DEFAULT_SETTINGS = Object.freeze({
  version: SETTINGS_VERSION,
  automod: {
    enabled: true,
    spam: true,
    mentions: { enabled: true, limit: 5, raidProtection: true, timeoutMinutes: 10 },
    badWords: { enabled: true, presets: [...PRESETS], allow: [] },
    customWords: { enabled: false, words: [] },
    invites: { block: true },
    scams: { block: true },
    links: { mode: 'off', allow: ['roblox.com', 'youtube.com', 'youtu.be', 'twitch.tv', 'tiktok.com', 'discord.com'] },
    flood: { enabled: true, messages: 6, seconds: 5, timeoutMinutes: 5 },
    duplicates: { enabled: true, count: 3, seconds: 30 },
    caps: { enabled: false, minLength: 12, percent: 70 },
    warns: {
      escalation: [
        { at: 3, action: 'timeout', minutes: 60 },
        { at: 5, action: 'kick' },
        { at: 7, action: 'ban' },
      ],
    },
    exemptRoles: ['Moderator', 'Admin', 'Developer'],
    blockMessage: 'This message was blocked by the server rules.',
  },
  raid: {
    enabled: true,
    joins: 8,
    seconds: 20,
    action: 'lockdown',
    lockdownMinutes: 15,
    minAccountAgeDays: 1,
    accountAgeAction: 'none',
    gate: false,
  },
  logs: { joins: true, leaves: true, messages: true, bans: true, channels: true, roles: true, voice: false },
});

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const bool = (v, d) => (typeof v === 'boolean' ? v : d);
const int = (v, d, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : d;
};
const oneOf = (v, allowed, d) => (allowed.includes(v) ? v : d);
const strList = (v, d, { max, maxLen, lower = false }) => {
  if (!Array.isArray(v)) return [...d];
  const seen = new Set();
  const out = [];
  for (const item of v) {
    let s = typeof item === 'string' ? item.trim() : '';
    if (lower) s = s.toLowerCase();
    if (!s || s.length > maxLen || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
};

export function normalizeSettings(input) {
  const src = isObj(input) ? input : {};
  const D = DEFAULT_SETTINGS;
  const a = isObj(src.automod) ? src.automod : {};
  const r = isObj(src.raid) ? src.raid : {};
  const l = isObj(src.logs) ? src.logs : {};
  const sub = (k) => (isObj(a[k]) ? a[k] : {});

  const escalation = Array.isArray(sub('warns').escalation)
    ? sub('warns')
        .escalation.filter(isObj)
        .map((s) => {
          const action = oneOf(s.action, ESCALATION_ACTIONS, null);
          const at = Number(s.at);
          if (!action || !Number.isInteger(at) || at < 1 || at > 50) return null; // invalid steps are dropped, not repaired
          const step = { at, action };
          if (action === 'timeout') step.minutes = int(s.minutes, 60, 1, 40320);
          return step;
        })
        .filter(Boolean)
        .sort((x, y) => x.at - y.at)
        .filter((s, i, arr) => i === 0 || s.at !== arr[i - 1].at)
        .slice(0, 6)
    : D.automod.warns.escalation.map((s) => ({ ...s }));

  return {
    version: SETTINGS_VERSION,
    automod: {
      enabled: bool(a.enabled, D.automod.enabled),
      spam: bool(a.spam, D.automod.spam),
      mentions: {
        enabled: bool(sub('mentions').enabled, D.automod.mentions.enabled),
        limit: int(sub('mentions').limit, D.automod.mentions.limit, 2, 50),
        raidProtection: bool(sub('mentions').raidProtection, D.automod.mentions.raidProtection),
        timeoutMinutes: int(sub('mentions').timeoutMinutes, D.automod.mentions.timeoutMinutes, 0, 40320),
      },
      badWords: {
        enabled: bool(sub('badWords').enabled, D.automod.badWords.enabled),
        presets: Array.isArray(sub('badWords').presets)
          ? PRESETS.filter((p) => sub('badWords').presets.includes(p))
          : [...D.automod.badWords.presets],
        allow: strList(sub('badWords').allow, [], { max: 100, maxLen: 60, lower: true }),
      },
      customWords: {
        enabled: bool(sub('customWords').enabled, D.automod.customWords.enabled),
        words: strList(sub('customWords').words, [], { max: 1000, maxLen: 60, lower: true }),
      },
      invites: { block: bool(sub('invites').block, D.automod.invites.block) },
      scams: { block: bool(sub('scams').block, D.automod.scams.block) },
      links: {
        mode: oneOf(sub('links').mode, LINK_MODES, D.automod.links.mode),
        allow: strList(sub('links').allow, D.automod.links.allow, { max: 100, maxLen: 100, lower: true }),
      },
      flood: {
        enabled: bool(sub('flood').enabled, D.automod.flood.enabled),
        messages: int(sub('flood').messages, D.automod.flood.messages, 3, 30),
        seconds: int(sub('flood').seconds, D.automod.flood.seconds, 2, 60),
        timeoutMinutes: int(sub('flood').timeoutMinutes, D.automod.flood.timeoutMinutes, 1, 1440),
      },
      duplicates: {
        enabled: bool(sub('duplicates').enabled, D.automod.duplicates.enabled),
        count: int(sub('duplicates').count, D.automod.duplicates.count, 2, 10),
        seconds: int(sub('duplicates').seconds, D.automod.duplicates.seconds, 5, 300),
      },
      caps: {
        enabled: bool(sub('caps').enabled, D.automod.caps.enabled),
        minLength: int(sub('caps').minLength, D.automod.caps.minLength, 5, 200),
        percent: int(sub('caps').percent, D.automod.caps.percent, 30, 100),
      },
      warns: { escalation },
      exemptRoles: strList(a.exemptRoles, D.automod.exemptRoles, { max: 20, maxLen: 100 }),
      blockMessage: typeof a.blockMessage === 'string' && a.blockMessage.trim() ? a.blockMessage.trim().slice(0, 150) : D.automod.blockMessage,
    },
    raid: {
      enabled: bool(r.enabled, D.raid.enabled),
      joins: int(r.joins, D.raid.joins, 3, 100),
      seconds: int(r.seconds, D.raid.seconds, 5, 300),
      action: oneOf(r.action, RAID_ACTIONS, D.raid.action),
      lockdownMinutes: int(r.lockdownMinutes, D.raid.lockdownMinutes, 1, 1440),
      minAccountAgeDays: int(r.minAccountAgeDays, D.raid.minAccountAgeDays, 0, 365),
      accountAgeAction: oneOf(r.accountAgeAction, AGE_ACTIONS, D.raid.accountAgeAction),
      gate: bool(r.gate, D.raid.gate),
    },
    logs: Object.fromEntries(Object.keys(D.logs).map((k) => [k, bool(l[k], D.logs[k])])),
  };
}
