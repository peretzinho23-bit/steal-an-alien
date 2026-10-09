import { PermissionFlagsBits } from 'discord.js';

/** Read-only snapshot of a guild: what exists and what the bot may do with it. */
export async function describeGuild(guild) {
  await guild.roles.fetch();
  await guild.channels.fetch();
  const me = await guild.members.fetchMe();
  const owner = await guild.fetchOwner().catch(() => null);

  const roles = [...guild.roles.cache.values()]
    .sort((a, b) => b.position - a.position)
    .map((r) => ({
      name: r.name,
      position: r.position,
      managed: r.managed,
      everyone: r.id === guild.id,
      editable: r.editable,
    }));

  const channels = [...guild.channels.cache.values()]
    .sort((a, b) => a.rawPosition - b.rawPosition)
    .map((c) => ({
      name: c.name,
      type: c.constructor.name,
      parent: c.parent?.name ?? null,
      deletable: c.deletable,
    }));

  return {
    name: guild.name,
    id: guild.id,
    memberCount: guild.memberCount,
    owner: owner ? `${owner.user.tag} (${owner.id})` : 'unknown',
    botName: me.user.tag,
    botHighestRole: `${me.roles.highest.name} @${me.roles.highest.position}`,
    botIsAdmin: me.permissions.has(PermissionFlagsBits.Administrator),
    botPerms: {
      manageChannels: me.permissions.has(PermissionFlagsBits.ManageChannels),
      manageRoles: me.permissions.has(PermissionFlagsBits.ManageRoles),
      manageGuild: me.permissions.has(PermissionFlagsBits.ManageGuild),
    },
    roles,
    channels,
  };
}

export function printGuild(info, log = console.log) {
  log(`Server:      ${info.name} (${info.id}), ${info.memberCount} members`);
  log(`Owner:       ${info.owner}`);
  log(`Bot:         ${info.botName}, highest role ${info.botHighestRole}`);
  log(`Bot admin:   ${info.botIsAdmin}  perms: ${JSON.stringify(info.botPerms)}`);
  log(`\nRoles (${info.roles.length}):`);
  for (const r of info.roles) {
    const tags = [r.everyone && 'everyone', r.managed && 'managed', !r.editable && 'NOT editable'].filter(Boolean);
    log(`  @${String(r.position).padStart(2)} ${r.name}${tags.length ? `  [${tags.join(', ')}]` : ''}`);
  }
  log(`\nChannels (${info.channels.length}):`);
  for (const c of info.channels) {
    log(`  ${c.type.padEnd(16)} ${c.parent ? `${c.parent} / ` : ''}${c.name}${c.deletable ? '' : '  [NOT deletable]'}`);
  }
}
