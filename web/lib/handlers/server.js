import { record } from '../audit.js';
import { HttpError } from '../http.js';
import { KEYS } from '../shared/kv.js';
import { buildRules, syncAutoModRules } from '../shared/automodRules.js';
import { DEFAULT_SETTINGS, normalizeSettings } from '../shared/settings.js';
import { findByKey, plainName } from '../util.js';
import { ACCESS_PRESETS, CHANNEL_TYPES, color, requireId, text } from '../validate.js';
import { pingableRoleIds } from './messages.js';

const BIT = (n) => 1n << BigInt(n);
const VIEW = BIT(10);
const SEND = BIT(11);
const HISTORY = BIT(16);
const THREADS = BIT(35) | BIT(36) | BIT(38);
const MANAGE_CHANNELS = BIT(4);
const ADMINISTRATOR = BIT(3);

const needKv = (services) => {
  if (!services.kv) throw new HttpError(503, 'Storage is not connected. Add the Upstash Redis variables to the site first (see the setup guide).');
  return services.kv;
};

const ROLE = 0;
const MEMBER = 1;

/** chat = everyone talks, read = everyone reads, staff = Moderator + Admin, hidden = admins only. */
export function accessOverwrites(access, { guildId, adminRoleId, modRoleId, botId }) {
  const ow = (id, type, allow = 0n, deny = 0n) => ({ id, type, allow: String(allow), deny: String(deny) });
  const staff = [adminRoleId, modRoleId].filter(Boolean).map((id) => ow(id, ROLE, VIEW | SEND | HISTORY));
  const out = [];
  if (access === 'read') out.push(ow(guildId, ROLE, 0n, SEND | THREADS), ...staff);
  else if (access === 'staff') out.push(ow(guildId, ROLE, 0n, VIEW), ...staff);
  else if (access === 'hidden') out.push(ow(guildId, ROLE, 0n, VIEW));
  if (out.length && botId) out.push(ow(botId, MEMBER, VIEW | SEND | HISTORY | MANAGE_CHANNELS));
  return out;
}

// ---- information --------------------------------------------------------------------------------------

export async function guildInfo({ services }) {
  const [channels, roles, pingable] = await Promise.all([services.channels(), services.roles(), pingableRoleIds(services)]);
  return {
    channels: channels
      .map((c) => ({ id: c.id, name: c.name, type: c.type, parentId: c.parent_id ?? null, position: c.position ?? 0 }))
      .sort((a, b) => a.position - b.position),
    roles: roles
      .filter((r) => r.id !== services.config.guildId)
      .map((r) => ({ id: r.id, name: r.name, color: r.color, position: r.position, managed: r.managed, mentionable: r.mentionable, pingable: pingable.has(r.id) }))
      .sort((a, b) => b.position - a.position),
  };
}

const BOT_ONLINE_MS = 5 * 60_000;

export async function status({ services }) {
  const out = { redis: Boolean(services.kv), bot: { online: false, at: null, ping: null }, lockdown: null, jobs: [] };
  if (!services.kv) return out;
  const [heartbeat, lockdown, jobs] = await Promise.all([
    services.kv.get(KEYS.heartbeat).catch(() => null),
    services.kv.get(KEYS.lockdown).catch(() => null),
    services.kv.list(KEYS.jobResults, 5).catch(() => []),
  ]);
  if (heartbeat) out.bot = { online: services.now() - heartbeat.at < BOT_ONLINE_MS, at: heartbeat.at, ping: heartbeat.ping ?? null };
  out.lockdown = lockdown ? { until: lockdown.until, by: lockdown.by?.name ?? null } : null;
  out.jobs = jobs;
  return out;
}

export async function leaderboard({ services }) {
  if (!services.kv) return { entries: [], at: null };
  return (await services.kv.get(KEYS.leaderboard).catch(() => null)) ?? { entries: [], at: null };
}

export async function activity({ services, url }) {
  if (!services.kv) return { entries: [] };
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 200);
  return { entries: await services.kv.list(KEYS.audit, limit) };
}

export async function jobResults({ services }) {
  return { results: services.kv ? await services.kv.list(KEYS.jobResults, 20).catch(() => []) : [] };
}

// ---- settings and AutoMod -----------------------------------------------------------------------------

export async function getSettings({ services }) {
  const stored = services.kv ? await services.kv.get(KEYS.settings).catch(() => null) : null;
  return { settings: normalizeSettings(stored ?? DEFAULT_SETTINGS), stored: stored !== null, redis: Boolean(services.kv) };
}

