import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { accessOverwrites } from '../lib/handlers/server.js';
import { KEYS } from '../lib/shared/kv.js';
import { createWarnStore } from '../lib/shared/warnStore.js';
import { ADMIN_ID, BOT, CHANNEL_IDS, DEV_ID, GUILD, MOD_ID, NOW, OWNER, ROLE_IDS, VICTIM_ID, call, fakeDiscord, makeServices, resetLimits, sessionCookie } from './helpers.js';

beforeEach(() => resetLimits());

const admin = (s) => sessionCookie(s, { uid: ADMIN_ID, level: 'admin', name: 'Dana' });
const staff = (s) => sessionCookie(s, { uid: MOD_ID, level: 'staff', name: 'Mo' });
const post = (s, url, body, cookie = admin(s)) => call(s, { method: 'POST', url, body, cookie });
const lastCall = (s, name) => s.discord.calls.filter((c) => c[0] === name).at(-1);
const auditEntries = (s) => s.kv.list(KEYS.audit, 50);

// ---- information ------------------------------------------------------------------------------------

test('/api/guild lists channels and roles, marks which roles can be pinged, hides @everyone', async () => {
  const s = makeServices();
  const { json } = await call(s, { url: '/api/guild', cookie: staff(s) });
  assert.deepEqual(json.channels.map((c) => c.name), ['Text', 'general', '📣｜announcements', 'General', '📜｜mod-log']);
  assert.ok(!json.roles.some((r) => r.id === GUILD));
  const pingable = json.roles.filter((r) => r.pingable).map((r) => r.name).sort();
  assert.deepEqual(pingable, ['Plain', '📣 Announcements'], 'opt-in ping roles and mentionable roles; never staff or managed roles');
  assert.equal(json.roles[0].name, 'Admin', 'highest role first');
});

test('/api/status reports the bot as online only when its heartbeat is recent, and shows a lockdown', async () => {
  const s = makeServices();
  assert.deepEqual((await call(s, { url: '/api/status', cookie: staff(s) })).json.bot, { online: false, at: null, ping: null });
  await s.kv.set(KEYS.heartbeat, { at: NOW - 60_000, guilds: 1, ping: 42 });
  await s.kv.set(KEYS.lockdown, { until: NOW + 600_000, by: { id: '1', name: 'Dana' } });
  const fresh = (await call(s, { url: '/api/status', cookie: staff(s) })).json;
  assert.equal(fresh.bot.online, true);
  assert.equal(fresh.bot.ping, 42);
  assert.deepEqual(fresh.lockdown, { until: NOW + 600_000, by: 'Dana' });
  s.clock += 10 * 60_000;
  assert.equal((await call(s, { url: '/api/status', cookie: sessionCookie(s, { uid: MOD_ID, level: 'staff', chk: s.clock }) })).json.bot.online, false, 'a stale heartbeat means offline');
});

test('without storage the read-only pages still answer and say storage is off', async () => {
  const s = makeServices({ kv: null });
  const c = staff(s);
  assert.equal((await call(s, { url: '/api/status', cookie: c })).json.redis, false);
  assert.deepEqual((await call(s, { url: '/api/leaderboard', cookie: c })).json, { entries: [], at: null });
  assert.deepEqual((await call(s, { url: '/api/activity', cookie: c })).json, { entries: [] });
  const settings = (await call(s, { url: '/api/settings', cookie: c })).json;
  assert.equal(settings.redis, false);
  assert.equal(settings.settings.automod.enabled, true, 'defaults are shown');
  const write = await call(s, { method: 'PUT', url: '/api/settings', body: { settings: {} }, cookie: admin(s) });
  assert.equal(write.status, 503);
  assert.match(write.json.error, /Upstash|Storage/);
});

// ---- sending messages -------------------------------------------------------------------------------

