import { EmbedBuilder, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { RANKS } from '../blueprint.js';
import { COLOR } from '../content.js';
import { modLog } from '../modlog.js';
import { levelFromXp, nextRank, progressBar, rankForLevel, totalXpForLevel } from '../levels/math.js';
import { MESSAGE_COOLDOWN_MS, VOICE_XP } from '../levels/system.js';

const PAGE_SIZE = 10;
const MEDALS = ['🥇', '🥈', '🥉'];
const fmt = (n) => n.toLocaleString('en-US');

export default [
  {
    category: 'Ranks',
    data: new SlashCommandBuilder()
      .setName('rank')
      .setDescription('Show your level, rank and XP')
      .addUserOption((o) => o.setName('user').setDescription('Member (default: you)')),
    run(i) {
      const user = i.options.getUser('user') ?? i.user;
      if (user.bot) return i.reply({ content: 'Bots do not earn XP.', flags: MessageFlags.Ephemeral });
      const { store } = i.client.levels;
      const entry = store.get(i.guild.id, user.id);
      const { level, current, needed } = levelFromXp(entry.xp);
      const rank = rankForLevel(level);
      const next = nextRank(level);
      const place = store.position(i.guild.id, user.id);
      const total = store.ranking(i.guild.id).length;
      return i.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(rank?.color ?? COLOR)
            .setAuthor({ name: user.displayName, iconURL: user.displayAvatarURL() })
            .setTitle(rank ? rank.name : 'Unranked')
            .setDescription(`${progressBar(current, needed)}\n**${fmt(current)} / ${fmt(needed)} XP** to level ${level + 1}`)
            .addFields(
              { name: 'Level', value: `${level}`, inline: true },
              { name: 'Total XP', value: fmt(entry.xp), inline: true },
              { name: 'Server place', value: place ? `#${place} of ${total}` : '-', inline: true },
              { name: 'Messages counted', value: fmt(entry.messages), inline: true },
              {
                name: 'Next rank',
                value: next ? `${next.name} at level ${next.level} (${fmt(totalXpForLevel(next.level) - entry.xp)} XP to go)` : 'You are at the top!',
              },
            ),
        ],
      });
    },
  },
  {
    category: 'Ranks',
    data: new SlashCommandBuilder()
      .setName('leaderboard')
      .setDescription('Show the top members by XP')
      .addIntegerOption((o) => o.setName('page').setDescription('Page number').setMinValue(1)),
    run(i) {
      const { store } = i.client.levels;
      const ranking = store.ranking(i.guild.id);
      if (!ranking.length) return i.reply({ content: 'Nobody has earned XP yet. Start chatting!', flags: MessageFlags.Ephemeral });
      const pages = Math.ceil(ranking.length / PAGE_SIZE);
      const page = Math.min(i.options.getInteger('page') ?? 1, pages);
      const start = (page - 1) * PAGE_SIZE;
      const lines = ranking.slice(start, start + PAGE_SIZE).map(([id, e], n) => {
        const place = start + n + 1;
        return `${MEDALS[place - 1] ?? `**${place}.**`} <@${id}> • level ${levelFromXp(e.xp).level} • ${fmt(e.xp)} XP`;
      });
      return i.reply({
        embeds: [new EmbedBuilder().setColor(COLOR).setTitle('🏆 Leaderboard').setDescription(lines.join('\n')).setFooter({ text: `Page ${page}/${pages}` })],
        allowedMentions: { parse: [] },
      });
    },
  },
  {
    category: 'Ranks',
    data: new SlashCommandBuilder().setName('ranks').setDescription('Show all ranks and how to earn XP'),
    run(i) {
      const roleOf = (name) => i.guild.roles.cache.find((r) => r.name === name);
      const tiers = RANKS.map((r) => `${roleOf(r.name) ?? `**${r.name}**`} - level ${r.level} (${fmt(totalXpForLevel(r.level))} XP)`);
      return i.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(COLOR)
            .setTitle('🛸 Ranks')
            .setDescription(tiers.join('\n'))
            .addFields({
              name: 'How to earn XP',
              value:
                `💬 Chat: 15-25 XP, once every ${MESSAGE_COOLDOWN_MS / 1000} seconds\n` +
                `🎙️ Voice: ${VOICE_XP} XP per minute when you are with at least one other person\n` +
                'Spamming does not help: the cooldown is the same for everyone.',
            }),
        ],
        allowedMentions: { parse: [] },
      });
    },
  },
  {
    category: 'Staff',
    data: new SlashCommandBuilder()
      .setName('xp')
      .setDescription('Change a member\'s XP (admins)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((s) =>
        s
          .setName('add')
          .setDescription('Add XP (use a negative number to remove)')
          .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
          .addIntegerOption((o) => o.setName('amount').setDescription('XP').setRequired(true).setMinValue(-1_000_000).setMaxValue(1_000_000)),
      )
      .addSubcommand((s) =>
        s
          .setName('set')
          .setDescription('Set the total XP')
          .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
          .addIntegerOption((o) => o.setName('amount').setDescription('XP').setRequired(true).setMinValue(0).setMaxValue(10_000_000)),
      )
      .addSubcommand((s) =>
        s.setName('reset').setDescription('Reset a member to 0 XP').addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true)),
      ),
    async run(i) {
      if (!i.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
        return i.reply({ content: 'You need the Manage Server permission.', flags: MessageFlags.Ephemeral });
      }
      const sub = i.options.getSubcommand();
      const user = i.options.getUser('user', true);
      if (user.bot) return i.reply({ content: 'Bots do not earn XP.', flags: MessageFlags.Ephemeral });
      await i.deferReply({ flags: MessageFlags.Ephemeral });

      const { store } = i.client.levels;
      const amount = i.options.getInteger('amount');
      if (sub === 'add') store.add(i.guild.id, user.id, amount);
      else if (sub === 'set') store.set(i.guild.id, user.id, amount);
      else store.reset(i.guild.id, user.id);

      const xp = store.get(i.guild.id, user.id).xp;
      const { level } = levelFromXp(xp);
      const member = await i.guild.members.fetch(user.id).catch(() => null);
      if (member) await i.client.levels.syncRank(member, level);
      await modLog(i.guild, { action: `XP ${sub}`, moderator: i.user, target: user, extra: `${sub === 'reset' ? 'reset' : amount} → now ${fmt(xp)} XP (level ${level})` });
      return i.editReply(`${user} now has **${fmt(xp)} XP** (level ${level}).`);
    },
  },
];
