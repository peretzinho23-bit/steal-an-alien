import { EmbedBuilder, Events, time } from 'discord.js';
import { logChannel } from './modlog.js';
import { getSettings, runtime } from './runtime.js';

const log = (...args) => console.log(new Date().toISOString(), ...args);
const COLORS = { good: 0x57f287, bad: 0xed4245, info: 0x5865f2, warn: 0xfee75c };
const clip = (text, n = 900) => (text.length > n ? `${text.slice(0, n)}...` : text);

/** Tickets and temporary voice rooms come and go all day; logging them would drown the real events. */
const isNoisy = (channel) => Boolean(channel?.topic?.startsWith('ticket:') || runtime.tempRooms?.has(channel?.id));

const unix = (date) => Math.floor(date.getTime() / 1000);

export async function sendLog(guild, embed) {
  const channel = logChannel(guild);
  if (!channel) return false;
  await channel.send({ embeds: [embed.setTimestamp()], allowedMentions: { parse: [] } });
  return true;
}

const userLine = (user) => `${user} (${user.tag ?? user.username}, ${user.id})`;

/** Event handlers by name, kept pure-ish: each gets the discord.js arguments and returns an embed or null. */
export const formatters = {
  join: (member) =>
    new EmbedBuilder()
      .setColor(COLORS.good)
      .setTitle('📥 Member joined')
      .setDescription(userLine(member.user))
      .addFields(
        { name: 'Account created', value: time(unix(member.user.createdAt), 'R'), inline: true },
        { name: 'Members now', value: `${member.guild.memberCount}`, inline: true },
      ),

  leave: (member) =>
    new EmbedBuilder()
      .setColor(COLORS.bad)
      .setTitle('📤 Member left')
      .setDescription(userLine(member.user))
      .addFields(
        ...(member.joinedAt ? [{ name: 'Joined', value: time(unix(member.joinedAt), 'R'), inline: true }] : []),
        ...(member.roles?.cache?.size > 1
          ? [{ name: 'Roles', value: clip([...member.roles.cache.values()].filter((r) => r.id !== member.guild.id).map((r) => r.name).join(', '), 500), inline: false }]
          : []),
      ),

  messageDelete: (message) => {
    if (message.author?.bot || isNoisy(message.channel)) return null;
    const embed = new EmbedBuilder()
      .setColor(COLORS.warn)
      .setTitle('🗑️ Message deleted')
      .addFields({ name: 'Channel', value: `${message.channel}`, inline: true });
    if (message.author) embed.addFields({ name: 'Author', value: userLine(message.author), inline: true });
    embed.setDescription(message.content ? clip(message.content) : '*(content not available)*');
    if (message.attachments?.size) embed.addFields({ name: 'Attachments', value: `${message.attachments.size}`, inline: true });
    return embed;
  },

  messageUpdate: (before, after) => {
    if (after.author?.bot || isNoisy(after.channel)) return null;
    if (!before.content || !after.content || before.content === after.content) return null;
    return new EmbedBuilder()
      .setColor(COLORS.info)
      .setTitle('✏️ Message edited')
      .setDescription(`${after.channel} • [jump](${after.url})`)
      .addFields({ name: 'Before', value: clip(before.content, 1000) }, { name: 'After', value: clip(after.content, 1000) })
      .setFooter({ text: after.author ? `${after.author.tag} (${after.author.id})` : 'unknown author' });
  },

  messageBulkDelete: (messages, channel) =>
    isNoisy(channel) ? null : new EmbedBuilder().setColor(COLORS.warn).setTitle('🧹 Bulk delete').setDescription(`${messages.size} message(s) in ${channel}`),

  banAdd: (ban) =>
    new EmbedBuilder().setColor(COLORS.bad).setTitle('🔨 Member banned').setDescription(userLine(ban.user)).addFields(...(ban.reason ? [{ name: 'Reason', value: clip(ban.reason, 500) }] : [])),

  banRemove: (ban) => new EmbedBuilder().setColor(COLORS.good).setTitle('♻️ Member unbanned').setDescription(userLine(ban.user)),

  channelCreate: (c) => (isNoisy(c) ? null : new EmbedBuilder().setColor(COLORS.good).setTitle('➕ Channel created').setDescription(`${c} (${c.name})`)),
  channelDelete: (c) => (isNoisy(c) ? null : new EmbedBuilder().setColor(COLORS.bad).setTitle('➖ Channel deleted').setDescription(c.name)),
  channelRename: (before, after) =>
    before.name === after.name || isNoisy(after) ? null : new EmbedBuilder().setColor(COLORS.info).setTitle('✏️ Channel renamed').setDescription(`${before.name} -> ${after}`),

  roleCreate: (r) => new EmbedBuilder().setColor(COLORS.good).setTitle('➕ Role created').setDescription(r.name),
  roleDelete: (r) => new EmbedBuilder().setColor(COLORS.bad).setTitle('➖ Role deleted').setDescription(r.name),

  timeout: (before, after) => {
    const was = before.communicationDisabledUntilTimestamp;
    const now = after.communicationDisabledUntilTimestamp;
    if (was === now) return null;
    return now && now > Date.now()
      ? new EmbedBuilder().setColor(COLORS.warn).setTitle('⏳ Member timed out').setDescription(userLine(after.user)).addFields({ name: 'Until', value: time(Math.floor(now / 1000), 'f') })
      : new EmbedBuilder().setColor(COLORS.good).setTitle('✅ Timeout removed').setDescription(userLine(after.user));
  },

  voice: (before, after) => {
    if (before.channelId === after.channelId) return null;
    const m = after.member ?? before.member;
    if (!m || m.user.bot) return null;
    const what = !before.channelId ? `joined **${after.channel.name}**` : !after.channelId ? `left **${before.channel.name}**` : `moved **${before.channel.name}** -> **${after.channel.name}**`;
    return new EmbedBuilder().setColor(COLORS.info).setTitle('🎙️ Voice').setDescription(`${m} ${what}`);
  },
};

