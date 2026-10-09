import { record } from '../audit.js';
import { DiscordApiError } from '../discord.js';
import { HttpError } from '../http.js';
import { limit } from '../ratelimit.js';
import { KEYS } from '../shared/kv.js';
import { computeLevel } from '../shared/permissions.js';
import { normalizeSettings } from '../shared/settings.js';
import { createWarnStore, stepForCount } from '../shared/warnStore.js';
import { avatarUrl } from '../util.js';
import { requireId, text } from '../validate.js';

const needKv = (services) => {
  if (!services.kv) throw new HttpError(503, 'Storage is not connected, so warnings cannot be saved. Add the Upstash Redis variables to the site first.');
  return services.kv;
};

async function memberOrNull(services, userId) {
  try {
    return await services.discord.member(userId);
  } catch (e) {
    if (e instanceof DiscordApiError && e.status === 404) return null;
    throw e;
  }
}

async function levelOfMember(services, userId, member) {
  const [guild, roles] = await Promise.all([services.guild(), services.roles()]);
  return computeLevel({ guildId: services.config.guildId, ownerId: guild.owner_id, userId, memberRoleIds: member?.roles ?? [], guildRoles: roles });
}

/** Moderation from the website follows the same ladder as in Discord: nobody acts on themselves, the bot, the owner or an admin. */
async function assertCanAct(ctx, userId, member, { allowAbsent = false } = {}) {
  const { services, session } = ctx;
  const [bot, guild] = await Promise.all([services.botUser(), services.guild()]);
  if (userId === session.uid) throw new HttpError(403, 'You cannot do this to yourself.');
  if (userId === bot.id) throw new HttpError(403, 'Leave the bot alone.');
  if (userId === guild.owner_id) throw new HttpError(403, 'Nobody can moderate the server owner.');
  if (!member) {
    if (allowAbsent) return;
    throw new HttpError(404, 'That person is not in the server.');
  }
  const level = await levelOfMember(services, userId, member);
  if (level === 'admin') throw new HttpError(403, 'Admins cannot be moderated from the dashboard.');
  if (level === 'staff' && session.level !== 'admin') throw new HttpError(403, 'Only an admin can moderate staff.');
}

const reasonOf = (body, { required = false } = {}) => text(body.reason, 'Reason', { min: required ? 3 : 0, max: 400, required }) ?? 'No reason given';
const auditReason = (ctx, reason) => `${ctx.session.name} (dashboard): ${reason}`;
const dmFor = (services, guildName, text2) => `${text2} (${guildName})`;

// ---- looking people up --------------------------------------------------------------------------------

const shape = (m, roles, level) => ({
  id: m.user.id,
  name: m.nick ?? m.user.global_name ?? m.user.username,
  username: m.user.username,
  avatar: avatarUrl(m.user),
  bot: Boolean(m.user.bot),
  roles: roles.filter((r) => m.roles.includes(r.id)).sort((a, b) => b.position - a.position).slice(0, 8).map((r) => ({ id: r.id, name: r.name, color: r.color })),
  joinedAt: m.joined_at ?? null,
  timeoutUntil: m.communication_disabled_until ?? null,
  level,
});

export async function search({ url, services }) {
  const q = (url.searchParams.get('q') ?? '').trim();
  if (q.length < 2 || q.length > 32) throw new HttpError(422, 'Type 2 to 32 characters of the name.');
  const [found, roles, guild] = await Promise.all([services.discord.searchMembers(q, 10), services.roles(), services.guild()]);
  return {
    members: found.map((m) =>
      shape(m, roles, computeLevel({ guildId: services.config.guildId, ownerId: guild.owner_id, userId: m.user.id, memberRoleIds: m.roles, guildRoles: roles })),
    ),
  };
}

export async function detail({ params, services }) {
  const id = requireId(params.id, 'Member');
  const member = await memberOrNull(services, id);
  if (!member) throw new HttpError(404, 'That person is not in the server.');
  const [roles, level] = await Promise.all([services.roles(), levelOfMember(services, id, member)]);
  const warns = services.kv ? await createWarnStore(services.kv).get(services.config.guildId, id).catch(() => []) : [];
  return { member: shape(member, roles, level), warns };
}

export async function warned({ services }) {
  if (!services.kv) return { users: [] };
  const index = await createWarnStore(services.kv).users(services.config.guildId);
  const top = Object.entries(index).sort((a, b) => b[1] - a[1]).slice(0, 20);
  const users = await Promise.all(
    top.map(async ([id, count]) => {
      const m = await memberOrNull(services, id).catch(() => null);
      return { id, count, name: m ? (m.nick ?? m.user.global_name ?? m.user.username) : null, avatar: m ? avatarUrl(m.user) : null, inServer: Boolean(m) };
    }),
  );
  return { users };
}

// ---- actions ------------------------------------------------------------------------------------------

/** Runs the escalation step for a warning count. Returns a short sentence about what happened. */
async function applyStep(ctx, userId, step, count) {
  const reason = auditReason(ctx, `Reached ${count} warnings`);
  const { discord } = ctx.services;
  try {
    if (step.action === 'timeout') {
      await discord.timeout(userId, new Date(ctx.services.now() + step.minutes * 60_000).toISOString(), reason);
      return `timed out for ${step.minutes} minute(s)`;
    }
    if (step.action === 'kick') {
      await discord.kick(userId, reason);
      return 'kicked';
    }
    await discord.ban(userId, { reason });
    return 'banned';
  } catch (e) {
    return `automatic ${step.action} failed: ${e.message}`;
  }
}