test('send: delivers the message, returns the link and records who sent it', async () => {
  const s = makeServices();
  const res = await post(s, '/api/send', { channelId: CHANNEL_IDS.announcements, content: 'Update 1.2 is live', embeds: [{ title: 'Patch notes', description: 'New aliens', color: '#2fbf71' }] }, staff(s));
  assert.equal(res.status, 200);
  assert.equal(res.json.link, `https://discord.com/channels/${GUILD}/${CHANNEL_IDS.announcements}/800000000000000001`);
  const [, channelId, payload] = lastCall(s, 'sendMessage');
  assert.equal(channelId, CHANNEL_IDS.announcements);
  assert.equal(payload.content, 'Update 1.2 is live');
  assert.equal(payload.embeds[0].color, 0x2fbf71);
  assert.deepEqual(payload.allowed_mentions, { parse: [], roles: [], users: [] });
  const [entry] = await auditEntries(s);
  assert.deepEqual([entry.source, entry.actor.name, entry.action, entry.target], ['web', 'Mo', 'Message sent', '#📣｜announcements']);
  assert.equal(s.discord.calls.filter((c) => c[0] === 'sendMessage').length, 1, 'a plain message is not mirrored to #mod-log');
});

test('send: pings are checked, and a ping is announced in #mod-log with who did it', async () => {
  const s = makeServices();
  const ok = await post(s, '/api/send', { channelId: CHANNEL_IDS.general, content: 'news', pingRoleIds: [ROLE_IDS.news] }, staff(s));
  assert.equal(ok.status, 200);
  const toGeneral = s.discord.calls.find((c) => c[0] === 'sendMessage' && c[1] === CHANNEL_IDS.general);
  assert.equal(toGeneral[2].content, `<@&${ROLE_IDS.news}>\nnews`);
  const modlogPost = s.discord.calls.filter((c) => c[0] === 'sendMessage' && c[1] === CHANNEL_IDS.modlog);
  assert.equal(modlogPost.length, 1);
  assert.match(JSON.stringify(modlogPost[0][2]), /Dashboard|dashboard|Message sent/);
  assert.match(JSON.stringify(modlogPost[0][2]), new RegExp(MOD_ID));

  const denied = await post(s, '/api/send', { channelId: CHANNEL_IDS.general, content: 'x', pingRoleIds: [ROLE_IDS.admin] }, admin(s));
  assert.equal(denied.status, 403, 'a staff role can never be pinged from the site');
  assert.equal((await post(s, '/api/send', { channelId: CHANNEL_IDS.general, content: 'x', pingEveryone: true }, staff(s))).status, 403);
  assert.equal((await post(s, '/api/send', { channelId: CHANNEL_IDS.general, content: 'x', pingEveryone: true }, admin(s))).status, 200);
});

test('send: rejects other servers\' channels, voice channels, bad ids and empty messages before calling Discord', async () => {
  const s = makeServices();
  const cases = [
    [{ channelId: CHANNEL_IDS.other, content: 'x' }, 422, /not in this server/],
    [{ channelId: CHANNEL_IDS.voice, content: 'x' }, 422, /text channel/],
    [{ channelId: CHANNEL_IDS.cat, content: 'x' }, 422, /text channel/],
    [{ channelId: 'abc', content: 'x' }, 422, /valid Discord id/],
    [{ channelId: CHANNEL_IDS.general }, 422, /Write some text/],
    [{ channelId: CHANNEL_IDS.general, content: 'x'.repeat(2001) }, 422, /2000/],
    [{ channelId: CHANNEL_IDS.general, embeds: [{ title: 'a', image: 'http://insecure.example/x.png' }] }, 422, /https/],
  ];
  for (const [body, status, re] of cases) {
    const res = await post(s, '/api/send', body, staff(s));
    assert.equal(res.status, status, JSON.stringify(body).slice(0, 60));
    assert.match(res.json.error, re);
  }
  assert.equal(s.discord.calls.filter((c) => c[0] === 'sendMessage').length, 0);
});

test('send: a script hammering the endpoint is stopped at 15 messages a minute', async () => {
  const s = makeServices();
  const results = [];
  for (let i = 0; i < 17; i++) results.push((await post(s, '/api/send', { channelId: CHANNEL_IDS.general, content: `m${i}` }, staff(s))).status);
  assert.deepEqual(results.slice(0, 15), Array(15).fill(200));
  assert.deepEqual(results.slice(15), [429, 429]);
});

