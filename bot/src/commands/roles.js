import { EmbedBuilder, MessageFlags, PermissionFlagsBits as P, SlashCommandBuilder, time } from 'discord.js';
import { modLog } from '../modlog.js';
import { confirmAction } from './channels.js';
import { parseHexColor } from './helpers.js';
import { needs } from './moderation.js';

const eph = { flags: MessageFlags.Ephemeral };
const roleOpt = (o, desc = 'The role') => o.setName('role').setDescription(desc).setRequired(true);
const userOpt = (o) => o.setName('user').setDescription('Member').setRequired(true);

/**
 * Why this person may not touch this role, or null. Plain objects in, so it is testable:
 *   actor: { id, highestPosition, isAdmin }, role: { id, position, managed, editable, isAdminRole }, guild: { id, ownerId }
 */
export function roleProblem({ actor, role, guild }) {
  if (role.id === guild.id) return 'You cannot change @everyone this way.';
  if (role.managed) return 'That role is managed by a bot or integration.';
  if (!role.editable) return 'That role is above my highest role. Move my role higher in Server Settings.';
  if (actor.id !== guild.ownerId && actor.highestPosition <= role.position) return 'That role is at or above your highest role.';
  if (role.isAdminRole && !actor.isAdmin) return 'Only an administrator can manage a role that has Administrator permission.';
  return null;
}

const check = (i, role) =>
  roleProblem({
    actor: { id: i.user.id, highestPosition: i.member.roles.highest.position, isAdmin: i.memberPermissions.has(P.Administrator) },
    role: { id: role.id, position: role.position, managed: role.managed, editable: role.editable, isAdminRole: role.permissions.has(P.Administrator) },
    guild: { id: i.guild.id, ownerId: i.guild.ownerId },
  });

const handlers = {
  async create(i) {
    const name = i.options.getString('name', true);
    const colorText = i.options.getString('color');
    const color = colorText ? parseHexColor(colorText) : null;
    if (colorText && color === null) return i.reply({ content: 'Colour must look like #ff8800.', ...eph });
    await i.deferReply(eph);
    const role = await i.guild.roles.create({
      name,
      colors: color === null ? undefined : { primaryColor: color },
      hoist: i.options.getBoolean('hoist') ?? false,
      mentionable: i.options.getBoolean('mentionable') ?? false,
      reason: `Created by ${i.user.tag}`,
    });
    await modLog(i.guild, { action: 'Role created', moderator: i.user, extra: role.name });
    return i.editReply(`Created ${role}. It has no permissions; set them in Server Settings.`);
  },

  async delete(i) {
    const role = i.options.getRole('role', true);
    const problem = check(i, role);
    if (problem) return i.reply({ content: problem, ...eph });
    if (!(await confirmAction(i, `Delete the role **${role.name}**? Its ${role.members.size} member(s) lose it.`))) return;
    await role.delete(`Deleted by ${i.user.tag}`);
    await modLog(i.guild, { action: 'Role deleted', moderator: i.user, extra: role.name });
    return i.editReply({ content: `Deleted **${role.name}**.`, components: [] });
  },

  async add(i) {
    const role = i.options.getRole('role', true);
    const member = i.options.getMember('user');
    const problem = check(i, role) ?? (member ? null : 'That user is not in this server.');
    if (problem) return i.reply({ content: problem, ...eph });
    await member.roles.add(role, `By ${i.user.tag}`);
    await modLog(i.guild, { action: 'Role added', moderator: i.user, target: member.user, extra: role.name });
    return i.reply({ content: `Gave **${role.name}** to ${member}.`, ...eph });
  },

  async remove(i) {
    const role = i.options.getRole('role', true);
    const member = i.options.getMember('user');
    const problem = check(i, role) ?? (member ? null : 'That user is not in this server.');
    if (problem) return i.reply({ content: problem, ...eph });
    await member.roles.remove(role, `By ${i.user.tag}`);
    await modLog(i.guild, { action: 'Role removed', moderator: i.user, target: member.user, extra: role.name });
    return i.reply({ content: `Removed **${role.name}** from ${member}.`, ...eph });
  },

  async color(i) {
    const role = i.options.getRole('role', true);
    const problem = check(i, role);
    if (problem) return i.reply({ content: problem, ...eph });
    const color = parseHexColor(i.options.getString('hex', true));
    if (color === null) return i.reply({ content: 'Colour must look like #ff8800.', ...eph });
    await role.setColors({ primaryColor: color }, `By ${i.user.tag}`);
    return i.reply({ content: `Colour of **${role.name}** updated.`, ...eph });
  },

  async info(i) {
    const role = i.options.getRole('role', true);
    return i.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(role.color || 0x99aab5)
          .setTitle(role.name)
          .addFields(
            { name: 'ID', value: role.id, inline: true },
            { name: 'Members', value: `${role.members.size}`, inline: true },
            { name: 'Position', value: `${role.position}`, inline: true },
            { name: 'Hoisted', value: role.hoist ? 'yes' : 'no', inline: true },
            { name: 'Mentionable', value: role.mentionable ? 'yes' : 'no', inline: true },
            { name: 'Created', value: time(role.createdAt, 'D'), inline: true },
          ),
      ],
      ...eph,
    });
  },
};

