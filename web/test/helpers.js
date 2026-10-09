import { DiscordApiError } from '../lib/discord.js';
import { createHandler } from '../lib/router.js';
import { resetLimits } from '../lib/ratelimit.js';
import { sign } from '../lib/session.js';
import { FileKv } from '../lib/shared/kv.js';
import { cached } from '../lib/context.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const GUILD = '111111111111111111';
export const OWNER = '222222222222222222';
export const BOT = '333333333333333333';
export const SECRET = 'test-secret-that-is-long-enough-123456';
export const NOW = 1_800_000_000_000;

const role = (id, name, extra = {}) => ({ id, name, color: 0, position: 1, managed: false, mentionable: false, permissions: '0', ...extra });
export const ROLE_IDS = { admin: '500000000000000001', mod: '500000000000000002', dev: '500000000000000003', news: '500000000000000004', boss: '500000000000000005', botrole: '500000000000000006', plain: '500000000000000007' };
export const CHANNEL_IDS = { general: '600000000000000001', announcements: '600000000000000002', voice: '600000000000000003', cat: '600000000000000004', modlog: '600000000000000005', other: '600000000000000099' };

export function defaultData() {
  return {
    guild: { id: GUILD, name: 'Steal an alien', owner_id: OWNER, icon: null, approximate_member_count: 42 },
    roles: [
      role(GUILD, '@everyone'),
      role(ROLE_IDS.admin, 'Admin', { position: 9 }),
      role(ROLE_IDS.mod, '🛡 Moderator', { position: 8 }),
      role(ROLE_IDS.dev, 'Developer', { position: 7 }),
      role(ROLE_IDS.news, '📣 Announcements', { position: 3 }),
      role(ROLE_IDS.boss, 'Boss', { position: 6, permissions: '8' }),
      role(ROLE_IDS.botrole, 'Some Bot', { position: 5, managed: true }),
      role(ROLE_IDS.plain, 'Plain', { position: 2, mentionable: true }),
    ],
    channels: [
      { id: CHANNEL_IDS.cat, name: 'Text', type: 4, position: 0 },
      { id: CHANNEL_IDS.general, name: 'general', type: 0, position: 1, parent_id: CHANNEL_IDS.cat },
      { id: CHANNEL_IDS.announcements, name: '📣｜announcements', type: 0, position: 2 },
      { id: CHANNEL_IDS.voice, name: 'General', type: 2, position: 3 },
      { id: CHANNEL_IDS.modlog, name: '📜｜mod-log', type: 0, position: 4 },
    ],
    members: {
      [OWNER]: { user: { id: OWNER, username: 'owner' }, roles: [], nick: null },
      '700000000000000001': { user: { id: '700000000000000001', username: 'adminuser' }, roles: [ROLE_IDS.admin] },
      '700000000000000002': { user: { id: '700000000000000002', username: 'moduser', global_name: 'Mod User' }, roles: [ROLE_IDS.mod] },
      '700000000000000003': { user: { id: '700000000000000003', username: 'devuser' }, roles: [ROLE_IDS.dev] },
      '700000000000000004': { user: { id: '700000000000000004', username: 'victim' }, roles: [], joined_at: '2026-01-01T00:00:00.000Z' },
    },
  };
}

export const ADMIN_ID = '700000000000000001';
export const MOD_ID = '700000000000000002';
export const DEV_ID = '700000000000000003';
export const VICTIM_ID = '700000000000000004';