test('send: a Discord refusal becomes advice, not a stack trace', async () => {
  const s = makeServices();
  const { DiscordApiError } = await import('../lib/discord.js');
  s.discord.sendMessage = async () => { throw new DiscordApiError(403, 50013, 'Missing Permissions', '/x'); };
  const res = await post(s, '/api/send', { channelId: CHANNEL_IDS.general, content: 'x' }, staff(s));
  assert.equal(res.status, 502);
  assert.match(res.json.error, /Missing Permissions.*higher role/);
  assert.doesNotMatch(JSON.stringify(res.json), /stack|at Object|\.js:\d+/);
});

test('edit / delete / react / lookup work from a pasted message link and refuse links from other servers', async () => {
  const s = makeServices();
  const link = `https://discord.com/channels/${GUILD}/${CHANNEL_IDS.general}/800000000000000009`;
  const other = `https://discord.com/channels/999999999999999999/${CHANNEL_IDS.general}/800000000000000009`;

  const looked = await call(s, { url: `/api/messages/lookup?link=${encodeURIComponent(link)}`, cookie: staff(s) });
  assert.equal(looked.json.editable, true, 'the bot wrote it');
  assert.equal(looked.json.embeds[0].title, 'T');
  assert.equal((await call(s, { url: `/api/messages/lookup?link=${encodeURIComponent(other)}`, cookie: staff(s) })).status, 422);
  assert.equal((await call(s, { url: '/api/messages/lookup?link=junk', cookie: staff(s) })).status, 422);

  assert.equal((await post(s, '/api/messages/edit', { link, content: 'fixed text', embeds: [] }, staff(s))).status, 200);
  const [, , , patch] = lastCall(s, 'editMessage');
  assert.equal(patch.content, 'fixed text');
  assert.deepEqual(patch.embeds, [], 'removing the embeds is explicit');
  assert.equal(patch.message_reference, undefined);

  assert.equal((await post(s, '/api/messages/react', { link, emoji: '👍' }, staff(s))).status, 200);
  assert.deepEqual(lastCall(s, 'react').slice(1), [CHANNEL_IDS.general, '800000000000000009', '👍']);
  assert.equal((await post(s, '/api/messages/react', { link, emoji: '../x' }, staff(s))).status, 422);

  assert.equal((await post(s, '/api/messages/delete', { link }, staff(s))).status, 200);
  assert.match(lastCall(s, 'deleteMessage')[3], /Mo/, 'the audit-log reason names the person');
  assert.equal((await post(s, '/api/messages/edit', { link: other, content: 'x' }, staff(s))).status, 422);
});

test('edit never re-pings, even if the form still carries the ping fields', async () => {
  const s = makeServices();
  const link = `https://discord.com/channels/${GUILD}/${CHANNEL_IDS.general}/800000000000000009`;
  const res = await post(s, '/api/messages/edit', { link, content: 'x', pingEveryone: true, pingRoleIds: [ROLE_IDS.news] }, admin(s));
  assert.equal(res.status, 200);
  const patch = lastCall(s, 'editMessage')[3];
  assert.equal(patch.content, 'x');
  assert.deepEqual(patch.allowed_mentions, { parse: [], roles: [], users: [] });
});

// ---- channels and roles -----------------------------------------------------------------------------

test('accessOverwrites builds the four presets with Discord permission bits as strings', () => {
  const ids = { guildId: GUILD, adminRoleId: ROLE_IDS.admin, modRoleId: ROLE_IDS.mod, botId: BOT };
  assert.deepEqual(accessOverwrites('chat', ids), []);
  const read = accessOverwrites('read', ids);
  assert.equal(read[0].id, GUILD);
  assert.equal(BigInt(read[0].deny) & (1n << 11n), 1n << 11n, 'everyone cannot send');
  assert.equal(BigInt(read[0].deny) & (1n << 10n), 0n, 'but can still see it');
  const hiddenStaff = accessOverwrites('staff', ids);
  assert.equal(BigInt(hiddenStaff[0].deny) & (1n << 10n), 1n << 10n);
  assert.deepEqual(hiddenStaff.slice(1, 3).map((o) => o.id), [ROLE_IDS.admin, ROLE_IDS.mod]);
  const admins = accessOverwrites('hidden', ids);
  assert.equal(admins.filter((o) => o.id === ROLE_IDS.mod).length, 0, 'hidden is admins only (they have Administrator)');
  assert.ok(typeof read[0].allow === 'string' && typeof read[0].deny === 'string', 'API wants strings');
  assert.ok(accessOverwrites('staff', ids).every((o, i, all) => all.findIndex((x) => x.id === o.id) === i), 'no duplicate ids');
});