/** Saves the settings and pushes the matching native AutoMod rules to Discord right away. */
export async function putSettings(ctx) {
  const { body, services } = ctx;
  const kv = needKv(services);
  const settings = normalizeSettings(body.settings);
  await kv.set(KEYS.settings, settings);

  let sync = null;
  try {
    const [channels, roles] = await Promise.all([services.channels(), services.roles()]);
    const alert = findByKey(channels, 'mod-log') ?? findByKey(channels, 'staff-chat');
    const exemptRoleIds = settings.automod.exemptRoles
      .map((n) => roles.find((r) => plainName(r.name) === plainName(n))?.id)
      .filter(Boolean);
    const rules = buildRules(settings, { alertChannelId: alert?.id ?? null, exemptRoleIds });
    sync = await syncAutoModRules(services.discord.rest, services.config.guildId, rules);
  } catch (e) {
    sync = { created: [], updated: [], removed: [], errors: [e.message] };
  }
  await record(ctx, {
    action: 'Settings saved',
    details: sync.errors.length ? `AutoMod problems: ${sync.errors[0]}` : `AutoMod synced (${sync.created.length} new, ${sync.updated.length} updated, ${sync.removed.length} removed)`,
    announce: true,
  });
  return { settings, sync };
}

// ---- channels and roles -------------------------------------------------------------------------------

async function category(services, parentId) {
  if (!parentId) return null;
  requireId(parentId, 'Category');
  const found = (await services.channels()).find((c) => c.id === parentId && c.type === CHANNEL_TYPES.category);
  if (!found) throw new HttpError(422, 'That category does not exist.');
  return found;
}

export async function createChannel(ctx) {
  const { body, services } = ctx;
  const name = text(body.name, 'Name', { min: 1, max: 100, required: true });
  const type = CHANNEL_TYPES[body.type];
  if (type === undefined) throw new HttpError(422, 'Type must be text, voice or category.');
  const access = body.access ?? 'chat';
  if (!ACCESS_PRESETS.includes(access)) throw new HttpError(422, 'Unknown access preset.');
  const parent = type === CHANNEL_TYPES.category ? null : await category(services, body.parentId);
  const topic = type === CHANNEL_TYPES.text ? text(body.topic, 'Topic', { max: 1024 }) : undefined;

  const [roles, bot] = await Promise.all([services.roles(), services.botUser()]);
  const roleId = (n) => roles.find((r) => plainName(r.name) === n)?.id;
  const created = await services.discord.createChannel(
    {
      name,
      type,
      topic,
      parent_id: parent?.id,
      permission_overwrites: accessOverwrites(access, { guildId: services.config.guildId, adminRoleId: roleId('admin'), modRoleId: roleId('moderator'), botId: bot.id }),
    },
    `Created from the dashboard by ${ctx.session.name}`,
  );
  services.channels.clear();
  await record(ctx, { action: 'Channel created', target: created.name, details: `${body.type}, ${access}`, announce: true });
  return { id: created.id, name: created.name };
}

export async function patchChannel(ctx) {
  const { body, services, params } = ctx;
  const id = requireId(params.id, 'Channel');
  const channel = (await services.channels()).find((c) => c.id === id);
  if (!channel) throw new HttpError(404, 'That channel is not in this server.');
  const patch = {};
  const name = text(body.name, 'Name', { min: 1, max: 100 });
  if (name) patch.name = name;
  if (body.topic !== undefined) patch.topic = text(body.topic, 'Topic', { max: 1024 }) ?? '';
  if (body.rateLimitPerUser !== undefined) {
    const n = Number(body.rateLimitPerUser);
    if (!Number.isInteger(n) || n < 0 || n > 21600) throw new HttpError(422, 'Slowmode must be 0 to 21600 seconds.');
    patch.rate_limit_per_user = n;
  }
  if (body.parentId !== undefined) patch.parent_id = body.parentId ? (await category(services, body.parentId)).id : null;
  if (!Object.keys(patch).length) throw new HttpError(422, 'Nothing to change.');
  await services.discord.patchChannel(id, patch, `Edited from the dashboard by ${ctx.session.name}`);
  services.channels.clear();
  await record(ctx, { action: 'Channel edited', target: channel.name, details: Object.keys(patch).join(', '), announce: true });
  return { ok: true };
}

