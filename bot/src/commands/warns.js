import { EmbedBuilder, MessageFlags, PermissionFlagsBits as P, SlashCommandBuilder, time } from 'discord.js';
import { modLog } from '../modlog.js';
import { addTempBan, addWarn, applyEscalation, clearWarns, getWarns, removeWarn } from '../warns.js';
import { guardTarget, needs, NO_REASON, tryDm } from './moderation.js';

const eph = { flags: MessageFlags.Ephemeral };
const userOpt = (o) => o.setName('user').setDescription('Member').setRequired(true);
const DURATIONS = [
  ['1 hour', 60],
  ['6 hours', 360],
  ['1 day', 1440],
  ['3 days', 4320],
  ['7 days', 10_080],
  ['14 days', 20_160],
  ['30 days', 43_200],
];

export default [
  {
    category: 'Moderation',
    data: new SlashCommandBuilder()
      .setName('warn')
      .setDescription('Warn a member (punishments escalate automatically)')
      .setDefaultMemberPermissions(P.ModerateMembers)
      .addUserOption(userOpt)
      .addStringOption((o) => o.setName('reason').setDescription('Reason').setRequired(true).setMaxLength(400)),
    async run(i) {
      if (needs(i, P.ModerateMembers, 'Timeout Members')) return;
      const member = i.options.getMember('user');
      const problem = guardTarget(i, member, 'warn');
      if (problem) return i.reply({ content: problem, ...eph });
      await i.deferReply(eph);
      const reason = i.options.getString('reason', true);
      const { count } = await addWarn(i.guild.id, member.id, { by: { id: i.user.id, name: i.user.tag }, reason });
      await tryDm(member.user, `⚠️ You received a warning in **${i.guild.name}** (#${count}). Reason: ${reason}`);
      const outcome = await applyEscalation(i.guild, member.user, count);
      await modLog(i.guild, { action: `Warn #${count}`, moderator: i.user, target: member.user, reason, extra: outcome ?? undefined });
      return i.editReply(`⚠️ ${member} now has **${count}** warning(s).${outcome ? ` Automatic action: ${outcome}.` : ''}`);
    },
  },
  {
    category: 'Moderation',
    data: new SlashCommandBuilder()
      .setName('warnings')
      .setDescription('List a member\'s warnings')
      .setDefaultMemberPermissions(P.ModerateMembers)
      .addUserOption(userOpt),
    async run(i) {
      if (needs(i, P.ModerateMembers, 'Timeout Members')) return;
      const user = i.options.getUser('user', true);
      const list = await getWarns(i.guild.id, user.id);
      if (!list.length) return i.reply({ content: `${user.tag} has no warnings.`, ...eph });
      const lines = list.slice(-15).map((w) => `\`${w.id}\` ${time(Math.floor(w.at / 1000), 'd')} by ${w.by?.name ?? 'unknown'}: ${w.reason}`);
      return i.reply({
        embeds: [new EmbedBuilder().setColor(0xe67e22).setTitle(`Warnings for ${user.tag} (${list.length})`).setDescription(lines.join('\n').slice(0, 4000))],
        ...eph,
      });
    },
  },
  {
    category: 'Moderation',
    data: new SlashCommandBuilder()
      .setName('unwarn')
      .setDescription('Remove one warning (use the id from /warnings)')
      .setDefaultMemberPermissions(P.ModerateMembers)
      .addUserOption(userOpt)
      .addStringOption((o) => o.setName('id').setDescription('Warning id').setRequired(true).setMaxLength(20)),
    async run(i) {
      if (needs(i, P.ModerateMembers, 'Timeout Members')) return;
      const user = i.options.getUser('user', true);
      const left = await removeWarn(i.guild.id, user.id, i.options.getString('id', true).trim());
      if (left === null) return i.reply({ content: 'No warning with that id.', ...eph });
      await modLog(i.guild, { action: 'Unwarn', moderator: i.user, target: user, extra: `${left} warning(s) left` });
      return i.reply({ content: `Removed. ${user.tag} has ${left} warning(s) left.`, ...eph });
    },
  },
  {
    category: 'Moderation',
    data: new SlashCommandBuilder()
      .setName('clearwarns')
      .setDescription('Remove all of a member\'s warnings')
      .setDefaultMemberPermissions(P.ModerateMembers)
      .addUserOption(userOpt),
    async run(i) {
      if (needs(i, P.ModerateMembers, 'Timeout Members')) return;
      const user = i.options.getUser('user', true);
      const had = await clearWarns(i.guild.id, user.id);
      await modLog(i.guild, { action: 'Clear warnings', moderator: i.user, target: user, extra: `${had} removed` });
      return i.reply({ content: `Cleared ${had} warning(s) for ${user.tag}.`, ...eph });
    },
  },
  {
    category: 'Moderation',
    data: new SlashCommandBuilder()
      .setName('tempban')
      .setDescription('Ban a member for a set time, then unban automatically')
      .setDefaultMemberPermissions(P.BanMembers)
      .addUserOption(userOpt)
      .addIntegerOption((o) =>
        o.setName('duration').setDescription('How long').setRequired(true).addChoices(...DURATIONS.map(([name, value]) => ({ name, value }))),
      )
      .addStringOption((o) => o.setName('reason').setDescription('Reason').setMaxLength(400)),
    async run(i) {
      if (needs(i, P.BanMembers, 'Ban Members')) return;
      const member = i.options.getMember('user');
      const problem = guardTarget(i, member, 'ban') ?? (member.bannable ? null : 'I cannot ban that member (their role is above mine).');
      if (problem) return i.reply({ content: problem, ...eph });
      const minutes = i.options.getInteger('duration', true);
      const reason = i.options.getString('reason') ?? NO_REASON;
      const until = Date.now() + minutes * 60_000;
      await tryDm(member.user, `You were banned from **${i.guild.name}** for ${DURATIONS.find(([, v]) => v === minutes)?.[0]}. Reason: ${reason}`);
      await addTempBan({ guildId: i.guild.id, userId: member.id, until, by: i.user.id, reason });
      await i.guild.members.ban(member.id, { reason: `${i.user.tag}: ${reason} (temporary)` });
      await modLog(i.guild, { action: 'Tempban', moderator: i.user, target: member.user, reason, extra: `until ${time(Math.floor(until / 1000), 'f')}` });
      return i.reply({ content: `🔨 ${member.user.tag} is banned until ${time(Math.floor(until / 1000), 'f')}.`, ...eph });
    },
  },
];