test('create channel: validates, builds overwrites, rejects a bad category, and only admins may', async () => {
  const s = makeServices();
  const res = await post(s, '/api/channels', { name: 'game-night', type: 'voice', access: 'staff', parentId: CHANNEL_IDS.cat });
  assert.equal(res.status, 200);
  const [, payload] = lastCall(s, 'createChannel');
  assert.equal(payload.type, 2);
  assert.equal(payload.parent_id, CHANNEL_IDS.cat);
  assert.equal(payload.permission_overwrites[0].id, GUILD);
  assert.equal(payload.permission_overwrites.some((o) => o.id === ROLE_IDS.mod), true, 'the 🛡 Moderator role is found despite the emoji');

  for (const [body, re] of [
    [{ name: '', type: 'text' }, /Name is required/],
    [{ name: 'x', type: 'forum' }, /text, voice or category/],
    [{ name: 'x', type: 'text', access: 'everyone-admin' }, /Unknown access/],
    [{ name: 'x', type: 'text', parentId: CHANNEL_IDS.general }, /category does not exist/],
  ]) {
    const bad = await post(s, '/api/channels', body);
    assert.equal(bad.status, 422);
    assert.match(bad.json.error, re);
  }
  assert.equal((await post(s, '/api/channels', { name: 'x', type: 'text' }, staff(s))).status, 403);
});

test('edit and delete channel: slowmode range, name confirmation, and not-this-server ids', async () => {
  const s = makeServices();
  const patch = (id, body, cookie = admin(s)) => call(s, { method: 'PATCH', url: `/api/channels/${id}`, body, cookie });
  const del = (id, body, cookie = admin(s)) => call(s, { method: 'DELETE', url: `/api/channels/${id}`, body, cookie });
  assert.equal((await patch(CHANNEL_IDS.general, { name: 'main-chat', rateLimitPerUser: 10 })).status, 200);
  assert.deepEqual(lastCall(s, 'patchChannel')[2], { name: 'main-chat', rate_limit_per_user: 10 });
  assert.equal((await patch(CHANNEL_IDS.general, { rateLimitPerUser: 99999 })).status, 422);
  assert.equal((await patch(CHANNEL_IDS.general, {})).status, 422);
  assert.equal((await patch(CHANNEL_IDS.other, { name: 'x' })).status, 404);

  assert.equal((await del(CHANNEL_IDS.general, {})).status, 422, 'no confirmation');
  assert.equal((await del(CHANNEL_IDS.general, { confirm: 'wrong' })).status, 422);
  assert.equal(s.discord.calls.filter((c) => c[0] === 'deleteChannel').length, 0);
  assert.equal((await del(CHANNEL_IDS.general, { confirm: 'general' })).status, 200);
  assert.equal(lastCall(s, 'deleteChannel')[1], CHANNEL_IDS.general);
  assert.equal((await del(CHANNEL_IDS.general, { confirm: 'general' }, staff(s))).status, 403);
});

