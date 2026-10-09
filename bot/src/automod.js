import { createHash } from 'node:crypto';
import { buildRules, syncAutoModRules } from './shared/automodRules.js';
import { getSettings } from './runtime.js';
import { logChannel } from './modlog.js';
import { findRole } from './util.js';

const log = (...args) => console.log(new Date().toISOString(), ...args);
const lastApplied = new Map(); // guildId -> hash of the rules we last pushed

/** discord.js REST wrapped into the (method, path, body) shape the shared sync code expects. */
const restFor = (client) => (method, path, body) => {
  const verb = method.toLowerCase();
  return client.rest[verb](path, body === undefined ? undefined : { body });
};

/** The rules this guild should have right now, with names resolved to ids. */
export function desiredRules(guild, settings = getSettings()) {
  const exemptRoleIds = settings.automod.exemptRoles.map((name) => findRole(guild, name)?.id).filter(Boolean);
  return buildRules(settings, { alertChannelId: logChannel(guild)?.id ?? null, exemptRoleIds });
}

/**
 * Makes Discord's native AutoMod match the dashboard settings. Skips the API calls when nothing changed
 * since the last successful sync (pass force: true to push anyway). Returns the summary, or null if skipped.
 */
export async function syncNativeAutoMod(guild, { settings = getSettings(), force = false } = {}) {
  const desired = desiredRules(guild, settings);
  const hash = createHash('sha1').update(JSON.stringify(desired)).digest('hex');
  if (!force && lastApplied.get(guild.id) === hash) return null;
  const summary = await syncAutoModRules(restFor(guild.client), guild.id, desired);
  if (summary.errors.length) log(`[${guild.name}] AutoMod sync problems:`, summary.errors.join('; '));
  else lastApplied.set(guild.id, hash);
  return summary;
}

export const describeSync = (s) =>
  s ? `created ${s.created.length}, updated ${s.updated.length}, removed ${s.removed.length}${s.errors.length ? `, ${s.errors.length} error(s): ${s.errors[0]}` : ''}` : 'unchanged';
