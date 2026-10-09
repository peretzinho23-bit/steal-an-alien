import { SEP } from './blueprint.js';

/**
 * Finds a channel by its plain key ("welcome") no matter which emoji prefix it has.
 * If several match (an old channel that could not be deleted), the newest one wins.
 */
export function findChannel(guild, key) {
  const matches = guild.channels.cache.filter((c) => c.name === key || c.name.endsWith(`${SEP}${key}`));
  let newest = null;
  for (const c of matches.values()) if (!newest || BigInt(c.id) > BigInt(newest.id)) newest = c;
  return newest;
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
