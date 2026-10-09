import { PermissionFlagsBits as P } from 'discord.js';
import { STAFF } from './blueprint.js';

/** What a regular member may do everywhere (no @everyone mass pings, no webhooks, no channel management). */
export const EVERYONE_PERMISSIONS = [
  'ViewChannel', 'SendMessages', 'SendMessagesInThreads', 'CreatePublicThreads', 'EmbedLinks', 'AttachFiles',
  'AddReactions', 'UseExternalEmojis', 'UseExternalStickers', 'ReadMessageHistory', 'UseApplicationCommands',
  'Connect', 'Speak', 'Stream', 'UseVAD', 'ChangeNickname', 'CreateInstantInvite',
];

const READ_ONLY_DENY = [P.SendMessages, P.SendMessagesInThreads, P.CreatePublicThreads, P.CreatePrivateThreads];
const WRITE_ALLOW = [P.ViewChannel, P.SendMessages, P.EmbedLinks, P.AttachFiles, P.ReadMessageHistory];
const BOT_ALLOW = [...WRITE_ALLOW, P.ManageMessages, P.ManageChannels, P.AddReactions];
const SEE_ALLOW = [P.ViewChannel, P.ReadMessageHistory];

/** Roles that see everything once the verification gate hides channels from @everyone. */
const GATE_VISIBLE_ROLES = ['member', 'tester', 'dev', 'mod', 'admin'];

/**
 * Permission overwrites for one channel. Pure: takes plain ids, returns plain objects,
 * so it can be unit-tested without Discord.
 *   roleIds: { admin: id, mod: id, ... } of the roles; everyoneId; botId.
 *   gated: the verification gate is on and this channel is not public: hide it from @everyone, show it to members.
 */
export function buildOverwrites(spec, { roleIds, everyoneId, botId, gated = false }) {
  const ids = (keys = []) => keys.map((k) => roleIds[k]).filter(Boolean);
  const staff = ids(STAFF);
  const out = [];

  if (spec.access === 'staff') {
    out.push({ id: everyoneId, deny: [P.ViewChannel] });
    for (const id of new Set([...staff, ...ids(spec.viewers)])) out.push({ id, allow: WRITE_ALLOW });
  } else if (spec.access === 'read') {
    out.push({ id: everyoneId, deny: READ_ONLY_DENY });
    for (const id of new Set([...staff, ...ids(spec.writers)])) out.push({ id, allow: WRITE_ALLOW });
  }

  if (gated && spec.access !== 'staff') {
    let everyone = out.find((o) => o.id === everyoneId);
    if (!everyone) out.push((everyone = { id: everyoneId }));
    everyone.deny = [...(everyone.deny ?? []), P.ViewChannel];
    for (const id of new Set(ids(GATE_VISIBLE_ROLES))) {
      const existing = out.find((o) => o.id === id);
      if (existing) existing.allow = [...new Set([...(existing.allow ?? []), ...SEE_ALLOW])];
      else out.push({ id, allow: SEE_ALLOW });
    }
  }

  if (botId) out.push({ id: botId, allow: BOT_ALLOW });
  return out;
}

/** Visible to everyone even while the gate is on (welcome, rules, news, ticket button). */
export const isPublicChannel = (spec, category) => Boolean(spec.public || category?.public);