export default [
  {
    category: 'Rooms',
    data: new SlashCommandBuilder()
      .setName('role')
      .setDescription('Create and manage roles (staff)')
      .setDefaultMemberPermissions(P.ManageRoles)
      .addSubcommand((s) =>
        s
          .setName('create')
          .setDescription('Create a role')
          .addStringOption((o) => o.setName('name').setDescription('Name').setRequired(true).setMaxLength(100))
          .addStringOption((o) => o.setName('color').setDescription('Colour, for example #ff8800'))
          .addBooleanOption((o) => o.setName('hoist').setDescription('Show separately in the member list'))
          .addBooleanOption((o) => o.setName('mentionable').setDescription('Anyone can @mention it')),
      )
      .addSubcommand((s) => s.setName('delete').setDescription('Delete a role (asks to confirm)').addRoleOption((o) => roleOpt(o)))
      .addSubcommand((s) => s.setName('add').setDescription('Give a role to a member').addUserOption(userOpt).addRoleOption((o) => roleOpt(o)))
      .addSubcommand((s) => s.setName('remove').setDescription('Take a role from a member').addUserOption(userOpt).addRoleOption((o) => roleOpt(o)))
      .addSubcommand((s) =>
        s.setName('color').setDescription('Change a role\'s colour').addRoleOption((o) => roleOpt(o)).addStringOption((o) => o.setName('hex').setDescription('Colour, for example #ff8800').setRequired(true)),
      )
      .addSubcommand((s) => s.setName('info').setDescription('Show details about a role').addRoleOption((o) => roleOpt(o))),
    async run(i) {
      if (needs(i, P.ManageRoles, 'Manage Roles')) return;
      return handlers[i.options.getSubcommand()](i);
    },
  },
  {
    category: 'Rooms',
    data: new SlashCommandBuilder()
      .setName('nick')
      .setDescription('Change or reset a member\'s nickname')
      .setDefaultMemberPermissions(P.ManageNicknames)
      .addUserOption(userOpt)
      .addStringOption((o) => o.setName('nickname').setDescription('New nickname (leave empty to reset)').setMaxLength(32)),
    async run(i) {
      if (needs(i, P.ManageNicknames, 'Manage Nicknames')) return;
      const member = i.options.getMember('user');
      if (!member) return i.reply({ content: 'That user is not in this server.', ...eph });
      if (!member.manageable) return i.reply({ content: 'I cannot change that member\'s nickname (their role is above mine, or they own the server).', ...eph });
      if (member.id !== i.user.id && i.user.id !== i.guild.ownerId && i.member.roles.highest.comparePositionTo(member.roles.highest) <= 0) {
        return i.reply({ content: 'That member has the same or a higher role than you.', ...eph });
      }
      const nickname = i.options.getString('nickname')?.trim() || null;
      await member.setNickname(nickname, `By ${i.user.tag}`);
      await modLog(i.guild, { action: 'Nickname', moderator: i.user, target: member.user, extra: nickname ?? '(reset)' });
      return i.reply({ content: nickname ? `Nickname set to **${nickname}**.` : 'Nickname reset.', ...eph });
    },
  },
];
