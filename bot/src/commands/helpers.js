import { ChannelType } from 'discord.js';

const LABELS = {
  [ChannelType.GuildText]: 'text',
  [ChannelType.GuildVoice]: 'voice',
  [ChannelType.GuildCategory]: 'category',
  [ChannelType.GuildAnnouncement]: 'announcement',
  [ChannelType.GuildStageVoice]: 'stage',
  [ChannelType.GuildForum]: 'forum',
};

export const channelTypeLabel = (type) => LABELS[type] ?? `type ${type}`;

/** "#ff8800", "ff8800" -> 0xff8800, anything else -> null. */
export function parseHexColor(text) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(text ?? '').trim());
  return m ? parseInt(m[1], 16) : null;
}