/** Subscribes to every event. Each one is gated by its switch in the dashboard settings and can never throw. */
export function registerLogs(client) {
  const watch = (event, flag, format, guildOf) =>
    client.on(event, async (...args) => {
      try {
        if (!getSettings().logs[flag]) return;
        const guild = guildOf(...args);
        if (!guild) return;
        const embed = format(...args);
        if (embed) await sendLog(guild, embed);
      } catch (e) {
        log(`log (${event}) failed:`, e.message);
      }
    });

  const g = (x) => x.guild;
  watch(Events.GuildMemberAdd, 'joins', formatters.join, g);
  watch(Events.GuildMemberRemove, 'leaves', formatters.leave, g);
  watch(Events.MessageDelete, 'messages', formatters.messageDelete, g);
  watch(Events.MessageUpdate, 'messages', formatters.messageUpdate, (before, after) => after.guild);
  watch(Events.MessageBulkDelete, 'messages', formatters.messageBulkDelete, (messages, channel) => channel.guild);
  watch(Events.GuildBanAdd, 'bans', formatters.banAdd, g);
  watch(Events.GuildBanRemove, 'bans', formatters.banRemove, g);
  watch(Events.GuildMemberUpdate, 'bans', formatters.timeout, (before, after) => after.guild);
  watch(Events.ChannelCreate, 'channels', formatters.channelCreate, g);
  watch(Events.ChannelDelete, 'channels', formatters.channelDelete, g);
  watch(Events.ChannelUpdate, 'channels', formatters.channelRename, (before, after) => after.guild);
  watch(Events.GuildRoleCreate, 'roles', formatters.roleCreate, g);
  watch(Events.GuildRoleDelete, 'roles', formatters.roleDelete, g);
  watch(Events.VoiceStateUpdate, 'voice', formatters.voice, (before, after) => after.guild);
}