test('roles: create, delete with confirmation, never managed roles or @everyone', async () => {
  const s = makeServices();
  assert.equal((await post(s, '/api/roles', { name: 'VIP', color: '#ff8800', hoist: true })).status, 200);
  assert.deepEqual(lastCall(s, 'createRole')[1], { name: 'VIP', color: 0xff8800, hoist: true, mentionable: false, permissions: '0' }, 'no permissions unless set in Discord');
  assert.equal((await post(s, '/api/roles', { name: 'x', color: 'zzz' })).status, 422);

  const del = (id, body) => call(s, { method: 'DELETE', url: `/api/roles/${id}`, body, cookie: admin(s) });
  assert.equal((await del(ROLE_IDS.botrole, { confirm: 'Some Bot' })).status, 422, 'bot-managed');
  assert.equal((await del(GUILD, { confirm: '@everyone' })).status, 404);
  assert.equal((await del(ROLE_IDS.plain, { confirm: 'nope' })).status, 422);
  assert.equal((await del(ROLE_IDS.plain, { confirm: 'Plain' })).status, 200);
  assert.equal(lastCall(s, 'deleteRole')[1], ROLE_IDS.plain);
});

test('giving roles from the site: never Administrator roles or bot roles; clear errors', async () => {
  const s = makeServices();
  const res = await post(s, '/api/members/roles', { userId: VICTIM_ID, add: [ROLE_IDS.news], remove: [ROLE_IDS.plain] });
  assert.equal(res.status, 200);
  assert.deepEqual(lastCall(s, 'addRole').slice(1, 3), [VICTIM_ID, ROLE_IDS.news]);
  assert.deepEqual(lastCall(s, 'removeRole').slice(1, 3), [VICTIM_ID, ROLE_IDS.plain]);
  const boss = await post(s, '/api/members/roles', { userId: VICTIM_ID, add: [ROLE_IDS.boss] });
  assert.equal(boss.status, 403);
  assert.match(boss.json.error, /Administrator/);
  assert.equal((await post(s, '/api/members/roles', { userId: VICTIM_ID, add: [ROLE_IDS.botrole] })).status, 422);
  assert.equal((await post(s, '/api/members/roles', { userId: VICTIM_ID, add: [GUILD] })).status, 422);
  assert.equal((await post(s, '/api/members/roles', { userId: VICTIM_ID })).status, 422);
  assert.equal((await post(s, '/api/members/roles', { userId: 'x', add: [ROLE_IDS.news] })).status, 422);
});

// ---- settings ---------------------------------------------------------------------------------------

test('saving settings stores the normalised version and pushes AutoMod rules to Discord', async () => {
  const s = makeServices();
  const res = await call(s, { method: 'PUT', url: '/api/settings', cookie: admin(s), body: { settings: { automod: { mentions: { limit: 9999 }, customWords: { enabled: true, words: ['Foo', 'foo', ' bar '] } }, evil: 1 } } });
  assert.equal(res.status, 200);
  assert.equal(res.json.settings.automod.mentions.limit, 50, 'clamped');
  assert.deepEqual(res.json.settings.automod.customWords.words, ['foo', 'bar']);
  assert.equal(res.json.settings.evil, undefined);
  assert.deepEqual(await s.kv.get(KEYS.settings), res.json.settings);

  const posts = s.discord.calls.filter((c) => c[0] === 'rest' && c[1] === 'POST');
  const names = posts.map((c) => c[3].name);
  assert.ok(names.includes('SAA - Spam') && names.includes('SAA - Custom words') && names.includes('SAA - Scams'), names.join());
  const spam = posts.find((c) => c[3].name === 'SAA - Spam')[3];
  assert.equal(spam.actions.find((a) => a.type === 2).metadata.channel_id, CHANNEL_IDS.modlog, 'alerts go to #mod-log');
  assert.deepEqual(spam.exempt_roles.sort(), [ROLE_IDS.admin, ROLE_IDS.mod, ROLE_IDS.dev].sort(), 'exempt role names are matched even with emoji');
  assert.equal(res.json.sync.errors.length, 0);
  assert.equal((await auditEntries(s))[0].action, 'Settings saved');
});

test('settings: AutoMod sync trouble is reported but the settings are still saved', async () => {
  const s = makeServices();
  s.discord.rest = async (method) => { if (method === 'GET') return []; throw new Error('Maximum number of rules reached'); };
  const res = await call(s, { method: 'PUT', url: '/api/settings', cookie: admin(s), body: { settings: {} } });
  assert.equal(res.status, 200);
  assert.ok(res.json.sync.errors.length > 0);
  assert.ok(await s.kv.get(KEYS.settings), 'saved anyway; the bot will retry the sync');
  s.discord.rest = async () => { throw new Error('Discord is down'); };
  const down = await call(s, { method: 'PUT', url: '/api/settings', cookie: admin(s), body: { settings: {} } });
  assert.equal(down.status, 200);
  assert.match(down.json.sync.errors[0], /Discord is down/);
});

