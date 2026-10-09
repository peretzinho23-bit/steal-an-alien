import { EmbedBuilder, MessageFlags, SlashCommandBuilder, time } from 'discord.js';
import { COLOR } from '../content.js';

const base = () => new EmbedBuilder().setColor(COLOR);

export default [
  {
    category: 'General',
    data: new SlashCommandBuilder().setName('ping').setDescription('Check that the bot is alive'),
    run: (i) => i.reply({ content: `🏓 Pong! ${Math.round(i.client.ws.ping)}ms`, flags: MessageFlags.Ephemeral }),
  },
  {
    category: 'General',
    data: new SlashCommandBuilder().setName('serverinfo').setDescription('Show information about this server'),
    async run(i) {
      const { guild } = i;
      const owner = await guild.fetchOwner().catch(() => null);
      const channels = guild.channels.cache;
      return i.reply({
        embeds: [
          base()
            .setTitle(guild.name)
            .setThumbnail(guild.iconURL())
            .addFields(
              { name: 'Owner', value: owner ? `${owner}` : 'unknown', inline: true },
              { name: 'Members', value: `${guild.memberCount}`, inline: true },
              { name: 'Created', value: time(guild.createdAt, 'D'), inline: true },
              { name: 'Text channels', value: `${channels.filter((c) => c.isTextBased() && !c.isVoiceBased()).size}`, inline: true },
              { name: 'Voice channels', value: `${channels.filter((c) => c.isVoiceBased()).size}`, inline: true },
              { name: 'Roles', value: `${guild.roles.cache.size - 1}`, inline: true },
            ),
        ],
      });
    },
  },
  {
    category: 'General',
    data: new SlashCommandBuilder()
      .setName('userinfo')
      .setDescription('Show information about a member')
      .addUserOption((o) => o.setName('user').setDescription('Member (default: you)')),
    async run(i) {
      const user = i.options.getUser('user') ?? i.user;
      const member = i.guild.members.cache.get(user.id) ?? (await i.guild.members.fetch(user.id).catch(() => null));
      const roles = member ? member.roles.cache.filter((r) => r.id !== i.guild.id).sort((a, b) => b.position - a.position) : null;
      return i.reply({
        embeds: [
          base()
            .setTitle(user.tag)
            .setThumbnail(user.displayAvatarURL())
            .addFields(
              { name: 'ID', value: user.id, inline: true },
              { name: 'Account created', value: time(user.createdAt, 'D'), inline: true },
              ...(member?.joinedAt ? [{ name: 'Joined the server', value: time(member.joinedAt, 'D'), inline: true }] : []),
              ...(roles?.size ? [{ name: 'Roles', value: roles.map((r) => `${r}`).join(' ').slice(0, 1000) }] : []),
            ),
        ],
        allowedMentions: { parse: [] },
      });
    },
  },
  {
    category: 'General',
    data: new SlashCommandBuilder()
      .setName('avatar')
      .setDescription('Show a member\'s avatar')
      .addUserOption((o) => o.setName('user').setDescription('Member (default: you)')),
    run(i) {
      const user = i.options.getUser('user') ?? i.user;
      return i.reply({ embeds: [base().setTitle(`${user.displayName}'s avatar`).setImage(user.displayAvatarURL({ size: 512 }))] });
    },
  },
  {
    category: 'Fun',
    data: new SlashCommandBuilder().setName('coinflip').setDescription('Flip a coin'),
    run: (i) => i.reply(`🪙 ${Math.random() < 0.5 ? '**Heads**' : '**Tails**'}`),
  },
  {
    category: 'Fun',
    data: new SlashCommandBuilder()
      .setName('roll')
      .setDescription('Roll a dice')
      .addIntegerOption((o) => o.setName('sides').setDescription('Number of sides (default 6)').setMinValue(2).setMaxValue(1000)),
    run(i) {
      const sides = i.options.getInteger('sides') ?? 6;
      return i.reply(`🎲 d${sides}: **${1 + Math.floor(Math.random() * sides)}**`);
    },
  },
];

/** /help is built from the full registry, so it can never list a command that does not exist. */
export function makeHelp(getCommands) {
  return {
    category: 'General',
    data: new SlashCommandBuilder().setName('help').setDescription('List everything the bot can do'),
    run(i) {
      const groups = new Map();
      for (const c of getCommands()) {
        if (!groups.has(c.category)) groups.set(c.category, []);
        groups.get(c.category).push(`\`/${c.data.name}\` ${c.data.description}`);
      }
      const embed = base().setTitle('🤖 Commands');
      for (const [category, lines] of groups) embed.addFields({ name: category, value: lines.join('\n') });
      return i.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    },
  };
}
