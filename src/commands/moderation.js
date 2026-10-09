import { MessageFlags, PermissionFlagsBits as P, SlashCommandBuilder } from 'discord.js';
import { modLog } from '../modlog.js';

const NO_REASON = 'No reason given';

/**
 * Why this member must not be punished by the moderator, or null if it is fine.
 * Pure (works on plain objects) so the rules can be tested without Discord.
 */
export function checkTarget({ moderator, target, botId, ownerId }, action) {
  if (!target) return 'That user is not in this server.';
  if (target.id === moderator.id) return `You cannot ${action} yourself.`;
  if (target.id === botId) return `I will not ${action} myself.`;
  if (target.id === ownerId) return `You cannot ${action} the server owner.`;
  if (moderator.id !== ownerId && moderator.roles.highest.comparePositionTo(target.roles.highest) <= 0) {
    return 'That member has the same or a higher role than you.';
  }
  return null;
}

const guardTarget = (i, member, action) =>
  checkTarget({ moderator: i.member, target: member, botId: i.client.user.id, ownerId: i.guild.ownerId }, action);

const needs = (i, perm, label) =>
  i.memberPermissions.has(perm) ? null : i.reply({ content: `You need the ${label} permission.`, flags: MessageFlags.Ephemeral });

const tryDm = (user, text) => user.send(text).catch(() => null);

const userOption = (o) => o.setName('user').setDescription('Member').setRequired(true);
const reasonOption = (o) => o.setName('reason').setDescription('Reason (shown in the log)').setMaxLength(400);

