const SEP = '｜'; // full-width bar between the emoji and the name in channel names

/** "👋｜welcome" -> "welcome", "General" -> "general": same rule the bot uses to find its channels. */
export const channelKey = (name) => String(name).split(SEP).pop().trim().toLowerCase().replace(/\s+/g, '-');

export const TEXT_TYPES = new Set([0, 5]); // text, announcement
export const VOICE_TYPES = new Set([2, 13]); // voice, stage

export function findByKey(channels, key, { voice = false } = {}) {
  const types = voice ? VOICE_TYPES : TEXT_TYPES;
  return channels.find((c) => types.has(c.type) && channelKey(c.name) === key) ?? null;
}

/** "Moderator", "🛡 Moderator" -> "moderator": names with a leading emoji still match. */
export const plainName = (name) => String(name).replace(/^[^\p{L}\p{N}]+/u, '').trim().toLowerCase();

/** Avatar URL for a user object from the API (falls back to Discord's default avatar). */
export function avatarUrl(user) {
  if (!user) return null;
  if (user.avatar) return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64`;
  return `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(user.id) >> 22n) % 6n)}.png`;
}

export function guildIconUrl(guild) {
  return guild?.icon ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=64` : null;
}