export async function warn(ctx) {
  const { body, services, session } = ctx;
  limit(`mod:${session.uid}`, 30, 60_000, services.now());
  const userId = requireId(body.userId, 'Member');
  const reason = reasonOf(body, { required: true });
  const kv = needKv(services);
  const member = await memberOrNull(services, userId);
  await assertCanAct(ctx, userId, member);

  const guild = await services.guild();
  const { count } = await createWarnStore(kv).add(services.config.guildId, userId, { by: { id: session.uid, name: `${session.name} (dashboard)` }, reason });
  await services.discord.dm(userId, dmFor(services, guild.name, `⚠️ You received a warning (#${count}). Reason: ${reason}`));
  const settings = normalizeSettings(await kv.get(KEYS.settings).catch(() => null));
  const step = stepForCount(settings.automod.warns.escalation, count);
  const outcome = step ? await applyStep(ctx, userId, step, count) : null;
  await record(ctx, { action: `Warn #${count}`, target: userId, details: [reason, outcome].filter(Boolean).join(' | '), announce: true });
  return { count, outcome };
}

export async function unwarn(ctx) {
  const { body, services } = ctx;
  const userId = requireId(body.userId, 'Member');
  const store = createWarnStore(needKv(services));
  if (body.all === true) {
    const had = await store.clear(services.config.guildId, userId);
    await record(ctx, { action: 'Warnings cleared', target: userId, details: `${had} removed`, announce: true });
    return { left: 0 };
  }
  const left = await store.remove(services.config.guildId, userId, text(body.warnId, 'Warning id', { min: 1, max: 20, required: true }));
  if (left === null) throw new HttpError(404, 'No warning with that id.');
  await record(ctx, { action: 'Warning removed', target: userId, details: `${left} left`, announce: true });
  return { left };
}

export async function timeout(ctx) {
  const { body, services, session } = ctx;
  limit(`mod:${session.uid}`, 30, 60_000, services.now());
  const userId = requireId(body.userId, 'Member');
  const minutes = Math.trunc(Number(body.minutes));
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 40_320) throw new HttpError(422, 'Minutes must be between 1 and 40320 (28 days).');
  const reason = reasonOf(body);
  const member = await memberOrNull(services, userId);
  await assertCanAct(ctx, userId, member);
  await services.discord.timeout(userId, new Date(services.now() + minutes * 60_000).toISOString(), auditReason(ctx, reason));
  await record(ctx, { action: 'Timeout', target: userId, details: `${minutes} min | ${reason}`, announce: true });
  return { ok: true };
}

export async function untimeout(ctx) {
  const { body, services } = ctx;
  const userId = requireId(body.userId, 'Member');
  const member = await memberOrNull(services, userId);
  await assertCanAct(ctx, userId, member);
  await services.discord.timeout(userId, null, auditReason(ctx, 'timeout removed'));
  await record(ctx, { action: 'Timeout removed', target: userId, announce: true });
  return { ok: true };
}

export async function kick(ctx) {
  const { body, services, session } = ctx;
  limit(`mod:${session.uid}`, 30, 60_000, services.now());
  const userId = requireId(body.userId, 'Member');
  const reason = reasonOf(body);
  const member = await memberOrNull(services, userId);
  await assertCanAct(ctx, userId, member);
  const guild = await services.guild();
  await services.discord.dm(userId, dmFor(services, guild.name, `You were kicked. Reason: ${reason}`));
  await services.discord.kick(userId, auditReason(ctx, reason));
  await record(ctx, { action: 'Kick', target: userId, details: reason, announce: true });
  return { ok: true };
}

export async function ban(ctx) {
  const { body, services, session } = ctx;
  limit(`mod:${session.uid}`, 30, 60_000, services.now());
  const userId = requireId(body.userId, 'Member');
  const reason = reasonOf(body);
  const days = body.deleteDays === undefined ? 0 : Math.trunc(Number(body.deleteDays));
  if (!Number.isInteger(days) || days < 0 || days > 7) throw new HttpError(422, 'Delete days must be 0 to 7.');
  const member = await memberOrNull(services, userId);
  await assertCanAct(ctx, userId, member, { allowAbsent: true });
  if (member) {
    const guild = await services.guild();
    await services.discord.dm(userId, dmFor(services, guild.name, `You were banned. Reason: ${reason}`));
  }
  await services.discord.ban(userId, { deleteSeconds: days * 86_400, reason: auditReason(ctx, reason) });
  await record(ctx, { action: 'Ban', target: userId, details: reason, announce: true });
  return { ok: true };
}

export async function unban(ctx) {
  const { body, services } = ctx;
  const userId = requireId(body.userId, 'User');
  try {
    await services.discord.unban(userId, auditReason(ctx, 'unbanned'));
  } catch (e) {
    if (e instanceof DiscordApiError && e.status === 404) throw new HttpError(404, 'That user is not banned.');
    throw e;
  }
  await record(ctx, { action: 'Unban', target: userId, announce: true });
  return { ok: true };
}
