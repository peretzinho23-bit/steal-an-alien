import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits as P,
  SlashCommandBuilder,
  time,
} from 'discord.js';
import { ROLES } from '../blueprint.js';
import { everyoneSendWhenOpen, everyoneViewWhenShown, getLockdown, lockdownOff, lockdownOn, specFor } from '../lockdown.js';
import { modLog } from '../modlog.js';
import { buildOverwrites } from '../overwrites.js';
import { channelTypeLabel } from './helpers.js';
import { needs } from './moderation.js';

const eph = { flags: MessageFlags.Ephemeral };
const GROUP_PERM = { name: 'Manage Channels', bit: P.ManageChannels };

const chanOpt = (o, desc = 'The channel') => o.setName('channel').setDescription(desc).setRequired(true);
const TYPE_MAP = { text: ChannelType.GuildText, voice: ChannelType.GuildVoice, category: ChannelType.GuildCategory };

function roleIds(guild) {
  return Object.fromEntries(ROLES.map((r) => [r.key, guild.roles.cache.find((role) => role.name === r.name)?.id]).filter(([, id]) => id));
}

/** chat = everyone talks, read = everyone reads, staff = Moderator/Admin only, hidden = Admin only. */
function overwritesFor(guild, access, botId) {
  const ctx = { roleIds: roleIds(guild), everyoneId: guild.id, botId };
  if (access === 'hidden') return [{ id: guild.id, deny: [P.ViewChannel] }, { id: botId, allow: [P.ViewChannel, P.SendMessages, P.ManageChannels] }];
  return buildOverwrites({ access }, ctx);
}

/**
 * Asks the same person to confirm with a button. Returns true when confirmed within 30 seconds.
 * The interaction is left acknowledged, so the caller finishes with editReply().
 */
export async function confirmAction(i, text) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('confirm:yes').setLabel('Confirm').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('confirm:no').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );
  await i.reply({ content: text, components: [row], ...eph });
  const message = await i.fetchReply();
  try {
    const click = await message.awaitMessageComponent({ filter: (c) => c.user.id === i.user.id, time: 30_000 });
    await click.update({ content: click.customId === 'confirm:yes' ? 'Working...' : 'Cancelled.', components: [] });
    return click.customId === 'confirm:yes';
  } catch {
    await i.editReply({ content: 'No answer, cancelled.', components: [] }).catch(() => {});
    return false;
  }
}

