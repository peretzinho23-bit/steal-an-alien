import { record } from '../audit.js';
import { HttpError } from '../http.js';
import { limit } from '../ratelimit.js';
import { TEXT_TYPES, plainName } from '../util.js';
import { buildMessage, cleanEmoji, parseMessageLink, requireId } from '../validate.js';

/** Opt-in ping roles plus any role an admin marked mentionable. Never @everyone, bots' roles or staff roles. */
const PING_NAMES = new Set(['announcements', 'updates', 'giveaways', 'events']);
const NEVER_PING = new Set(['owner', 'admin', 'moderator', 'developer', 'tester']);

export async function pingableRoleIds(services) {
  const roles = await services.roles();
  return new Set(
    roles
      .filter((r) => r.id !== services.config.guildId && !r.managed && !NEVER_PING.has(plainName(r.name)) && (r.mentionable || PING_NAMES.has(plainName(r.name))))
      .map((r) => r.id),
  );
}

const linkFor = (services, channelId, messageId) => `https://discord.com/channels/${services.config.guildId}/${channelId}/${messageId}`;

/** A channel of THIS server (the bot may be in others), or an error. */
async function textChannel(services, channelId) {
  requireId(channelId, 'Channel');
  const channel = (await services.channels()).find((c) => c.id === channelId);
  if (!channel) throw new HttpError(422, 'That channel is not in this server.');
  if (!TEXT_TYPES.has(channel.type)) throw new HttpError(422, 'Pick a text channel.');
  return channel;
}

/** { channelId, messageId } from either a pasted message link or explicit ids. */
function target(body) {
  if (body.link) {
    const parsed = parseMessageLink(body.link);
    if (!parsed) throw new HttpError(422, 'That is not a Discord message link. Right click a message and choose Copy Message Link.');
    return parsed;
  }
  return { channelId: requireId(body.channelId, 'Channel'), messageId: requireId(body.messageId, 'Message') };
}

async function ownMessage(services, body) {
  const t = target(body);
  if (t.guildId && t.guildId !== services.config.guildId) throw new HttpError(422, 'That message is from another server.');
  const channel = await textChannel(services, t.channelId);
  return { ...t, channel };
}

const preview = (text) => (text ? String(text).replace(/\s+/g, ' ').slice(0, 120) : '(embed)');

export async function send(ctx) {
  const { body, session, services } = ctx;
  limit(`send:${session.uid}`, 15, 60_000, services.now());
  const channel = await textChannel(services, body.channelId);
  const payload = buildMessage(body, { level: session.level, pingableRoleIds: await pingableRoleIds(services) });
  const message = await services.discord.sendMessage(channel.id, payload);
  await record(ctx, {
    action: 'Message sent',
    target: `#${channel.name}`,
    details: preview(body.content ?? body.embeds?.[0]?.title),
    announce: body.pingEveryone === true || (body.pingRoleIds?.length ?? 0) > 0,
  });
  return { id: message.id, channelId: channel.id, link: linkFor(services, channel.id, message.id) };
}

export async function lookup(ctx) {
  const { url, services } = ctx;
  const { messageId, channel } = await ownMessage(services, { link: url.searchParams.get('link') });
  const message = await services.discord.getMessage(channel.id, messageId);
  const bot = await services.botUser();
  return {
    channelId: channel.id,
    channelName: channel.name,
    messageId,
    editable: message.author?.id === bot.id,
    content: message.content ?? '',
    embeds: (message.embeds ?? []).map((e) => ({
      title: e.title ?? '',
      description: e.description ?? '',
      color: e.color ?? null,
      footer: e.footer?.text ?? '',
      image: e.image?.url ?? '',
      thumbnail: e.thumbnail?.url ?? '',
      url: e.url ?? '',
      fields: e.fields ?? [],
    })),
  };
}

export async function edit(ctx) {
  const { body, session, services } = ctx;
  limit(`send:${session.uid}`, 15, 60_000, services.now());
  const { channel, messageId } = await ownMessage(services, body);
  const payload = buildMessage({ ...body, pingRoleIds: [], pingEveryone: false }, { level: session.level });
  payload.embeds ??= []; // an edit that removes the embeds must say so explicitly
  payload.content ??= '';
  delete payload.message_reference;
  await services.discord.editMessage(channel.id, messageId, payload);
  await record(ctx, { action: 'Message edited', target: `#${channel.name}`, details: preview(body.content ?? body.embeds?.[0]?.title) });
  return { ok: true, link: linkFor(services, channel.id, messageId) };
}

export async function remove(ctx) {
  const { body, services } = ctx;
  const { channel, messageId } = await ownMessage(services, body);
  await services.discord.deleteMessage(channel.id, messageId, `Deleted from the dashboard by ${ctx.session.name}`);
  await record(ctx, { action: 'Message deleted', target: `#${channel.name}`, details: messageId, announce: true });
  return { ok: true };
}

export async function react(ctx) {
  const { body, services } = ctx;
  const { channel, messageId } = await ownMessage(services, body);
  await services.discord.react(channel.id, messageId, cleanEmoji(body.emoji));
  await record(ctx, { action: 'Reaction added', target: `#${channel.name}`, details: body.emoji });
  return { ok: true };
}
