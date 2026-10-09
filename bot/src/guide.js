import { describeCommands } from './commands/index.js';
import { botCommandsGuide } from './content.js';
import { findChannel } from './util.js';

const GUIDE_TITLE = '🤖 Bot commands';

/**
 * Keeps the guide in #bot-commands equal to the real command list: edits the bot's own guide
 * message if there is one, posts it if not. Called on every start, so it can never go stale.
 */
export async function syncCommandGuide(guild) {
  const channel = findChannel(guild, 'bot-commands');
  if (!channel) return 'no #bot-commands channel';
  const payload = botCommandsGuide(describeCommands());
  const recent = await channel.messages.fetch({ limit: 50 });
  const existing = recent.find((m) => m.author.id === guild.client.user.id && m.embeds[0]?.title === GUIDE_TITLE);
  if (existing) {
    await existing.edit(payload);
    return 'updated';
  }
  const message = await channel.send(payload);
  await message.pin().catch(() => {});
  return 'posted';
}
