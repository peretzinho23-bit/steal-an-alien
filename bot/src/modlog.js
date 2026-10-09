import { EmbedBuilder } from 'discord.js';
import { audit } from './runtime.js';
import { findChannel } from './util.js';

export const logChannel = (guild) => findChannel(guild, 'mod-log') ?? findChannel(guild, 'staff-chat');

const who = (u) => (u ? { id: u.id, name: u.tag ?? u.username ?? String(u.id) } : null);

/**
 * Records one staff action: an embed in #mod-log and a line in the dashboard's activity log.
 * Never throws: logging must not break the command that triggered it.
 */
export async function modLog(guild, { action, moderator, target, reason, extra }) {
  await audit({ action, moderator: who(moderator), target: who(target), reason: reason ?? null, details: extra ?? null });
  try {
    const channel = logChannel(guild);
    if (!channel) return;
    const embed = new EmbedBuilder()
      .setColor(0xe67e22)
      .setTitle(`🛡️ ${action}`)
      .addFields(
        ...(moderator ? [{ name: 'Moderator', value: `${moderator}`, inline: true }] : []),
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