export async function deleteChannel(ctx) {
  const { body, services, params } = ctx;
  const id = requireId(params.id, 'Channel');
  const channel = (await services.channels()).find((c) => c.id === id);
  if (!channel) throw new HttpError(404, 'That channel is not in this server.');
  if (body.confirm !== channel.name) throw new HttpError(422, 'Type the channel name to confirm the deletion.');
  await services.discord.deleteChannel(id, `Deleted from the dashboard by ${ctx.session.name}`);
  services.channels.clear();
  await record(ctx, { action: 'Channel deleted', target: channel.name, announce: true });
  return { ok: true };
}

export async function createRole(ctx) {
  const { body, services } = ctx;
  const name = text(body.name, 'Name', { min: 1, max: 100, required: true });
  const c = color(body.color);
  const created = await services.discord.createRole(
    { name, color: c ?? 0, hoist: body.hoist === true, mentionable: body.mentionable === true, permissions: '0' },
    `Created from the dashboard by ${ctx.session.name}`,
  );
  services.roles.clear();
  await record(ctx, { action: 'Role created', target: created.name, announce: true });
  return { id: created.id, name: created.name };
}

export async function deleteRole(ctx) {
  const { body, services, params } = ctx;
  const id = requireId(params.id, 'Role');
  const role = (await services.roles()).find((r) => r.id === id);
  if (!role || id === services.config.guildId) throw new HttpError(404, 'That role does not exist.');
  if (role.managed) throw new HttpError(422, 'That role belongs to a bot or integration and cannot be deleted here.');
  if (body.confirm !== role.name) throw new HttpError(422, 'Type the role name to confirm the deletion.');
  await services.discord.deleteRole(id, `Deleted from the dashboard by ${ctx.session.name}`);
  services.roles.clear();
  await record(ctx, { action: 'Role deleted', target: role.name, announce: true });
  return { ok: true };
}

/** Give or take roles. Roles with Administrator and managed roles can never be handed out from the website. */
export async function memberRoles(ctx) {
  const { body, services } = ctx;
  const userId = requireId(body.userId, 'Member');
  const roles = await services.roles();
  const pick = (ids = []) =>
    [...new Set(ids)].slice(0, 10).map((rid) => {
      requireId(rid, 'Role');
      const role = roles.find((r) => r.id === rid);
      if (!role || rid === services.config.guildId) throw new HttpError(422, 'Unknown role.');
      if (role.managed) throw new HttpError(422, `"${role.name}" is managed by a bot and cannot be assigned.`);
      if ((BigInt(role.permissions ?? 0) & ADMINISTRATOR) !== 0n) throw new HttpError(403, `"${role.name}" has Administrator permission. Change that role in Discord itself.`);
      return role;
    });
  const add = pick(body.add);
  const remove = pick(body.remove);
  if (!add.length && !remove.length) throw new HttpError(422, 'Pick at least one role.');
  for (const r of add) await services.discord.addRole(userId, r.id, `By ${ctx.session.name} (dashboard)`);
  for (const r of remove) await services.discord.removeRole(userId, r.id, `By ${ctx.session.name} (dashboard)`);
  await record(ctx, { action: 'Member roles changed', target: userId, details: [...add.map((r) => `+${r.name}`), ...remove.map((r) => `-${r.name}`)].join(' '), announce: true });
  return { ok: true };
}

// ---- jobs for the bot ---------------------------------------------------------------------------------

const newJobId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function enqueue(ctx, type, payload) {
  const { services, session } = ctx;
  const kv = needKv(services);
  const id = newJobId();
  await kv.push(KEYS.jobs, { id, type, payload, by: { id: session.uid, name: session.name }, guildId: services.config.guildId, at: services.now() }, 50);
  const heartbeat = await kv.get(KEYS.heartbeat).catch(() => null);
  const botOnline = Boolean(heartbeat && services.now() - heartbeat.at < BOT_ONLINE_MS);
  return { queued: true, id, botOnline };
}

export async function lockdown(ctx) {
  const on = ctx.body.on === true;
  const minutes = Math.min(Math.max(Math.trunc(Number(ctx.body.minutes)) || 15, 1), 1440);
  const result = await enqueue(ctx, 'lockdown', { on, minutes });
  await record(ctx, { action: on ? 'Lockdown requested' : 'Lockdown end requested', details: on ? `${minutes} min` : null, announce: true });
  return result;
}

const PANELS = new Set(['welcome', 'rules', 'tickets']);
export async function repostPanel(ctx) {
  const panel = String(ctx.body.panel ?? '');
  if (!PANELS.has(panel)) throw new HttpError(422, 'Unknown panel.');
  const result = await enqueue(ctx, 'repost-panel', { panel });
  await record(ctx, { action: 'Panel refresh requested', details: panel });
  return result;
}
