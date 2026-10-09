import { EmbedBuilder, MessageFlags, PermissionFlagsBits as P, SlashCommandBuilder } from 'discord.js';
import { COLOR } from '../content.js';
import { modLog } from '../modlog.js';
import { closeTicket, isTicketChannel, ticketOwnerId } from '../tickets.js';
import { findChannel } from '../util.js';

const NUMBERS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];
const TICKET_MEMBER_PERMS = { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true };

const pollOption = (n, required) => (o) => o.setName(`option${n}`).setDescription(`Answer ${n}`).setRequired(required).setMaxLength(100);

export default [
  {
    category: 'Staff',
    data: new SlashCommandBuilder()
      .setName('announce')
      .setDescription('Post an announcement or a game update')
      .setDefaultMemberPermissions(P.ManageMessages)
      .addStringOption((o) =>
        o
          .setName('channel')
          .setDescription('Where to post')
          .setRequired(true)
          .addChoices({ name: 'announcements', value: 'announcements' }, { name: 'updates', value: 'updates' }),
      )
      .addStringOption((o) => o.setName('title').setDescription('Title').setRequired(true).setMaxLength(200))
      .addStringOption((o) => o.setName('message').setDescription('Text. Use \\n for a new line').setRequired(true).setMaxLength(3500))
      .addBooleanOption((o) => o.setName('ping').setDescription('Ping @everyone (default: no)')),
    async run(i) {
      if (!i.memberPermissions.has(P.ManageMessages)) return i.reply({ content: 'You need the Manage Messages permission.', flags: MessageFlags.Ephemeral });
      const target = findChannel(i.guild, i.options.getString('channel', true));
      if (!target) return i.reply({ content: 'That channel does not exist yet.', flags: MessageFlags.Ephemeral });
      const ping = i.options.getBoolean('ping') === true;
      const embed = new EmbedBuilder()
        .setColor(COLOR)
        .setTitle(i.options.getString('title', true))
        .setDescription(i.options.getString('message', true).replaceAll('\\n', '\n'))
        .setTimestamp()
        .setFooter({ text: `Posted by ${i.user.displayName}` });
      await target.send({ content: ping ? '@everyone' : undefined, embeds: [embed], allowedMentions: { parse: ping ? ['everyone'] : [] } });
      await modLog(i.guild, { action: 'Announcement', moderator: i.user, extra: `${embed.data.title} → ${target}` });
      return i.reply({ content: `Posted in ${target}.`, flags: MessageFlags.Ephemeral });
    },
  },
  {
    category: 'Staff',
    data: new SlashCommandBuilder()
      .setName('poll')
      .setDescription('Start a poll with 2-5 answers in this channel')
      .setDefaultMemberPermissions(P.ManageMessages)
      .addStringOption((o) => o.setName('question').setDescription('The question').setRequired(true).setMaxLength(250))
      .addStringOption(pollOption(1, true))
      .addStringOption(pollOption(2, true))
      .addStringOption(pollOption(3, false))
      .addStringOption(pollOption(4, false))
      .addStringOption(pollOption(5, false)),
    async run(i) {
      if (!i.memberPermissions.has(P.ManageMessages)) return i.reply({ content: 'You need the Manage Messages permission.', flags: MessageFlags.Ephemeral });
      const answers = [1, 2, 3, 4, 5].map((n) => i.options.getString(`option${n}`)).filter(Boolean);
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const message = await i.channel.send({
        embeds: [
          new EmbedBuilder()
            .setColor(COLOR)
            .setTitle(`📊 ${i.options.getString('question', true)}`)
            .setDescription(answers.map((a, n) => `${NUMBERS[n]} ${a}`).join('\n\n'))
            .setFooter({ text: `Poll by ${i.user.displayName}` }),
        ],
      });
      for (let n = 0; n < answers.length; n++) await message.react(NUMBERS[n]);
      return i.editReply('Poll posted.');
    },
  },
  {
    category: 'Staff',
    data: new SlashCommandBuilder()
      .setName('slowmode')
      .setDescription('Set the slowmode of a channel (0 turns it off)')
      .setDefaultMemberPermissions(P.ManageChannels)
      .addIntegerOption((o) => o.setName('seconds').setDescription('Seconds between messages (0-21600)').setRequired(true).setMinValue(0).setMaxValue(21_600))
      .addChannelOption((o) => o.setName('channel').setDescription('Channel (default: this one)')),
    async run(i) {
      if (!i.memberPermissions.has(P.ManageChannels)) return i.reply({ content: 'You need the Manage Channels permission.', flags: MessageFlags.Ephemeral });
      const channel = i.options.getChannel('channel') ?? i.channel;
      if (!channel.setRateLimitPerUser) return i.reply({ content: 'Slowmode only works in text channels.', flags: MessageFlags.Ephemeral });
      const seconds = i.options.getInteger('seconds', true);
      await channel.setRateLimitPerUser(seconds, `Slowmode by ${i.user.tag}`);
      await modLog(i.guild, { action: 'Slowmode', moderator: i.user, extra: `${channel}: ${seconds}s` });
      return i.reply({ content: seconds ? `🐌 Slowmode in ${channel}: ${seconds}s.` : `Slowmode is off in ${channel}.`, flags: MessageFlags.Ephemeral });
    },
  },
  {
    category: 'Tickets',
    data: new SlashCommandBuilder()
      .setName('ticket')
      .setDescription('Manage the ticket you are in')
      .setDefaultMemberPermissions(P.ManageMessages)
      .addSubcommand((s) =>
        s.setName('add').setDescription('Let another member into this ticket').addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true)),
      )
      .addSubcommand((s) =>
        s.setName('remove').setDescription('Remove a member from this ticket').addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true)),
      )
      .addSubcommand((s) => s.setName('close').setDescription('Close this ticket')),
    async run(i) {
      if (!i.memberPermissions.has(P.ManageMessages)) return i.reply({ content: 'You need the Manage Messages permission.', flags: MessageFlags.Ephemeral });
      if (!isTicketChannel(i.channel)) return i.reply({ content: 'Use this inside a ticket channel.', flags: MessageFlags.Ephemeral });
      const sub = i.options.getSubcommand();
      if (sub === 'close') return closeTicket(i);

      const user = i.options.getUser('user', true);
      if (sub === 'add') {
        await i.channel.permissionOverwrites.edit(user, TICKET_MEMBER_PERMS, { reason: `Added by ${i.user.tag}` });
        return i.reply(`➕ ${user} was added to this ticket.`);
      }
      if (user.id === ticketOwnerId(i.channel)) return i.reply({ content: 'You cannot remove the ticket owner. Close the ticket instead.', flags: MessageFlags.Ephemeral });
      await i.channel.permissionOverwrites.delete(user, `Removed by ${i.user.tag}`);
      return i.reply(`➖ ${user} was removed from this ticket.`);
    },
  },
];
