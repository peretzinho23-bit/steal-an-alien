import { MessageFlags } from 'discord.js';
import { MEMBER_ROLE_KEY, ROLES, blueprintEntries, channelKey } from './blueprint.js';
import { buildOverwrites, isPublicChannel } from './overwrites.js';
import { findChannel, findRole } from './util.js';

const log = (...args) => console.log(new Date().toISOString(), ...args);
export const memberRoleName = ROLES.find((r) => r.key === MEMBER_ROLE_KEY).name;

/**
 * Turns the verification gate on or off by re-applying the blueprint permissions with or without "gated".
 * On: new members only see the public channels until they press Verify. Everyone who is already in the server
 * gets the Member role first, so nobody is locked out. Replaces the overwrites of blueprint channels only.
 */
export async function applyGate(guild, enabled) {
  await guild.roles.fetch();
  await guild.channels.fetch();
  const me = await guild.members.fetchMe();
  const roleIds = Object.fromEntries(ROLES.map((r) => [r.key, findRole(guild, r.name)?.id]).filter(([, id]) => id));

  let granted = 0;
  const memberRole = findRole(guild, memberRoleName);
  if (enabled) {
    // Never hide the channels unless everybody who is here can still see them afterwards.
    if (!memberRole) throw new Error(`The "${memberRoleName}" role does not exist, so turning the gate on would lock everyone out. Nothing was changed.`);
    const members = await guild.members.fetch();
    let failed = 0;
    for (const m of members.values()) {
      if (m.user.bot || m.roles.cache.has(memberRole.id)) continue;
      if (await m.roles.add(memberRole, 'Verification gate enabled').then(() => true).catch(() => false)) granted++;
      else failed++;
    }
    if (failed) {
      throw new Error(`Could not give the "${memberRoleName}" role to ${failed} member(s) (the bot's role must be above it). Nothing was hidden, so nobody is locked out.`);
    }
  }

  let updated = 0;
  for (const { spec, category } of blueprintEntries()) {
    const channel = findChannel(guild, channelKey(spec.name), { voice: spec.type === 'voice' });
    if (!channel) continue;
    const overwrites = buildOverwrites(spec, {
      roleIds,
      everyoneId: guild.id,
      botId: me.id,
      gated: enabled && !isPublicChannel(spec, category),
    });
    try {
      await channel.permissionOverwrites.set(overwrites, `Verification gate ${enabled ? 'on' : 'off'}`);
      updated++;
    } catch (e) {
      log(`gate: could not update ${channel.name}:`, e.message);
    }
  }
  return { updated, granted };
}

/** The Verify button: hands out the Member role. Works whether or not the gate is on. */
export async function verifyMember(interaction) {
  const role = findRole(interaction.guild, memberRoleName);
  if (!role) return interaction.reply({ content: 'The Member role is missing. Please tell a staff member.', flags: MessageFlags.Ephemeral });
  if (interaction.member.roles.cache.has(role.id)) {
    return interaction.reply({ content: 'You are already verified. Enjoy the server!', flags: MessageFlags.Ephemeral });
  }
  await interaction.member.roles.add(role, 'Pressed Verify');
  return interaction.reply({ content: '✅ You are verified. Welcome to the community!', flags: MessageFlags.Ephemeral });
}