const handlers = {
  async create(i) {
    const name = i.options.getString('name', true);
    const type = TYPE_MAP[i.options.getString('type', true)];
    const access = i.options.getString('access') ?? 'chat';
    const parent = i.options.getChannel('category');
    await i.deferReply(eph);
    const channel = await i.guild.channels.create({
      name,
      type,
      parent: type === ChannelType.GuildCategory ? undefined : parent?.id,
      permissionOverwrites: overwritesFor(i.guild, access, i.client.user.id),
      reason: `Created by ${i.user.tag}`,
    });
    await modLog(i.guild, { action: 'Channel created', moderator: i.user, extra: `${channel.name} (${access})` });
    return i.editReply(`Created ${channel}.`);
  },

  async delete(i) {
    const channel = i.options.getChannel('channel', true);
    const core = specFor(channel);
    const ok = await confirmAction(i, `Delete **${channel.name}** for good?${core ? ' This is a core server channel (the bot will recreate it empty on its next start).' : ''}`);
    if (!ok) return;
    await channel.delete(`Deleted by ${i.user.tag}`);
    await modLog(i.guild, { action: 'Channel deleted', moderator: i.user, extra: channel.name });
    return i.editReply({ content: `Deleted **${channel.name}**.`, components: [] });
  },

  async rename(i) {
    const channel = i.options.getChannel('channel', true);
    const old = channel.name;
    await channel.setName(i.options.getString('name', true), `Renamed by ${i.user.tag}`);
    await modLog(i.guild, { action: 'Channel renamed', moderator: i.user, extra: `${old} -> ${channel.name}` });
    return i.reply({ content: `Renamed to ${channel}.`, ...eph });
  },

  async topic(i) {
    const channel = i.options.getChannel('channel', true);
    if (!channel.setTopic) return i.reply({ content: 'That channel type has no topic.', ...eph });
    await channel.setTopic(i.options.getString('text', true), `Topic by ${i.user.tag}`);
    return i.reply({ content: `Topic updated in ${channel}.`, ...eph });
  },

  async move(i) {
    const channel = i.options.getChannel('channel', true);
    const category = i.options.getChannel('category', true);
    await channel.setParent(category.id, { lockPermissions: false, reason: `Moved by ${i.user.tag}` });
    return i.reply({ content: `Moved ${channel} to **${category.name}**.`, ...eph });
  },

  async clone(i) {
    const channel = i.options.getChannel('channel', true);
    const copy = await channel.clone({ name: i.options.getString('name') ?? undefined, reason: `Cloned by ${i.user.tag}` });
    return i.reply({ content: `Cloned to ${copy}.`, ...eph });
  },

  async hide(i) {
    const channel = i.options.getChannel('channel', true);
    await channel.permissionOverwrites.edit(i.guild.id, { ViewChannel: false }, { reason: `Hidden by ${i.user.tag}` });
    await modLog(i.guild, { action: 'Channel hidden', moderator: i.user, extra: channel.name });
    return i.reply({ content: `${channel} is hidden from @everyone.`, ...eph });
  },

  async show(i) {
    const channel = i.options.getChannel('channel', true);
    await channel.permissionOverwrites.edit(i.guild.id, { ViewChannel: everyoneViewWhenShown(channel) }, { reason: `Shown by ${i.user.tag}` });
    return i.reply({ content: `${channel} is visible again.`, ...eph });
  },

  async lock(i) {
    const channel = i.options.getChannel('channel', true);
    const bits = channel.isVoiceBased() ? { Connect: false } : { SendMessages: false, AddReactions: false };
    await channel.permissionOverwrites.edit(i.guild.id, bits, { reason: `Locked by ${i.user.tag}` });
    await modLog(i.guild, { action: 'Channel locked', moderator: i.user, extra: channel.name });
    return i.reply({ content: `🔒 ${channel} is locked.`, ...eph });
  },

  async unlock(i) {
    const channel = i.options.getChannel('channel', true);
    const open = everyoneSendWhenOpen(channel);
    const bits = channel.isVoiceBased() ? { Connect: null } : { SendMessages: open, AddReactions: null };
    await channel.permissionOverwrites.edit(i.guild.id, bits, { reason: `Unlocked by ${i.user.tag}` });
    await modLog(i.guild, { action: 'Channel unlocked', moderator: i.user, extra: channel.name });
    return i.reply({ content: open === false ? `${channel} is back to read-only (that is its normal state).` : `🔓 ${channel} is unlocked.`, ...eph });
  },

  async info(i) {
    const c = i.options.getChannel('channel', true);
    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle(c.name)
      .addFields(
        { name: 'Type', value: channelTypeLabel(c.type), inline: true },
        { name: 'ID', value: c.id, inline: true },
        { name: 'Category', value: c.parent?.name ?? '-', inline: true },
        { name: 'Created', value: time(c.createdAt, 'D'), inline: true },
        ...(c.topic ? [{ name: 'Topic', value: c.topic.slice(0, 1000) }] : []),
        ...(c.rateLimitPerUser ? [{ name: 'Slowmode', value: `${c.rateLimitPerUser}s`, inline: true }] : []),
      );
    return i.reply({ embeds: [embed], ...eph });
  },
};