test('GET /api/settings returns stored values and tells whether anything was ever saved', async () => {
  const s = makeServices();
  assert.equal((await call(s, { url: '/api/settings', cookie: staff(s) })).json.stored, false);
  await call(s, { method: 'PUT', url: '/api/settings', cookie: admin(s), body: { settings: { raid: { joins: 12 } } } });
  const got = (await call(s, { url: '/api/settings', cookie: staff(s) })).json;
  assert.equal(got.stored, true);
  assert.equal(got.settings.raid.joins, 12);
});

// ---- jobs for the bot -------------------------------------------------------------------------------

test('lockdown request becomes a queued job carrying who asked; the answer says if the bot looks offline', async () => {
  const s = makeServices();
  const offline = await post(s, '/api/lockdown', { on: true, minutes: 30 }, staff(s));
  assert.equal(offline.status, 200);
  assert.equal(offline.json.queued, true);
  assert.equal(offline.json.botOnline, false);
  const [job] = await s.kv.list(KEYS.jobs, 5);
  assert.deepEqual([job.type, job.payload, job.by, job.guildId], ['lockdown', { on: true, minutes: 30 }, { id: MOD_ID, name: 'Mo' }, GUILD]);
  await s.kv.set(KEYS.heartbeat, { at: s.clock - 1000 });
  assert.equal((await post(s, '/api/lockdown', { on: false }, staff(s))).json.botOnline, true);
  assert.equal((await s.kv.list(KEYS.jobs, 5))[0].payload.on, false);
  assert.equal((await post(s, '/api/lockdown', { on: true, minutes: 99999 }, staff(s))).status, 200);
  assert.equal((await s.kv.list(KEYS.jobs, 1))[0].payload.minutes, 1440, 'capped at a day');
});

test('panel refresh: admins only, known panels only, and it needs storage', async () => {
  const s = makeServices();
  assert.equal((await post(s, '/api/panels/repost', { panel: 'welcome' })).status, 200);
  assert.equal((await post(s, '/api/panels/repost', { panel: 'constructor' })).status, 422);
  assert.equal((await post(s, '/api/panels/repost', { panel: 'welcome' }, staff(s))).status, 403);
  const none = makeServices({ kv: null });
  assert.equal((await post(none, '/api/panels/repost', { panel: 'welcome' })).status, 503);
  assert.equal((await post(none, '/api/lockdown', { on: true })).status, 503);
});

// ---- members and moderation -------------------------------------------------------------------------

test('member search needs 2+ characters and shows each person\'s staff level, roles and timeout', async () => {
  const s = makeServices();
  assert.equal((await call(s, { url: '/api/members/search?q=a', cookie: staff(s) })).status, 422);
  const { json } = await call(s, { url: '/api/members/search?q=user', cookie: staff(s) });
  const byName = Object.fromEntries(json.members.map((m) => [m.username, m]));
  assert.equal(byName.adminuser.level, 'admin');
  assert.equal(byName.moduser.level, 'staff');
  assert.equal(byName.moduser.name, 'Mod User');
  assert.equal(byName.devuser.level, null);
  assert.deepEqual(byName.moduser.roles.map((r) => r.name), ['🛡 Moderator']);
});