export default [
  {
    category: 'Moderation',
    data: new SlashCommandBuilder()
      .setName('clear')
      .setDescription('Delete recent messages in this channel')
      .setDefaultMemberPermissions(P.ManageMessages)
      .addIntegerOption((o) => o.setName('amount').setDescription('How many (1-100)').setRequired(true).setMinValue(1).setMaxValue(100))
      .addUserOption((o) => o.setName('user').setDescription('Only this member\'s messages')),
    async run(i) {
      if (needs(i, P.ManageMessages, 'Manage Messages')) return;
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const amount = i.options.getInteger('amount', true);
      const user = i.options.getUser('user');
      let target = amount;
      if (user) {
        const recent = await i.channel.messages.fetch({ limit: 100 });
        target = [...recent.filter((m) => m.author.id === user.id).values()].slice(0, amount);
      }
      // messages older than 14 days cannot be bulk deleted; `true` skips them instead of failing
      const deleted = await i.channel.bulkDelete(target, true);
      await modLog(i.guild, { action: 'Clear', moderator: i.user, target: user, extra: `${deleted.size} message(s) in ${i.channel}` });
      return i.editReply(`🧹 Deleted ${deleted.size} message(s).`);
    },
  },
  {
    category: 'Moderation',
    data: new SlashCommandBuilder()
      .setName('timeout')
      .setDescription('Mute a member for a while')
      .setDefaultMemberPermissions(P.ModerateMembers)
      .addUserOption(userOption)
      .addIntegerOption((o) => o.setName('minutes').setDescription('Length in minutes (max 28 days)').setRequired(true).setMinValue(1).setMaxValue(40_320))
      .addStringOption(reasonOption),
    async run(i) {
      if (needs(i, P.ModerateMembers, 'Timeout Members')) return;
      const member = i.options.getMember('user');
      const problem = guardTarget(i, member, 'timeout') ?? (member.moderatable ? null : 'I cannot timeout that member (their role is above mine).');
      if (problem) return i.reply({ content: problem, flags: MessageFlags.Ephemeral });
      const minutes = i.options.getInteger('minutes', true);
      const reason = i.options.getString('reason') ?? NO_REASON;
      await member.timeout(minutes * 60_000, `${i.user.tag}: ${reason}`);
      await tryDm(member.user, `You were timed out in **${i.guild.name}** for ${minutes} minute(s). Reason: ${reason}`);
      await modLog(i.guild, { action: 'Timeout', moderator: i.user, target: member.user, reason, extra: `${minutes} minute(s)` });
      return i.reply({ content: `⏳ ${member} timed out for ${minutes} minute(s).`, flags: MessageFlags.Ephemeral });
    },
  },
  {
    category: 'Moderation',
    data: new SlashCommandBuilder()
      .setName('untimeout')
      .setDescription('Remove a member\'s timeout')
      .setDefaultMemberPermissions(P.ModerateMembers)
      .addUserOption(userOption),
    async run(i) {
      if (needs(i, P.ModerateMembers, 'Timeout Members')) return;
      const member = i.options.getMember('user');
      if (!member) return i.reply({ content: 'That user is not in this server.', flags: MessageFlags.Ephemeral });
      await member.timeout(null, `${i.user.tag}: untimeout`);
      await modLog(i.guild, { action: 'Untimeout', moderator: i.user, target: member.user });
      return i.reply({ content: `✅ Timeout removed from ${member}.`, flags: MessageFlags.Ephemeral });
    },
  },
  {
    category: 'Moderation',
    data: new SlashCommandBuilder()
      .setName('kick')
      .setDescription('Kick a member out of the server')
      .setDefaultMemberPermissions(P.KickMembers)
      .addUserOption(userOption)
      .addStringOption(reasonOption),
    async run(i) {
      if (needs(i, P.KickMembers, 'Kick Members')) return;
      const member = i.options.getMember('user');
      const problem = guardTarget(i, member, 'kick') ?? (member.kickable ? null : 'I cannot kick that member (their role is above mine).');
      if (problem) return i.reply({ content: problem, flags: MessageFlags.Ephemeral });
      const reason = i.options.getString('reason') ?? NO_REASON;
      await tryDm(member.user, `You were kicked from **${i.guild.name}**. Reason: ${reason}`);
      await member.kick(`${i.user.tag}: ${reason}`);
      await modLog(i.guild, { action: 'Kick', moderator: i.user, target: member.user, reason });
      return i.reply({ content: `👢 ${member.user.tag} was kicked.`, flags: MessageFlags.Ephemeral });
    },
  },
  {
    category: 'Moderation',
    data: new SlashCommandBuilder()
      .setName('ban')
      .setDescription('Ban a user (they do not have to be in the server)')
      .setDefaultMemberPermissions(P.BanMembers)
      .addUserOption(userOption)
      .addStringOption(reasonOption)
      .addIntegerOption((o) => o.setName('delete_days').setDescription('Also delete their messages from the last N days (0-7)').setMinValue(0).setMaxValue(7)),
    async run(i) {
      if (needs(i, P.BanMembers, 'Ban Members')) return;
      const user = i.options.getUser('user', true);
      const member = i.options.getMember('user'); // null when the user already left: allowed
      if (member) {
        const problem = guardTarget(i, member, 'ban') ?? (member.bannable ? null : 'I cannot ban that member (their role is above mine).');
        if (problem) return i.reply({ content: problem, flags: MessageFlags.Ephemeral });
      } else if (user.id === i.user.id || user.id === i.client.user.id) {
        return i.reply({ content: 'You cannot ban that user.', flags: MessageFlags.Ephemeral });
      }
      const reason = i.options.getString('reason') ?? NO_REASON;
      if (member) await tryDm(user, `You were banned from **${i.guild.name}**. Reason: ${reason}`);
      await i.guild.members.ban(user, {
        reason: `${i.user.tag}: ${reason}`,
        deleteMessageSeconds: (i.options.getInteger('delete_days') ?? 0) * 86_400,
      });
      await modLog(i.guild, { action: 'Ban', moderator: i.user, target: user, reason });
      return i.reply({ content: `🔨 ${user.tag} was banned.`, flags: MessageFlags.Ephemeral });
    },
  },
  {
    category: 'Moderation',
    data: new SlashCommandBuilder()
      .setName('unban')
      .setDescription('Unban a user by their ID')
      .setDefaultMemberPermissions(P.BanMembers)
      .addStringOption((o) => o.setName('user_id').setDescription('The user ID').setRequired(true).setMinLength(17).setMaxLength(20))
      .addStringOption(reasonOption),
    async run(i) {
      if (needs(i, P.BanMembers, 'Ban Members')) return;
      const id = i.options.getString('user_id', true).trim();
      if (!/^\d{17,20}$/.test(id)) return i.reply({ content: 'That is not a valid user ID.', flags: MessageFlags.Ephemeral });
      const reason = i.options.getString('reason') ?? NO_REASON;
      const ban = await i.guild.bans.fetch(id).catch(() => null);
      if (!ban) return i.reply({ content: 'That user is not banned.', flags: MessageFlags.Ephemeral });
      await i.guild.members.unban(id, `${i.user.tag}: ${reason}`);
      await modLog(i.guild, { action: 'Unban', moderator: i.user, target: ban.user, reason });
      return i.reply({ content: `✅ ${ban.user.tag} was unbanned.`, flags: MessageFlags.Ephemeral });
    },
  },
];
