import {
  ChannelType,
  GuildDefaultMessageNotifications,
  GuildExplicitContentFilter,
  GuildSystemChannelFlags,
  GuildVerificationLevel,
  PermissionFlagsBits as P,
} from 'discord.js';
import { CATEGORIES, MEMBER_ROLE_KEY, OWNER_ROLE_NAME, RANKS, ROLES, blueprintEntries, channelKey } from './blueprint.js';
import { describeCommands } from './commands/index.js';
import * as content from './content.js';
import { buildOverwrites, EVERYONE_PERMISSIONS, isPublicChannel } from './overwrites.js';
import { findChannel } from './util.js';

export { buildOverwrites, EVERYONE_PERMISSIONS };

/** "Owner", "👑 Owner", "owner" ... any role whose name contains the word owner is the one to keep. */
export const isOwnerRole = (role) => new RegExp(`\\b${OWNER_ROLE_NAME}\\b`, 'i').test(role.name);

const errText = (e) => `${e.message}${e.code ? ` (code ${e.code})` : ''}`;

/** What would be deleted/kept, without touching anything. */
export async function planWipe(guild) {
  await guild.roles.fetch();
  await guild.channels.fetch();
  const keptRoles = [];
  const deleteRoles = [];
  for (const role of guild.roles.cache.values()) {
    if (role.id === guild.id) continue; // @everyone
    if (isOwnerRole(role)) keptRoles.push({ role, why: 'Owner role' });
    else if (role.managed) keptRoles.push({ role, why: 'managed by an integration/bot' });
    else if (!role.editable) keptRoles.push({ role, why: 'above the bot - move the bot role higher' });
    else deleteRoles.push(role);
  }
  const channels = [...guild.channels.cache.values()];
  // children first, categories last
  channels.sort((a, b) => Number(a.type === ChannelType.GuildCategory) - Number(b.type === ChannelType.GuildCategory));
  return { keptRoles, deleteRoles, deleteChannels: channels };
}

/**
 * Wipes every channel and every deletable role except Owner, then builds the whole server.
 * Order is build -> wipe old -> order roles -> post content, so a failure half way never leaves
 * the server empty, and community servers can re-point their rules/updates channels first.
 */