export default [
  {
    category: 'Rooms',
    data: new SlashCommandBuilder()
      .setName('channel')
      .setDescription('Create and manage channels (staff)')
      .setDefaultMemberPermissions(P.ManageChannels)
      .addSubcommand((s) =>
        s
          .setName('create')
          .setDescription('Create a channel or category')
          .addStringOption((o) => o.setName('name').setDescription('Name').setRequired(true).setMinLength(1).setMaxLength(90))
          .addStringOption((o) =>
            o.setName('type').setDescription('Kind of channel').setRequired(true).addChoices({ name: 'text', value: 'text' }, { name: 'voice', value: 'voice' }, { name: 'category', value: 'category' }),
          )
          .addStringOption((o) =>
            o
              .setName('access')
              .setDescription('Who can use it (default: everyone chats)')
              .addChoices(
                { name: 'everyone chats', value: 'chat' },
                { name: 'everyone reads, staff writes', value: 'read' },
                { name: 'staff only (Moderator + Admin)', value: 'staff' },
                { name: 'admins only', value: 'hidden' },
              ),
          )
          .addChannelOption((o) => o.setName('category').setDescription('Put it in this category').addChannelTypes(ChannelType.GuildCategory)),
      )
      .addSubcommand((s) => s.setName('delete').setDescription('Delete a channel (asks to confirm)').addChannelOption((o) => chanOpt(o)))
      .addSubcommand((s) =>
        s.setName('rename').setDescription('Rename a channel').addChannelOption((o) => chanOpt(o)).addStringOption((o) => o.setName('name').setDescription('New name').setRequired(true).setMaxLength(90)),
      )
      .addSubcommand((s) =>
        s.setName('topic').setDescription('Set a text channel\'s topic').addChannelOption((o) => chanOpt(o)).addStringOption((o) => o.setName('text').setDescription('Topic').setRequired(true).setMaxLength(1000)),
      )
      .addSubcommand((s) =>
        s
          .setName('move')
          .setDescription('Move a channel to another category')
          .addChannelOption((o) => chanOpt(o))
          .addChannelOption((o) => o.setName('category').setDescription('Target category').setRequired(true).addChannelTypes(ChannelType.GuildCategory)),
      )
      .addSubcommand((s) =>
        s.setName('clone').setDescription('Duplicate a channel with its permissions').addChannelOption((o) => chanOpt(o)).addStringOption((o) => o.setName('name').setDescription('Name of the copy').setMaxLength(90)),
      )
      .addSubcommand((s) => s.setName('hide').setDescription('Hide a channel from @everyone').addChannelOption((o) => chanOpt(o)))
      .addSubcommand((s) => s.setName('show').setDescription('Make a hidden channel visible again').addChannelOption((o) => chanOpt(o)))
      .addSubcommand((s) => s.setName('lock').setDescription('Stop @everyone from writing in a channel').addChannelOption((o) => chanOpt(o)))
      .addSubcommand((s) => s.setName('unlock').setDescription('Let @everyone write again').addChannelOption((o) => chanOpt(o)))
      .addSubcommand((s) => s.setName('info').setDescription('Show details about a channel').addChannelOption((o) => chanOpt(o))),
    async run(i) {
      if (needs(i, GROUP_PERM.bit, GROUP_PERM.name)) return;
      return handlers[i.options.getSubcommand()](i);
    },
  },
  {
    category: 'Rooms',
    data: new SlashCommandBuilder()
      .setName('lockdown')
      .setDescription('Emergency: lock public chat and pause invites (admins)')
      .setDefaultMemberPermissions(P.ManageGuild)
      .addSubcommand((s) =>
        s
          .setName('on')
          .setDescription('Lock the server')
          .addIntegerOption((o) => o.setName('minutes').setDescription('Auto-unlock after (default 15)').setMinValue(1).setMaxValue(1440)),
      )
      .addSubcommand((s) => s.setName('off').setDescription('End the lockdown now'))
      .addSubcommand((s) => s.setName('status').setDescription('Is the server locked?')),
    async run(i) {
      if (needs(i, P.ManageGuild, 'Manage Server')) return;
      const sub = i.options.getSubcommand();
      if (sub === 'status') {
        const state = await getLockdown();
        return i.reply({ content: state ? `🔒 Locked until ${time(Math.floor(state.until / 1000), 'R')}.` : 'Not in lockdown.', ...eph });
      }
      await i.deferReply(eph);
      if (sub === 'on') {
        const minutes = i.options.getInteger('minutes') ?? 15;
        const r = await lockdownOn(i.guild, { minutes, by: i.user, reason: `Lockdown by ${i.user.tag}` });
        return i.editReply(`🔒 Locked ${r.locked} channel(s) for ${minutes} min. Invites ${r.invitesPaused ? 'paused' : 'could NOT be paused'}.`);
      }
      const r = await lockdownOff(i.guild, { by: i.user, reason: `Lockdown ended by ${i.user.tag}` });
      return i.editReply(r.wasLocked ? `🔓 Reopened ${r.opened} channel(s).` : `Nothing was locked, but I reopened ${r.opened} chat channel(s) to be safe.`);
    },
  },
];
