import { rulesPanel, ticketPanel, welcomePanel } from './content.js';
import { findChannel } from './util.js';

/**
 * The messages the bot owns in the info channels. Each one is found by its embed title and edited in place
 * (or posted if it is missing), so an update to the texts or buttons reaches the server on the next start
 * without duplicate messages.
 */
export const PANELS = {
  welcome: { channel: 'welcome', build: (guild) => welcomePanel(guild), match: (title) => title.startsWith('👽 Welcome to') },
  rules: { channel: 'rules', build: () => rulesPanel(), match: (title) => title === '📜 Server Rules' },
  tickets: { channel: 'create-ticket', build: () => ticketPanel(), match: (title) => title === '🎫 Support' },
};

export async function syncPanel(guild, name) {
  if (!Object.hasOwn(PANELS, name)) return `unknown panel "${name}"`;
  const panel = PANELS[name];
  const channel = findChannel(guild, panel.channel);
  if (!channel) return `no #${panel.channel} channel`;
  const payload = panel.build(guild);
  const recent = await channel.messages.fetch({ limit: 50 });
  const existing = recent.find((m) => m.author.id === guild.client.user.id && panel.match(m.embeds[0]?.title ?? ''));
  if (existing) {
    await existing.edit(payload);
    return 'updated';
  }
  await channel.send(payload);
  return 'posted';
}

export async function syncPanels(guild, names = Object.keys(PANELS)) {
  const results = [];
  for (const name of names) results.push(`${name}: ${await syncPanel(guild, name).catch((e) => `failed (${e.message})`)}`);
  return results.join(', ');
}
