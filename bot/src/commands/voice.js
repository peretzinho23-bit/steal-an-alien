import { ChannelType, MessageFlags, PermissionFlagsBits as P, SlashCommandBuilder } from 'discord.js';
import { modLog } from '../modlog.js';
import { needs } from './moderation.js';

const eph = { flags: MessageFlags.Ephemeral };
const VOICE = [ChannelType.GuildVoice, ChannelType.GuildStageVoice];
const userOpt = (o) => o.setName('user').setDescription('Member in a voice channel').setRequired(true);
const voiceOpt = (name, desc) => (o) => o.setName(name).setDescription(desc).setRequired(true).addChannelTypes(...VOICE);

/** Which permission each sub-command needs. */
const PERM = {
  move: [P.MoveMembers, 'Move Members'],
  moveall: [P.MoveMembers, 'Move Members'],
  disconnect: [P.MoveMembers, 'Move Members'],
  disconnectall: [P.MoveMembers, 'Move Members'],
  mute: [P.MuteMembers, 'Mute Members'],
  unmute: [P.MuteMembers, 'Mute Members'],
  deafen: [P.DeafenMembers, 'Deafen Members'],
  undeafen: [P.DeafenMembers, 'Deafen Members'],
  limit: [P.ManageChannels, 'Manage Channels'],
};

/** The member, but only if they are in a voice channel; otherwise replies with an error and returns null. */
async function inVoice(i) {
  const member = i.options.getMember('user');
  if (!member) {
    await i.reply({ content: 'That user is not in this server.', ...eph });
    return null;
  }
  if (!member.voice.channelId) {
    await i.reply({ content: `${member.displayName} is not in a voice channel.`, ...eph });
    return null;
  }
  return member;
}

const handlers = {
  async move(i) {
    const member = await inVoice(i);
    if (!member) return;
    const to = i.options.getChannel('channel', true);
    await member.voice.setChannel(to, `Moved by ${i.user.tag}`);
    return i.reply({ content: `Moved ${member.displayName} to **${to.name}**.`, ...eph });
  },

  async moveall(i) {
    const from = i.options.getChannel('from', true);
    const to = i.options.getChannel('to', true);
    if (from.id === to.id) return i.reply({ content: 'Pick two different channels.', ...eph });
    await i.deferReply(eph);
    let moved = 0;
    for (const member of from.members.values()) {
      await member.voice.setChannel(to, `Moved by ${i.user.tag}`).then(() => moved++).catch(() => {});
    }
    await modLog(i.guild, { action: 'Voice: move all', moderator: i.user, extra: `${from.name} -> ${to.name} (${moved})` });
    return i.editReply(`Moved ${moved} member(s) to **${to.name}**.`);
  },

  async disconnect(i) {
    const member = await inVoice(i);
    if (!member) return;
    await member.voice.disconnect(`By ${i.user.tag}`);
    await modLog(i.guild, { action: 'Voice: disconnect', moderator: i.user, target: member.user });
    return i.reply({ content: `Disconnected ${member.displayName}.`, ...eph });
  },

  async disconnectall(i) {
    const channel = i.options.getChannel('channel', true);
    await i.deferReply(eph);
    let n = 0;
    for (const member of channel.members.values()) await member.voice.disconnect(`By ${i.user.tag}`).then(() => n++).catch(() => {});
    await modLog(i.guild, { action: 'Voice: disconnect all', moderator: i.user, extra: `${channel.name} (${n})` });
    return i.editReply(`Disconnected ${n} member(s).`);
  },

  async mute(i) {
    const member = await inVoice(i);
    if (!member) return;
    await member.voice.setMute(true, `By ${i.user.tag}`);
    return i.reply({ content: `${member.displayName} is server-muted.`, ...eph });
  },

  async unmute(i) {
    const member = await inVoice(i);
    if (!member) return;
    await member.voice.setMute(false, `By ${i.user.tag}`);
    return i.reply({ content: `${member.displayName} is unmuted.`, ...eph });
  },

  async deafen(i) {
    const member = await inVoice(i);
    if (!member) return;
    await member.voice.setDeaf(true, `By ${i.user.tag}`);
    return i.reply({ content: `${member.displayName} is server-deafened.`, ...eph });
  },

  async undeafen(i) {
    const member = await inVoice(i);
    if (!member) return;
    await member.voice.setDeaf(false, `By ${i.user.tag}`);
    return i.reply({ content: `${member.displayName} is undeafened.`, ...eph });
  },

  async limit(i) {
    const channel = i.options.getChannel('channel', true);
    const n = i.options.getInteger('users', true);
    await channel.setUserLimit(n, `By ${i.user.tag}`);
    return i.reply({ content: n ? `**${channel.name}** is limited to ${n} user(s).` : `**${channel.name}** has no user limit.`, ...eph });
  },
};

const sub = (name, desc, ...adders) => (s) => adders.reduce((b, add) => add(b), s.setName(name).setDescription(desc));

export default [
  {
    category: 'Rooms',
    data: new SlashCommandBuilder()
      .setName('voice')
      .setDescription('Control voice channels and who is in them (staff)')
      .setDefaultMemberPermissions(P.MoveMembers)
      .addSubcommand(sub('move', 'Move a member to another voice channel', (b) => b.addUserOption(userOpt), (b) => b.addChannelOption(voiceOpt('channel', 'Where to'))))
      .addSubcommand(sub('moveall', 'Move everyone from one voice channel to another', (b) => b.addChannelOption(voiceOpt('from', 'From')), (b) => b.addChannelOption(voiceOpt('to', 'To'))))
      .addSubcommand(sub('disconnect', 'Kick a member out of voice', (b) => b.addUserOption(userOpt)))
      .addSubcommand(sub('disconnectall', 'Kick everyone out of a voice channel', (b) => b.addChannelOption(voiceOpt('channel', 'Channel'))))
      .addSubcommand(sub('mute', 'Server-mute a member', (b) => b.addUserOption(userOpt)))
      .addSubcommand(sub('unmute', 'Remove a server-mute', (b) => b.addUserOption(userOpt)))
      .addSubcommand(sub('deafen', 'Server-deafen a member', (b) => b.addUserOption(userOpt)))
      .addSubcommand(sub('undeafen', 'Remove a server-deafen', (b) => b.addUserOption(userOpt)))
      .addSubcommand(
        sub('limit', 'Set the user limit of a voice channel (0 = none)', (b) => b.addChannelOption(voiceOpt('channel', 'Channel')), (b) =>
          b.addIntegerOption((o) => o.setName('users').setDescription('Max users (0-99)').setRequired(true).setMinValue(0).setMaxValue(99)),
        ),
      ),
    async run(i) {
      const name = i.options.getSubcommand();
      const [bit, label] = PERM[name];
      if (needs(i, bit, label)) return;
      return handlers[name](i);
    },
  },
];
