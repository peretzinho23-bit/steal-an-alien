import { blueprintEntries, channelKey } from './blueprint.js';
import { modLog } from './modlog.js';
import { KEYS } from './shared/kv.js';
import { runtime } from './runtime.js';
import { findChannel } from './util.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const LOCK_DENY = { SendMessages: false, AddReactions: false, SendMessagesInThreads: false, CreatePublicThreads: false };
const log = (...args) => console.log(new Date().toISOString(), ...args);

/** The blueprint entry for a channel (matched by name and kind), or null for channels staff created themselves. */
export function specFor(channel) {
  const voice = channel.isVoiceBased?.() ?? false;
  const key = channelKey(channel.name);
  return blueprintEntries().find(({ spec }) => channelKey(spec.name) === key && (spec.type === 'voice') === voice)?.spec ?? null;
}

/**
 * What @everyone's "send messages" overwrite should be when a channel is NOT locked:
 * read-only channels stay denied, everything else goes back to inheriting (null).
 */
export const everyoneSendWhenOpen = (channel) => (specFor(channel)?.access === 'read' ? false : null);

/** Staff channels stay hidden when "shown" again. */
export const everyoneViewWhenShown = (channel) => (specFor(channel)?.access === 'staff' ? false : null);

export async function getLockdown() {
  return (await runtime.kv.get(KEYS.lockdown)) ?? null;
}

/** Blueprint chat channels that members can normally write in. */
const chatChannels = (guild) =>
  blueprintEntries()
    .filter(({ spec }) => spec.access === 'chat' && spec.type === 'text')
    .map(({ spec }) => findChannel(guild, channelKey(spec.name)))
    .filter(Boolean);

const incidentActions = (guild, body) => guild.client.rest.put(`/guilds/${guild.id}/incident-actions`, { body });

/**
 * Raid response: nobody can write in the public chat channels and invites are paused (Discord caps that at 24h).
 * Returns what was done. Safe to call twice.
 */
export async function lockdownOn(guild, { minutes = 15, by = null, reason = 'Lockdown' } = {}) {
  const until = Date.now() + minutes * 60_000;
  const locked = [];
  for (const channel of chatChannels(guild)) {
    try {
      await channel.permissionOverwrites.edit(guild.id, LOCK_DENY, { reason });
      locked.push(channel.id);
    } catch (e) {
      log(`lockdown: could not lock ${channel.name}:`, e.message);
    }
  }
  let invitesPaused = false;
  try {
    await incidentActions(guild, { invites_disabled_until: new Date(Math.min(until, Date.now() + DAY_MS)).toISOString() });
    invitesPaused = true;
  } catch (e) {
    log('lockdown: could not pause invites:', e.message);
  }
  await runtime.kv.set(KEYS.lockdown, { guildId: guild.id, at: Date.now(), until, by, locked, invitesPaused });
  const notice = findChannel(guild, 'general');
  await notice
    ?.send(`🔒 **The server is in lockdown for ${minutes} minute(s).** Staff are handling it. Chat opens again soon.`)
    .catch(() => {});
  await modLog(guild, { action: 'Lockdown ON', moderator: by, reason, extra: `${locked.length} channel(s) locked, invites ${invitesPaused ? 'paused' : 'NOT paused'}, ${minutes} min` });
  return { locked: locked.length, invitesPaused, until };
}

export async function lockdownOff(guild, { by = null, reason = 'Lockdown ended' } = {}) {
  const state = await getLockdown();
  let opened = 0;
  for (const channel of chatChannels(guild)) {
    try {
      await channel.permissionOverwrites.edit(guild.id, { SendMessages: null, AddReactions: null, SendMessagesInThreads: null, CreatePublicThreads: null }, { reason });
      opened++;
    } catch (e) {
      log(`lockdown: could not unlock ${channel.name}:`, e.message);
    }
  }
  try {
    await incidentActions(guild, { invites_disabled_until: null });
  } catch (e) {
    log('lockdown: could not resume invites:', e.message);
  }
  await runtime.kv.del(KEYS.lockdown);
  await findChannel(guild, 'general')?.send('🔓 **Lockdown is over.** Chat is open again.').catch(() => {});
  await modLog(guild, { action: 'Lockdown OFF', moderator: by, reason, extra: `${opened} channel(s) reopened` });
  return { opened, wasLocked: Boolean(state) };
}

/** Called by the scheduler: ends a lockdown whose time is up. */
export async function checkLockdownExpiry(client, now = Date.now()) {
  const state = await getLockdown();
  if (!state || state.until > now) return false;
  const guild = client.guilds.cache.get(state.guildId);
  if (!guild) return false;
  await lockdownOff(guild, { reason: 'Lockdown time is up' });
  return true;
}