test('moderation ladder: nobody acts on themselves, the bot, the owner or an admin; only admins act on staff', async () => {
  const s = makeServices();
  const ban = (userId, cookie) => post(s, '/api/mod/ban', { userId, reason: 'test' }, cookie);
  assert.equal((await ban(MOD_ID, staff(s))).status, 403, 'self');
  assert.equal((await ban(BOT, staff(s))).status, 403, 'bot');
  assert.equal((await ban(OWNER, admin(s))).status, 403, 'owner, even for admins');
  assert.equal((await ban(ADMIN_ID, staff(s))).status, 403, 'admin target');
  assert.match((await ban(ADMIN_ID, sessionCookie(s, { uid: OWNER, level: 'admin' }))).json.error, /Admins cannot be moderated/);
  assert.equal((await post(s, '/api/mod/kick', { userId: MOD_ID }, sessionCookie(s, { uid: DEV_ID, level: 'staff' }))).status, 403, 'staff cannot act on staff');
  assert.equal((await post(s, '/api/mod/kick', { userId: MOD_ID }, admin(s))).status, 200, 'an admin can act on staff');
  assert.equal(s.discord.calls.filter((c) => c[0] === 'ban').length, 0, 'none of the refused bans went out');
});

test('warn: saved with who did it, DM sent, and the third warning escalates to a 60 minute timeout', async () => {
  const s = makeServices();
  for (let i = 1; i <= 3; i++) {
    const res = await post(s, '/api/mod/warn', { userId: VICTIM_ID, reason: `reason ${i}` }, staff(s));
    assert.equal(res.status, 200);
    assert.equal(res.json.count, i);
    assert.equal(res.json.outcome, i === 3 ? 'timed out for 60 minute(s)' : null);
  }
  const warns = await createWarnStore(s.kv).get(GUILD, VICTIM_ID);
  assert.equal(warns.length, 3);
  assert.deepEqual(warns[0].by, { id: MOD_ID, name: 'Mo (dashboard)' });
  assert.equal(s.discord.calls.filter((c) => c[0] === 'dm').length, 3);
  const [, userId, until] = lastCall(s, 'timeout');
  assert.equal(userId, VICTIM_ID);
  assert.ok(Math.abs(Date.parse(until) - (NOW + 3_600_000)) < 1000);
  assert.equal((await post(s, '/api/mod/warn', { userId: VICTIM_ID, reason: 'ab' }, staff(s))).status, 422, 'a reason is required');
  const none = makeServices({ kv: null });
  assert.equal((await post(none, '/api/mod/warn', { userId: VICTIM_ID, reason: 'enough text' }, staff(none))).status, 503);
});

test('warn escalation follows the saved settings (kick at 2 here), and a failing step is reported not hidden', async () => {
  const s = makeServices();
  await s.kv.set(KEYS.settings, { automod: { warns: { escalation: [{ at: 2, action: 'kick' }] } } });
  await post(s, '/api/mod/warn', { userId: VICTIM_ID, reason: 'first warning' }, staff(s));
  s.discord.kick = async () => { throw new Error('Missing Permissions'); };
  const second = await post(s, '/api/mod/warn', { userId: VICTIM_ID, reason: 'second warning' }, staff(s));
  assert.equal(second.status, 200);
  assert.match(second.json.outcome, /automatic kick failed: Missing Permissions/);
});

test('unwarn removes one warning by id or clears all, and says when the id does not exist', async () => {
  const s = makeServices();
  const store = createWarnStore(s.kv);
  const a = await store.add(GUILD, VICTIM_ID, { by: { id: '1', name: 'x' }, reason: 'one' });
  await store.add(GUILD, VICTIM_ID, { by: { id: '1', name: 'x' }, reason: 'two' });
  assert.equal((await post(s, '/api/mod/unwarn', { userId: VICTIM_ID, warnId: 'nope' }, staff(s))).status, 404);
  assert.equal((await post(s, '/api/mod/unwarn', { userId: VICTIM_ID, warnId: a.warn.id }, staff(s))).json.left, 1);
  assert.equal((await post(s, '/api/mod/unwarn', { userId: VICTIM_ID, all: true }, staff(s))).json.left, 0);
  assert.deepEqual(await store.get(GUILD, VICTIM_ID), []);
});

