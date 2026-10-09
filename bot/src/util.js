import { ChannelType } from 'discord.js';
import { channelKey } from './blueprint.js';

const TEXT_TYPES = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);
const VOICE_TYPES = new Set([ChannelType.GuildVoice, ChannelType.GuildStageVoice]);

/**
 * Finds a channel by its plain key ("welcome") no matter which emoji prefix it has.
 * Text channels by default; pass { voice: true } for voice channels (text "general" and voice "General" both exist).
 * If several match (an old channel that could not be deleted), the newest one wins.
 */
export function findChannel(guild, key, { voice = false } = {}) {
  const types = voice ? VOICE_TYPES : TEXT_TYPES;
  let newest = null;
  for (const c of guild.channels.cache.values()) {
    if (!types.has(c.type) || channelKey(c.name) !== key) continue;
    if (!newest || isNewer(c.id, newest.id)) newest = c;
  }
  return newest;
}

/** Discord ids are numeric snowflakes (bigger = newer); anything else falls back to plain string order. */
function isNewer(a, b) {
  try {
    return BigInt(a) > BigInt(b);
  } catch {
    return String(a) > String(b);
  }
}

export function findRole(guild, name) {
  return guild.roles.cache.find((r) => r.name.toLowerCase() === name.toLowerCase()) ?? null;
}

/** Mention string for a channel, or its plain name if it does not exist yet. */
export const mention = (guild, key) => {
  const channel = findChannel(guild, key);
  return channel ? `<#${channel.id}>` : `#${key}`;
};

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