export async function runSetup(guild, { dryRun = false, log = console.log } = {}) {
  const problems = [];
  const plan = await planWipe(guild);
  const me = await guild.members.fetchMe();

  log(`Plan for "${guild.name}":`);
  log(`  delete ${plan.deleteChannels.length} channels/categories`);
  log(`  delete ${plan.deleteRoles.length} roles: ${plan.deleteRoles.map((r) => r.name).join(', ') || '-'}`);
  for (const { role, why } of plan.keptRoles) log(`  keep role "${role.name}" (${why})`);
  log(`  create ${ROLES.length} roles + ${RANKS.length} rank roles,${CATEGORIES.length} categories, ${CATEGORIES.flatMap((c) => c.channels).length} channels`);
  if (dryRun) return { dryRun: true, problems, plan };

  const oldChannelIds = plan.deleteChannels.map((c) => c.id);
  const oldRoleIds = plan.deleteRoles.map((r) => r.id);

  // 1. roles (created top-down; the final order is enforced in step 5)
  log('Creating roles...');
  const roles = {}; // key -> Role (new ones only)
  const hasOwner = plan.keptRoles.some((k) => k.why === 'Owner role');
  const toCreate = [...(hasOwner ? [] : [{ key: 'owner', name: OWNER_ROLE_NAME, color: 0xf1c40f, hoist: true, administrator: true }]), ...ROLES];
  for (const spec of toCreate) {
    roles[spec.key] = await guild.roles.create({
      name: spec.name,
      colors: { primaryColor: spec.color },
      hoist: spec.hoist,
      mentionable: false,
      permissions: spec.administrator ? [P.Administrator] : (spec.perms ?? []),
      reason: 'Server setup',
    });
  }
  const roleIds = Object.fromEntries(Object.entries(roles).map(([k, r]) => [k, r.id]));
  // rank roles come last, so they sit below Member (highest tier first so it ends up on top)
  for (const rank of [...RANKS].reverse()) {
    await guild.roles.create({ name: rank.name, colors: { primaryColor: rank.color }, mentionable: false, reason: 'Server setup' });
  }

  // 2. @everyone baseline
  try {
    await guild.roles.everyone.setPermissions(EVERYONE_PERMISSIONS, 'Server setup');
  } catch (e) {
    problems.push(`@everyone permissions: ${errText(e)}`);
  }

  // 3. categories + channels
  log('Creating channels...');
  const created = {};
  for (const category of CATEGORIES) {
    const catOverwrites = category.staffOnly
      ? buildOverwrites({ access: 'staff' }, { roleIds, everyoneId: guild.id, botId: me.id })
      : [];
    const parent = await guild.channels.create({
      name: category.name,
      type: ChannelType.GuildCategory,
      permissionOverwrites: catOverwrites,
      reason: 'Server setup',
    });
    created[`category:${category.name}`] = parent;
    for (const spec of category.channels) {
      created[spec.key] = await guild.channels.create({
        name: spec.name,
        type: spec.type === 'voice' ? ChannelType.GuildVoice : ChannelType.GuildText,
        parent: parent.id,
        topic: spec.type === 'voice' ? undefined : spec.topic,
        permissionOverwrites: buildOverwrites(spec, { roleIds, everyoneId: guild.id, botId: me.id }),
        reason: 'Server setup',
      });
    }
  }

  // 4. community servers must point rules/updates at the new channels before the old ones can go
  if (guild.features.includes('COMMUNITY')) {
    try {
      await guild.edit({ rulesChannel: created.rules, publicUpdatesChannel: created.updates, reason: 'Server setup' });
    } catch (e) {
      problems.push(`community rules/updates channels: ${errText(e)}`);
    }
  }

  // 5. wipe the old stuff
  log('Deleting old channels...');
  for (const id of oldChannelIds) {
    const channel = guild.channels.cache.get(id) ?? (await guild.channels.fetch(id).catch(() => null));
    if (!channel) continue;
    try {
      await channel.delete('Server setup');
    } catch (e) {
      problems.push(`delete channel "${channel.name}": ${errText(e)}`);
    }
  }
  log('Deleting old roles...');
  for (const id of oldRoleIds) {
    const role = guild.roles.cache.get(id);
    if (!role) continue;
    try {
      await role.delete('Server setup');
    } catch (e) {
      problems.push(`delete role "${role.name}": ${errText(e)}`);
    }
  }

  // 6. enforce the role order inside the slots the new roles occupy
  try {
    await orderRoles(guild, roles);
  } catch (e) {
    problems.push(`role order: ${errText(e)}`);
  }

  // 7. owner role for the guild owner (only if we had to create it)
  if (roles.owner) {
    try {
      const owner = await guild.fetchOwner();
      await owner.roles.add(roles.owner, 'Server setup');
    } catch (e) {
      problems.push(`give Owner role to the server owner: ${errText(e)}`);
    }
  }

  // 8. guild settings
  try {
    await guild.edit({
      systemChannel: created.welcome,
      systemChannelFlags: [GuildSystemChannelFlags.SuppressJoinNotifications, GuildSystemChannelFlags.SuppressPremiumSubscriptions],
      defaultMessageNotifications: GuildDefaultMessageNotifications.OnlyMentions,
      verificationLevel: GuildVerificationLevel.Low,
      explicitContentFilter: GuildExplicitContentFilter.AllMembers,
      reason: 'Server setup',
    });
  } catch (e) {
    problems.push(`server settings: ${errText(e)}`);
  }

  // 9. pinned messages
  log('Posting messages...');
  const posts = [
    ['welcome', content.welcomePanel(guild)],
    ['rules', content.rulesPanel()],
    ['announcements', content.openingAnnouncement()],
    ['updates', content.updatesPanel()],
    ['bug-reports', content.bugTemplate(), true],
    ['suggestions', content.suggestionsGuide(), true],
    ['bot-commands', content.botCommandsGuide(describeCommands())],
    ['create-ticket', content.ticketPanel()],
  ];
  for (const [key, payload, pin] of posts) {
    try {
      const message = await created[key].send(payload);
      if (pin) await message.pin();
    } catch (e) {
      problems.push(`post in ${key}: ${errText(e)}`);
    }
  }

  return { dryRun: false, problems, created, roles, memberRoleKey: MEMBER_ROLE_KEY };
}