test('timeout, untimeout, kick, ban and unban validate input and reach Discord with an audit reason', async () => {
  const s = makeServices();
  assert.equal((await post(s, '/api/mod/timeout', { userId: VICTIM_ID, minutes: 0 }, staff(s))).status, 422);
  assert.equal((await post(s, '/api/mod/timeout', { userId: VICTIM_ID, minutes: 40321 }, staff(s))).status, 422);
  assert.equal((await post(s, '/api/mod/timeout', { userId: VICTIM_ID, minutes: 10, reason: 'cooling off' }, staff(s))).status, 200);
  let [, , until, reason] = lastCall(s, 'timeout');
  assert.ok(Math.abs(Date.parse(until) - (NOW + 600_000)) < 1000);
  assert.match(reason, /Mo \(dashboard\): cooling off/);
  assert.equal((await post(s, '/api/mod/untimeout', { userId: VICTIM_ID }, staff(s))).status, 200);
  assert.equal(lastCall(s, 'timeout')[2], null);

  assert.equal((await post(s, '/api/mod/kick', { userId: VICTIM_ID, reason: 'rule 3' }, staff(s))).status, 200);
  assert.equal(lastCall(s, 'dm')[1], VICTIM_ID, 'the person is told first');

  assert.equal((await post(s, '/api/mod/ban', { userId: VICTIM_ID, reason: 'spam', deleteDays: 8 }, staff(s))).status, 422);
  assert.equal((await post(s, '/api/mod/ban', { userId: VICTIM_ID, reason: 'spam', deleteDays: 2 }, staff(s))).status, 200);
  assert.equal(lastCall(s, 'ban')[2].deleteSeconds, 172_800);

  const absent = '700000000000000050';
  assert.equal((await post(s, '/api/mod/ban', { userId: absent, reason: 'seen in raid' }, staff(s))).status, 200, 'banning someone who already left is allowed');
  assert.equal((await post(s, '/api/mod/kick', { userId: absent }, staff(s))).status, 404, 'but you cannot kick someone who is not here');

  assert.equal((await post(s, '/api/mod/unban', { userId: VICTIM_ID }, staff(s))).status, 200);
  const notBanned = await post(s, '/api/mod/unban', { userId: '700000000000000099' }, staff(s));
  assert.equal(notBanned.status, 404);
  assert.match(notBanned.json.error, /not banned/);
});

test('every moderation action is written to the activity log and announced in #mod-log', async () => {
  const s = makeServices();
  await post(s, '/api/mod/timeout', { userId: VICTIM_ID, minutes: 5 }, staff(s));
  const [entry] = await auditEntries(s);
  assert.deepEqual([entry.action, entry.target, entry.actor.id], ['Timeout', VICTIM_ID, MOD_ID]);
  const announced = s.discord.calls.filter((c) => c[0] === 'sendMessage' && c[1] === CHANNEL_IDS.modlog);
  assert.equal(announced.length, 1);
  assert.deepEqual(announced[0][2].allowed_mentions, { parse: [] }, 'the log post cannot ping anyone');
});

test('member detail includes the warning history; the warned list shows names and counts', async () => {
  const s = makeServices();
  const store = createWarnStore(s.kv);
  await store.add(GUILD, VICTIM_ID, { by: { id: '1', name: 'x' }, reason: 'spam' });
  await store.add(GUILD, '700000000000000077', { by: null, reason: 'left the server' });
  const detail = await call(s, { url: `/api/members/${VICTIM_ID}`, cookie: staff(s) });
  assert.equal(detail.json.warns.length, 1);
  assert.equal(detail.json.member.username, 'victim');
  assert.equal((await call(s, { url: '/api/members/700000000000000098', cookie: staff(s) })).status, 404);
  const warned = (await call(s, { url: '/api/members/warned', cookie: staff(s) })).json.users;
  assert.deepEqual(warned.map((u) => [u.id, u.count, u.inServer]).sort(), [[VICTIM_ID, 1, true], ['700000000000000077', 1, false]].sort());
});

test('the activity log endpoint returns newest first and caps the limit', async () => {
  const s = makeServices();
  for (let i = 0; i < 5; i++) await s.kv.push(KEYS.audit, { at: i, action: `a${i}` }, 300);
  const res = await call(s, { url: '/api/activity?limit=3', cookie: staff(s) });
  assert.deepEqual(res.json.entries.map((e) => e.action), ['a4', 'a3', 'a2']);
  assert.equal((await call(s, { url: '/api/activity?limit=99999', cookie: staff(s) })).json.entries.length, 5);
});
