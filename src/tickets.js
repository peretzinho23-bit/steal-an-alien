import { AttachmentBuilder, ChannelType, MessageFlags, PermissionFlagsBits as P } from 'discord.js';
import { IDS, ticketWelcome } from './content.js';
import { findChannel, findRole, sleep } from './util.js';

const TOPIC_PREFIX = 'ticket:'; // the channel topic stores the owner id: "ticket:<userId>"
const CLOSE_DELAY_MS = 5000;

export const ticketOwnerId = (channel) => (channel.topic?.startsWith(TOPIC_PREFIX) ? channel.topic.slice(TOPIC_PREFIX.length) : null);
export const isTicketChannel = (channel) => ticketOwnerId(channel) !== null;
const isStaff = (member) => member.permissions.has(P.ManageMessages); // Moderator, Admin and Owner all have it

const safeName = (user) => `ticket-${user.username.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20) || user.id}`;

export async function openTicket(interaction) {
  const { guild, user } = interaction;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const existing = guild.channels.cache.find((c) => ticketOwnerId(c) === user.id);
  if (existing) return interaction.editReply(`You already have an open ticket: ${existing}`);

  const category = findChannel(guild, 'create-ticket')?.parent ?? null;
  const staffRoles = ['Admin', 'Moderator'].map((n) => findRole(guild, n)).filter(Boolean);
  const channel = await guild.channels.create({
    name: safeName(user),
    type: ChannelType.GuildText,
    parent: category?.id,
    topic: `${TOPIC_PREFIX}${user.id}`,
    permissionOverwrites: [
      { id: guild.id, deny: [P.ViewChannel] },
      { id: user.id, allow: [P.ViewChannel, P.SendMessages, P.AttachFiles, P.EmbedLinks, P.ReadMessageHistory] },
      ...staffRoles.map((r) => ({ id: r.id, allow: [P.ViewChannel, P.SendMessages, P.AttachFiles, P.ReadMessageHistory, P.ManageMessages] })),
      { id: interaction.client.user.id, allow: [P.ViewChannel, P.SendMessages, P.ManageChannels, P.ReadMessageHistory] },
    ],
    reason: `Ticket opened by ${user.tag}`,
  });
  await channel.send(ticketWelcome(user));
  return interaction.editReply(`Your ticket is ready: ${channel}`);
}

export async function closeTicket(interaction, { delayMs = CLOSE_DELAY_MS } = {}) {
  const { channel, guild, member } = interaction;
  const ownerId = ticketOwnerId(channel);
  if (!ownerId) return interaction.reply({ content: 'This is not a ticket channel.', flags: MessageFlags.Ephemeral });
  if (member.id !== ownerId && !isStaff(member)) {
    return interaction.reply({ content: 'Only the ticket owner or staff can close this ticket.', flags: MessageFlags.Ephemeral });
  }

  await interaction.reply(`🔒 Closing this ticket in ${delayMs / 1000} seconds...`);
  await logTranscript(guild, channel, member, ownerId);
  await sleep(delayMs);
  await channel.delete(`Ticket closed by ${member.user.tag}`);
}

async function logTranscript(guild, channel, closedBy, ownerId) {
  const logs = findChannel(guild, 'ticket-logs');
  if (!logs) return;
  try {
    const messages = [...(await channel.messages.fetch({ limit: 100 })).values()].reverse();
    const text = messages
      .map((m) => `[${m.createdAt.toISOString()}] ${m.author.tag}: ${m.content || '(embed/attachment)'}`)
      .join('\n');
    await logs.send({
      content: `📋 **${channel.name}** closed by ${closedBy} (ticket owner: <@${ownerId}>), ${messages.length} messages.`,
      files: [new AttachmentBuilder(Buffer.from(text || '(empty)', 'utf8'), { name: `${channel.name}.txt` })],
      allowedMentions: { parse: [] },
    });
  } catch (e) {
    console.error('Could not write the ticket transcript:', e.message);
  }
}

export const handleTicketButton = (interaction) =>
  interaction.customId === IDS.ticketOpen
    ? openTicket(interaction)
    : interaction.customId === IDS.ticketClose
      ? closeTicket(interaction)
      : null;