/** Re-assigns the position numbers the new roles already occupy so they end up in blueprint order. */
export async function orderRoles(guild, roles) {
  await guild.roles.fetch();
  const wanted = ['member', 'tester', 'dev', 'mod', 'admin', 'owner'].filter((k) => roles[k]); // bottom -> top
  const fresh = wanted.map((k) => guild.roles.cache.get(roles[k].id)).filter(Boolean);
  const slots = fresh.map((r) => r.position).sort((a, b) => a - b);
  if (fresh.every((role, i) => role.position === slots[i])) return; // already in blueprint order
  await guild.roles.setPositions(fresh.map((role, i) => ({ role, position: slots[i] })));
}

/**
 * Deletes roles left over from before the rebuild (the ones the bot could not delete while its own
 * role was too low). Keeps: @everyone, Owner, bot/integration roles and the blueprint roles.
 */
export async function cleanupRoles(guild, { dryRun = false, log = console.log } = {}) {
  await guild.roles.fetch();
  const blueprintNames = new Set([...ROLES, ...RANKS].map((r) => r.name));
  const leftovers = [...guild.roles.cache.values()].filter(
    (r) => r.id !== guild.id && !r.managed && !isOwnerRole(r) && !blueprintNames.has(r.name),
  );
  const problems = [];
  for (const role of leftovers) {
    if (dryRun) {
      log(`  would delete "${role.name}"${role.editable ? '' : '  (NOT possible yet: above the bot role)'}`);
    } else if (!role.editable) {
      problems.push(`"${role.name}" is above the bot role. Move the bot role higher in Server Settings > Roles.`);
    } else {
      try {
        await role.delete('Server cleanup');
        log(`  deleted "${role.name}"`);
      } catch (e) {
        problems.push(`delete role "${role.name}": ${errText(e)}`);
      }
    }
  }
  return { leftovers: leftovers.map((r) => r.name), problems };
}

/**
 * Additive and safe: creates only the blueprint channels that do not exist yet (for example a channel added
 * to the blueprint after the server was built). Never deletes or edits anything that exists.
 * Returns the names of the channels it created.
 */
export async function ensureMissingChannels(guild, { gated = false } = {}) {
  await guild.channels.fetch();
  await guild.roles.fetch();
  const me = await guild.members.fetchMe();
  const roleIds = Object.fromEntries(
    ROLES.map((r) => [r.key, guild.roles.cache.find((role) => role.name === r.name)?.id]).filter(([, id]) => id),
  );
  const created = [];
  for (const { spec, category } of blueprintEntries()) {
    const voice = spec.type === 'voice';
    if (findChannel(guild, channelKey(spec.name), { voice })) continue;

    let parent = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === category.name);
    if (!parent) {
      parent = await guild.channels.create({
        name: category.name,
        type: ChannelType.GuildCategory,
        permissionOverwrites: category.staffOnly ? buildOverwrites({ access: 'staff' }, { roleIds, everyoneId: guild.id, botId: me.id }) : [],
        reason: 'Missing blueprint category',
      });
    }
    await guild.channels.create({
      name: spec.name,
      type: voice ? ChannelType.GuildVoice : ChannelType.GuildText,
      parent: parent.id,
      topic: voice ? undefined : spec.topic,
      permissionOverwrites: buildOverwrites(spec, { roleIds, everyoneId: guild.id, botId: me.id, gated: gated && !isPublicChannel(spec, category) }),
      reason: 'Missing blueprint channel',
    });
    created.push(spec.name);
  }
  return created;
}

export { findChannel };
