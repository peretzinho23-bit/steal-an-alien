import { HttpError } from './http.js';

/** Every request body is checked here before it gets anywhere near Discord. Limits are Discord's own. */

export const isSnowflake = (v) => typeof v === 'string' && /^\d{15,25}$/.test(v);

export function requireId(v, label = 'id') {
  if (!isSnowflake(v)) throw new HttpError(422, `${label} is not a valid Discord id.`);
  return v;
}

const str = (v, label, { min = 0, max, required = false } = {}) => {
  if (v === undefined || v === null || v === '') {
    if (required) throw new HttpError(422, `${label} is required.`);
    return undefined;
  }
  if (typeof v !== 'string') throw new HttpError(422, `${label} must be text.`);
  const s = v.trim();
  if (s.length < min || s.length > max) throw new HttpError(422, `${label} must be between ${min} and ${max} characters.`);
  return s;
};
export const text = str;

export function httpsUrl(v, label) {
  const s = str(v, label, { max: 2048 });
  if (s === undefined) return undefined;
  let url;
  try {
    url = new URL(s);
  } catch {
    throw new HttpError(422, `${label} is not a valid link.`);
  }
  if (url.protocol !== 'https:') throw new HttpError(422, `${label} must start with https://`);
  return url.toString();
}

export function color(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'string' ? parseInt(v.replace(/^#/, ''), 16) : Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 0xffffff) throw new HttpError(422, 'Colour must be a hex value like #5B3DF5.');
  return n;
}

/** One embed, reduced to the fields we allow and checked against Discord's limits. */
export function cleanEmbed(e, label = 'embed') {
  if (e === null || typeof e !== 'object' || Array.isArray(e)) throw new HttpError(422, `${label} is malformed.`);
  const out = {};
  const title = str(e.title, `${label} title`, { max: 256 });
  const description = str(e.description, `${label} description`, { max: 4096 });
  if (title) out.title = title;
  if (description) out.description = description;
  const url = httpsUrl(e.url, `${label} link`);
  if (url) out.url = url;
  const c = color(e.color);
  if (c !== undefined) out.color = c;
  const footer = str(e.footer, `${label} footer`, { max: 2048 });
  if (footer) out.footer = { text: footer };
  const image = httpsUrl(e.image, `${label} image`);
  if (image) out.image = { url: image };
  const thumbnail = httpsUrl(e.thumbnail, `${label} thumbnail`);
  if (thumbnail) out.thumbnail = { url: thumbnail };
  if (e.timestamp === true) out.timestamp = new Date().toISOString();
  if (e.fields !== undefined) {
    if (!Array.isArray(e.fields) || e.fields.length > 25) throw new HttpError(422, `${label} can have at most 25 fields.`);
    out.fields = e.fields.map((f, i) => ({
      name: str(f?.name, `${label} field ${i + 1} name`, { max: 256, required: true }),
      value: str(f?.value, `${label} field ${i + 1} value`, { max: 1024, required: true }),
      inline: f?.inline === true,
    }));
  }
  if (!out.title && !out.description && !out.image && !out.fields?.length) {
    throw new HttpError(422, `${label} is empty: add a title, text, image or field.`);
  }
  return out;
}

const embedChars = (e) =>
  (e.title?.length ?? 0) + (e.description?.length ?? 0) + (e.footer?.text?.length ?? 0) + (e.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0);

/**
 * Builds the Discord message payload from the form the dashboard sends.
 *   body: { content?, embeds?[], pingRoleIds?[], pingEveryone?, replyTo? }
 *   pingableRoleIds: roles staff may mention (mentionable or the opt-in ping roles)
 * Mentions are explicit: nothing pings unless it is selected here AND allowed for this person.
 */
export function buildMessage(body, { level, pingableRoleIds = new Set() }) {
  const content = str(body.content, 'Message text', { max: 2000 });
  if (!Array.isArray(body.embeds ?? [])) throw new HttpError(422, 'Embeds must be a list.');
  const embeds = (body.embeds ?? []).map((e, i) => cleanEmbed(e, `Embed ${i + 1}`));
  if (embeds.length > 10) throw new HttpError(422, 'At most 10 embeds per message.');
  if (embeds.reduce((n, e) => n + embedChars(e), 0) > 6000) throw new HttpError(422, 'The embeds are over Discord\'s 6000 character limit in total.');

  const roleIds = [...new Set(body.pingRoleIds ?? [])];
  if (roleIds.length > 5) throw new HttpError(422, 'Ping at most 5 roles at once.');
  for (const id of roleIds) {
    requireId(id, 'Role');
    if (!pingableRoleIds.has(id)) throw new HttpError(403, 'That role cannot be pinged from the dashboard.');
  }
  const everyone = body.pingEveryone === true;
  if (everyone && level !== 'admin') throw new HttpError(403, 'Only admins can ping @everyone.');

  const mentions = [everyone ? '@everyone' : null, ...roleIds.map((id) => `<@&${id}>`)].filter(Boolean).join(' ');
  const fullContent = [mentions, content].filter(Boolean).join('\n') || undefined;
  if (!fullContent && !embeds.length) throw new HttpError(422, 'Write some text or add an embed first.');
  if (fullContent && fullContent.length > 2000) throw new HttpError(422, 'Message text plus pings is over 2000 characters.');

  const payload = {
    content: fullContent,
    embeds: embeds.length ? embeds : undefined,
    allowed_mentions: { parse: everyone ? ['everyone'] : [], roles: roleIds, users: [] },
  };
  if (body.replyTo !== undefined && body.replyTo !== '') {
    payload.message_reference = { message_id: requireId(body.replyTo, 'Reply message'), fail_if_not_exists: false };
  }
  return payload;
}

/** "https://discord.com/channels/G/C/M" (or ptb./canary.) -> { guildId, channelId, messageId } or null. */
export function parseMessageLink(link) {
  const m = /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/channels\/(\d{15,25})\/(\d{15,25})\/(\d{15,25})\/?(?:[?#].*)?$/.exec(String(link ?? '').trim());
  return m ? { guildId: m[1], channelId: m[2], messageId: m[3] } : null;
}

/** A unicode emoji or a custom one written as name:id. Nothing else reaches the URL path. */
export function cleanEmoji(v) {
  const s = str(v, 'Emoji', { max: 64, required: true });
  if (/^[A-Za-z0-9_]{2,32}:\d{15,25}$/.test(s)) return s;
  if (/^[\p{Extended_Pictographic}‍️⃣\p{Regional_Indicator}0-9#*]+$/u.test(s) && s.length <= 16) return s;
  throw new HttpError(422, 'Emoji must be a normal emoji or a server emoji written as name:id.');
}

export const CHANNEL_TYPES = { text: 0, voice: 2, category: 4 };
export const ACCESS_PRESETS = ['chat', 'read', 'staff', 'hidden'];
