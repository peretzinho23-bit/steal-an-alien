import { MessageFlags, PermissionFlagsBits as P, SlashCommandBuilder } from 'discord.js';
import { grantOwner, ownerOfRoom, revokeOwner, roomChannelName, setRoomOwner } from '../rooms.js';

const eph = { flags: MessageFlags.Ephemeral };
const userOpt = (o) => o.setName('user').setDescription('Member').setRequired(true);
const sub = (name, desc, ...adders) => (s) => adders.reduce((b, add) => add(b), s.setName(name).setDescription(desc));

/**
 * The room the member is in, if they own it. Otherwise replies with the reason and returns null.
 * Only the owner of a tracked temporary room may use /room there.
 */
async function ownedRoom(i) {
  const reply = (content) => i.reply({ content, ...eph });
  const channel = i.member?.voice?.channel;
  if (!channel) {
    await reply('Join your temporary room first, then use /room. (Join ➕｜Create Room to get one.)');
    return null;
  }
  const owner = await ownerOfRoom(channel.id);
  if (!owner) {
    await reply('You are not in a temporary room. Join ➕｜Create Room to get your own.');
    return null;
  }
  if (owner !== i.user.id) {
    await reply('Only the owner of this room can change it.');
    return null;
  }
  return channel;
}

const reason = (i) => `Room settings by ${i.user.tag}`;

const handlers = {
  async name(i, room) {
    const text = i.options.getString('name', true);
    await i.deferReply(eph);
    await room.setName(roomChannelName(text), reason(i));
    return i.editReply(`Room renamed to **${room.name}**.`);
  },

  async limit(i, room) {
    const n = i.options.getInteger('users', true);
    await i.deferReply(eph);
    await room.setUserLimit(n, reason(i));
    return i.editReply(n ? `Room limited to ${n} member(s).` : 'Room has no member limit now.');
  },

  async lock(i, room) {
    await i.deferReply(eph);
    await room.permissionOverwrites.edit(i.guild.id, { Connect: false }, { reason: reason(i) });
    return i.editReply('Locked. Only people you invite (or who already have access) can join.');
  },

  async unlock(i, room) {
    await i.deferReply(eph);
    await room.permissionOverwrites.edit(i.guild.id, { Connect: null }, { reason: reason(i) });
    return i.editReply('Unlocked. Anyone can join.');
  },

  async hide(i, room) {
    await i.deferReply(eph);
    await room.permissionOverwrites.edit(i.guild.id, { ViewChannel: false }, { reason: reason(i) });
    return i.editReply('Hidden. Only people you invite can see the room.');
  },

  async show(i, room) {
    await i.deferReply(eph);
    await room.permissionOverwrites.edit(i.guild.id, { ViewChannel: null }, { reason: reason(i) });
    return i.editReply('Visible to everyone again.');
  },

  async invite(i, room) {
    const member = i.options.getMember('user');
    if (!member) return i.reply({ content: 'That user is not in this server.', ...eph });
    if (member.user.bot) return i.reply({ content: 'Bots cannot be invited.', ...eph });
    await i.deferReply(eph);
    await room.permissionOverwrites.edit(member.id, { ViewChannel: true, Connect: true }, { reason: reason(i) });
    return i.editReply(`${member.displayName} can see and join the room now.`);
  },

  async kick(i, room) {
    const member = i.options.getMember('user');
    if (!member) return i.reply({ content: 'That user is not in this server.', ...eph });
    if (member.id === i.user.id) return i.reply({ content: 'You cannot kick yourself.', ...eph });
    if (member.voice?.channelId !== room.id) return i.reply({ content: `${member.displayName} is not in your room.`, ...eph });
    await i.deferReply(eph);
    await member.voice.disconnect(`Kicked from the room by ${i.user.tag}`);
    return i.editReply(`Kicked ${member.displayName} out of the room.`);
  },

  async transfer(i, room) {
    const member = i.options.getMember('user');
    if (!member) return i.reply({ content: 'That user is not in this server.', ...eph });
    if (member.user.bot) return i.reply({ content: 'Bots cannot own a room.', ...eph });
    if (member.id === i.user.id) return i.reply({ content: 'You already own this room.', ...eph });
    if (member.voice?.channelId !== room.id) return i.reply({ content: `${member.displayName} must be in the room to become its owner.`, ...eph });
    await i.deferReply(eph);
    await setRoomOwner(room.id, member.id);
    await grantOwner(room, member.id, reason(i));
    await revokeOwner(room, i.user.id, reason(i));
    return i.editReply(`${member.displayName} is the owner of the room now.`);
  },
};

export default [
  {
    category: 'Rooms',
    data: new SlashCommandBuilder()
      .setName('room')
      .setDescription('Manage the temporary voice room you own')
      // visible to everyone who can join voice (every member); the owner check is done in run()
      .setDefaultMemberPermissions(P.Connect)
      .addSubcommand(sub('name', 'Rename your room', (b) => b.addStringOption((o) => o.setName('name').setDescription('New name').setRequired(true).setMaxLength(90))))
      .addSubcommand(
        sub('limit', 'Set the member limit (0 = none)', (b) =>
          b.addIntegerOption((o) => o.setName('users').setDescription('Max members (0-99)').setRequired(true).setMinValue(0).setMaxValue(99)),
        ),
      )
      .addSubcommand(sub('lock', 'Only invited people can join'))
      .addSubcommand(sub('unlock', 'Anyone can join again'))
      .addSubcommand(sub('hide', 'Hide the room from everyone except invited people'))
      .addSubcommand(sub('show', 'Make the room visible to everyone'))
      .addSubcommand(sub('invite', 'Let a member see and join your room even when it is locked or hidden', (b) => b.addUserOption(userOpt)))
      .addSubcommand(sub('kick', 'Disconnect a member from your room', (b) => b.addUserOption(userOpt)))
      .addSubcommand(sub('transfer', 'Give your room to a member who is in it', (b) => b.addUserOption(userOpt))),
    async run(i) {
      const name = i.options.getSubcommand();
      const room = await ownedRoom(i);
      if (!room) return;
      return handlers[name](i, room);
    },
  },
];
