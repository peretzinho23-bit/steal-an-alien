import { EmbedBuilder } from './embed-lite.js';
import { KEYS } from './shared/kv.js';
import { findByKey } from './util.js';

/**
 * Every action taken from the dashboard is written to the activity log (shown on the website) and, for the
 * sensitive ones, posted in the server's #mod-log, so staff can always see who did what.
 * Logging never fails the action it describes.
 */
export async function record(ctx, { action, target = null, details = null, announce = false }) {
  const { services, session } = ctx;
  const entry = { at: services.now(), source: 'web', actor: { id: session.uid, name: session.name }, action, target, details };
  if (services.kv) await services.kv.push(KEYS.audit, entry, 300).catch(() => {});
  if (announce) await postToModLog(services, session, action, target, details);
}

async function postToModLog(services, session, action, target, details) {
  try {
    const channels = await services.channels();
    const channel = findByKey(channels, 'mod-log') ?? findByKey(channels, 'staff-chat');
    if (!channel) return;
    const embed = new EmbedBuilder()
      .color(0x5b3df5)
      .title(`🛰️ ${action}`)
      .field('By (dashboard)', `<@${session.uid}> (${session.name})`, true)
      .field('Target', target ? String(target) : '-', true)
      .field('Details', details ? String(details).slice(0, 900) : '-')
      .timestamp(new Date(services.now()).toISOString())
      .toJSON();
    await services.discord.sendMessage(channel.id, { embeds: [embed], allowed_mentions: { parse: [] } });
  } catch {
    /* the log post is a courtesy */
  }
}
