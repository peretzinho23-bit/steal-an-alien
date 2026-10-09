import { EmbedBuilder } from 'discord.js';
import { findChannel } from './util.js';

/** Posts one line about a staff action to #staff-chat. Never throws: logging must not break the command. */
export async function modLog(guild, { action, moderator, target, reason, extra }) {
  try {
    const channel = findChannel(guild, 'staff-chat');
    if (!channel) return;
    const embed = new EmbedBuilder()
      .setColor(0xe67e22)
      .setTitle(`🛡️ ${action}`)
      .addFields(
        { name: 'Moderator', value: `${moderator}`, inline: true },
        ...(target ? [{ name: 'Target', value: `${target}`, inline: true }] : []),
        ...(reason ? [{ name: 'Reason', value: reason.slice(0, 1000) }] : []),
        ...(extra ? [{ name: 'Details', value: extra.slice(0, 1000) }] : []),
      )
      .setTimestamp();
    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  } catch (e) {
    console.error('Could not write the mod log:', e.message);
  }
}