/** A fake Discord client that records every call and answers from `data`. */
export function fakeDiscord(data = defaultData()) {
  const calls = [];
  const rec = (name, ...args) => calls.push([name, ...args]);
  const notFound = () => new DiscordApiError(404, 10007, 'Unknown', '/x');
  const d = {
    guildId: GUILD,
    calls,
    data,
    guild: async () => data.guild,
    roles: async () => data.roles,
    channels: async () => data.channels,
    member: async (id) => {
      rec('member', id);
      if (!data.members[id]) throw notFound();
      return data.members[id];
    },
    searchMembers: async (q) => {
      rec('searchMembers', q);
      return Object.values(data.members).filter((m) => m.user.username.includes(q));
    },
    sendMessage: async (channelId, payload) => { rec('sendMessage', channelId, payload); return { id: '800000000000000001', channel_id: channelId }; },
    editMessage: async (c, m, p) => rec('editMessage', c, m, p),
    deleteMessage: async (c, m, r) => rec('deleteMessage', c, m, r),
    getMessage: async (c, m) => { rec('getMessage', c, m); return { id: m, content: 'old text', author: { id: BOT }, embeds: [{ title: 'T', description: 'D', color: 123, fields: [] }] }; },
    react: async (c, m, e) => rec('react', c, m, e),
    createChannel: async (p, r) => { rec('createChannel', p, r); return { id: '900000000000000001', name: p.name }; },
    patchChannel: async (id, p, r) => rec('patchChannel', id, p, r),
    deleteChannel: async (id, r) => rec('deleteChannel', id, r),
    createRole: async (p, r) => { rec('createRole', p, r); return { id: '900000000000000002', name: p.name }; },
    deleteRole: async (id, r) => rec('deleteRole', id, r),
    addRole: async (u, r) => rec('addRole', u, r),
    removeRole: async (u, r) => rec('removeRole', u, r),
    timeout: async (u, until, r) => rec('timeout', u, until, r),
    kick: async (u, r) => rec('kick', u, r),
    ban: async (u, o) => rec('ban', u, o),
    unban: async (u) => { rec('unban', u); if (u === '700000000000000099') throw notFound(); },
    dm: async (u, text) => { rec('dm', u, text); return true; },
    request: async (m, p) => { rec('request', m, p); return { id: BOT, username: 'bot' }; },
    rest: async (method, path, body) => {
      rec('rest', method, path, body);
      if (method === 'GET') return [];
      return {};
    },
  };
  return d;
}

export function makeServices({ discord = fakeDiscord(), kv = true, allowDevLogin = false, fetch, extraConfig = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'saa-web-'));
  const store = kv === true ? new FileKv(join(dir, 'kv.json')) : kv;
  const now = () => services.clock;
  const services = {
    clock: NOW,
    config: { guildId: GUILD, botToken: 't', clientId: '999', clientSecret: 'cs', sessionSecret: SECRET, baseUrl: '', allowDevLogin, ...extraConfig },
    discord,
    kv: store,
    now,
    guild: cached(() => discord.guild(), 0, now),
    roles: cached(() => discord.roles(), 0, now),
    channels: cached(() => discord.channels(), 0, now),
    botUser: cached(async () => ({ id: BOT }), 0, now),
    fetch: fetch ?? (async () => { throw new Error('unexpected fetch'); }),
  };
  return services;
}

export function sessionCookie(services, { uid = ADMIN_ID, level = 'admin', name = 'Tester', chk, exp, dev } = {}) {
  const payload = { uid, name, avatar: null, level, chk: chk ?? services.clock, exp: exp ?? services.clock + 3_600_000 };
  if (dev) payload.dev = true;
  return `saa_session=${encodeURIComponent(sign(payload, SECRET))}`;
}

export function makeReq({ method = 'GET', url = '/api/me', headers = {}, body, cookie } = {}) {
  const h = { host: 'dash.example.com', 'x-forwarded-proto': 'https', ...headers };
  if (cookie) h.cookie = cookie;
  if (method !== 'GET' && method !== 'HEAD' && h['x-saa'] === undefined) h['x-saa'] = '1';
  return { method, url, headers: h, body, socket: {} };
}

export function makeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(k, v) { res.headers[k.toLowerCase()] = v; },
    end(b) { res.body = b ?? ''; res.done = true; },
  };
  return res;
}

/** Runs one request through the real router and returns { status, json, headers }. */
export async function call(services, reqOptions) {
  resetLimitsOnce();
  const handler = createHandler(() => services);
  const req = makeReq(reqOptions);
  const res = makeRes();
  await handler(req, res);
  let json = null;
  try { json = res.body ? JSON.parse(res.body) : null; } catch { /* not json (redirects) */ }
  return { status: res.statusCode, json, headers: res.headers, location: res.headers.location };
}

let reset = false;
function resetLimitsOnce() {
  if (!reset) { reset = true; resetLimits(); }
}
export { resetLimits };
