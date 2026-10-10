import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { ChannelType, Collection, PermissionFlagsBits as P } from 'discord.js';
import { desiredRules, syncNativeAutoMod } from '../src/automod.js';
import { handleButton } from '../src/buttons.js';
import { IDS, welcomePanel } from '../src/content.js';
import { applyGate, verifyMember } from '../src/gate.js';
import { SpamTracker, capsRatio, capsViolation, guardMessage, hostAllowed, isExempt, linkHosts, linkViolation } from '../src/guards.js';
import { HANDLERS, processJobs } from '../src/jobs.js';
import { PANELS, syncPanel } from '../src/panels.js';
import { resetLockdownCache } from '../src/lockdown.js';
import { RaidGuard, accountTooNew, checkAccountAge, detectRaid, handleJoin } from '../src/raid.js';
import { runtime } from '../src/runtime.js';
import { FileKv } from '../src/shared/kv.js';
import { RULE_PREFIX } from '../src/shared/automodRules.js';
import { normalizeSettings } from '../src/shared/settings.js';
import { getWarns, resetTempBanCache } from '../src/warns.js';

const DAY = 86_400_000;
const dirs = [];
beforeEach(() => {
  resetLockdownCache();
  resetTempBanCache();
  const dir = mkdtempSync(join(tmpdir(), 'saa-auto-'));
  dirs.push(dir);
  runtime.kv = new FileKv(join(dir, 'kv.json'));
  runtime.settings = normalizeSettings({});
  runtime.features = { members: true, content: true };
  runtime.tempRooms = new Set();
});
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

const cfg = () => normalizeSettings({}).automod;

// ---- pure checks ------------------------------------------------------------------------------

test('capsRatio ignores short texts and scripts without case (Hebrew)', () => {
  assert.equal(capsRatio('HELLO', 12), null, 'too short to judge');
  assert.equal(capsRatio('שלום לכולם איך הולך היום', 5), null, 'Hebrew has no capitals');
  assert.equal(capsRatio('1234567890 !!!', 5), null);
  assert.equal(Math.round(capsRatio('HELLO EVERYBODY HOW ARE YOU', 12)), 100);
  assert.equal(Math.round(capsRatio('Hello Everybody how are you today friend', 12)), 6, '2 capitals out of 33 letters');
});

test('caps: Arabic and emoji-only texts are ignored, long shouted texts are caught, Hebrew is only ignored for its own letters', () => {
  const caps = { enabled: true, minLength: 12, percent: 70 };
  assert.equal(capsViolation('مرحبا بالجميع كيف الحال اليوم يا أصدقاء', caps), null, 'Arabic has no case');
  assert.equal(capsViolation('😀😀😀😂😂😂🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥', caps), null, 'emoji only: no letters');
  assert.equal(capsViolation('!!!!! ????? ..... 12345678901234', caps), null);
  assert.match(capsViolation('SHOUTING '.repeat(500), caps), /capital letters/, 'a very long shouted text is caught');
  assert.equal(capsViolation('שלום לכולם '.repeat(300), caps), null, 'a very long Hebrew text is not caps');
  assert.match(capsViolation('שלום לכולם ' + 'HELLO EVERYONE HOW ARE YOU', caps), /capital letters/, 'Hebrew does not dilute the English shouting');
  assert.doesNotThrow(() => capsRatio('a'.repeat(100_000), 12));
});

test('capsViolation fires at the configured percentage only', () => {
  const caps = { enabled: true, minLength: 12, percent: 70 };
  assert.match(capsViolation('STOP SHOUTING AT EVERYONE HERE', caps), /capital letters/);
  assert.equal(capsViolation('This Is A Normal Sentence With Some Caps', caps), null);
  assert.equal(capsViolation('OK FINE', caps), null, 'short message is fine');
});

test('linkHosts extracts hosts and hostAllowed matches subdomains but not look-alikes', () => {
  assert.deepEqual(linkHosts('see https://www.Roblox.com/games/1 and http://evil.com:8080/x?y=1 or https://user:pw@sneaky.io/'), ['www.roblox.com', 'evil.com', 'sneaky.io']);
  assert.deepEqual(linkHosts('no links here, just words and 3.14 numbers'), []);
  const allow = ['roblox.com', 'youtu.be'];
  assert.ok(hostAllowed('roblox.com', allow) && hostAllowed('www.roblox.com', allow) && hostAllowed('youtu.be', allow));
  assert.ok(!hostAllowed('notroblox.com', allow), 'suffix without a dot boundary must not match');
  assert.ok(!hostAllowed('roblox.com.evil.io', allow));
});

test('linkHosts sees links Discord shows without http:// (so the allow-list cannot be skipped), but not file names', () => {
  assert.deepEqual(linkHosts('check scam.gg/free now'), ['scam.gg']);
  assert.deepEqual(linkHosts('roblox.com.evil.io'), ['roblox.com.evil.io']);
  assert.deepEqual(linkHosts('look at my image.png and notes.txt and e.g. this'), [], 'file names and "e.g" are not links');
  assert.deepEqual(linkHosts('(see https://roblox.com/games)'), ['roblox.com'], 'a closing bracket does not become part of the host');
  assert.match(linkViolation('free robux at scam.gg/claim', { mode: 'allowlist', allow: ['roblox.com'] }), /scam\.gg/);
});

test('hostAllowed: upper case, trailing dot, ports, userinfo and punycode look-alikes are handled', () => {
  assert.deepEqual(linkHosts('https://roblox.com@evil.com/x'), ['evil.com'], 'userinfo is not the host');
  assert.deepEqual(linkHosts('https://user:pw@sneaky.io:8443/'), ['sneaky.io']);
  assert.ok(hostAllowed('ROBLOX.com.', ['roblox.com']), 'case and trailing dot');
  assert.ok(hostAllowed('youtu.be', ['YOUTU.BE']), 'allow-list entries in any case');
  assert.ok(hostAllowed('youtu.be', ['youtu.be.']), 'allow-list entries with a trailing dot');
  assert.ok(!hostAllowed('xn--robl0x-9xa.com', ['roblox.com']), 'punycode look-alike is not allowed');
  assert.ok(!hostAllowed('roblox.com.xn--p1ai', ['roblox.com']), 'roblox.com followed by another TLD is not allowed');
  assert.ok(!hostAllowed('evil.com', ['']), 'an empty allow entry allows nothing');
  const links = { mode: 'allowlist', allow: ['roblox.com'] };
  assert.equal(linkViolation('https://roblox.com:443/games/1', links), null, 'port is ignored');
  assert.match(linkViolation('https://roblox.com@evil.com/games', links), /evil\.com/, 'userinfo trick is caught');
});

test('linkViolation only acts in allowlist mode and names the first bad host', () => {
  const links = { mode: 'allowlist', allow: ['roblox.com'] };
  assert.equal(linkViolation('https://roblox.com/x', links), null);
  assert.match(linkViolation('https://roblox.com/x and https://scam.gg/y', links), /scam\.gg/);
  assert.equal(linkViolation('https://scam.gg', { mode: 'off', allow: [] }), null);
});

test('SpamTracker: flood fires at the threshold inside the window and reports the message ids', () => {
  const t = new SpamTracker();
  const c = cfg();
  let hit = null;
  for (let i = 0; i < 6; i++) hit = t.record({ userId: 'f1', id: `m${i}`, channelId: 'c', content: `hello ${i}`, now: 1000 + i * 500 }, c);
  assert.equal(hit.type, 'flood');
  assert.deepEqual(hit.ids.map((x) => x.id), ['m0', 'm1', 'm2', 'm3', 'm4', 'm5']);
});

test('SpamTracker: slow chatting never triggers, even with many messages', () => {
  const t = new SpamTracker();
  for (let i = 0; i < 40; i++) assert.equal(t.record({ userId: 'slow', id: `m${i}`, channelId: 'c', content: `msg ${i}`, now: i * 3000 }, cfg()), null);
});

test('SpamTracker: the same text 3 times in 30s is a duplicate, case and spaces ignored', () => {
  const t = new SpamTracker();
  const c = cfg();
  assert.equal(t.record({ userId: 'd1', id: 'a', channelId: 'c', content: 'Buy now', now: 0 }, c), null);
  assert.equal(t.record({ userId: 'd1', id: 'b', channelId: 'c', content: ' buy NOW ', now: 5000 }, c), null);
  assert.equal(t.record({ userId: 'd1', id: 'x', channelId: 'c', content: 'something else', now: 6000 }, c), null);
  const hit = t.record({ userId: 'd1', id: 'c3', channelId: 'c', content: 'buy now', now: 9000 }, c);
  assert.equal(hit.type, 'duplicates');
  assert.deepEqual(hit.ids.map((x) => x.id), ['a', 'b', 'c3']);
});

test('SpamTracker: repeated short or empty content is not counted as duplicates (e.g. intent off)', () => {
  const t = new SpamTracker();
  for (let i = 0; i < 5; i++) assert.equal(t.record({ userId: 'e1', id: `m${i}`, channelId: 'c', content: '', now: i * 20_000 }, cfg()), null);
});

test('SpamTracker: respects disabled switches and sweeps quiet members', () => {
  const t = new SpamTracker();
  const off = normalizeSettings({ automod: { flood: { enabled: false }, duplicates: { enabled: false } } }).automod;
  for (let i = 0; i < 10; i++) assert.equal(t.record({ userId: 'o1', id: `m${i}`, channelId: 'c', content: 'same', now: i * 100 }, off), null);
  t.sweep(10 * 60_000);
  assert.equal(t.events.size, 0);
});

// ---- enforcement with fakes -------------------------------------------------------------------

function fakeRoles(...names) {
  return new Collection(names.map((n, i) => [`role-${n}`, { id: `role-${n}`, name: n, position: i + 1 }]));
}

function fakeMember(id, { admin = false, manage = false, roles = [], moderatable = true, kickable = true, createdTimestamp = Date.now() - 400 * DAY } = {}) {
  const calls = [];
  return {
    id,
    calls,
    moderatable,
    kickable,
    user: { id, tag: `${id}#1`, bot: false, createdTimestamp, toString: () => `<@${id}>`, send: async (t) => calls.push(['dm', t]) },
    permissions: { has: (p) => (p === P.Administrator ? admin : p === P.ManageMessages ? manage : false) },
    roles: { cache: fakeRoles(...roles) },
    timeout: async (ms, reason) => calls.push(['timeout', ms, reason]),
    kick: async (reason) => calls.push(['kick', reason]),
    toString: () => `<@${id}>`,
  };
}

function fakeGuild() {
  const channels = new Collection();
  const guild = {
    id: '999',
    name: 'Test',
    channels: { cache: channels },
    members: { cache: new Collection(), fetch: async () => new Collection(), ban: async () => {}, fetchMe: async () => ({ id: 'bot' }) },
    roles: { cache: fakeRoles('Member', 'Moderator'), fetch: async () => {} },
    client: { user: { id: 'bot', tag: 'bot#0', toString: () => '<@bot>' } },
    puts: [],
  };
  guild.client.rest = { put: async (route, o) => guild.puts.push({ route, body: o.body }), get: async () => [], post: async () => ({}), patch: async () => ({}), delete: async () => {} };
  const mk = (id, name, extra = {}) => {
    const c = {
      id,
      name,
      type: ChannelType.GuildText,
      topic: null,
      sent: [],
      deleted: [],
      bulk: [],
      send: async (p) => { c.sent.push(p); return { delete: async () => {} }; },
      bulkDelete: async (ids) => c.bulk.push(ids),
      messages: { delete: async (id2) => c.deleted.push(id2) },
      isVoiceBased: () => false,
      ...extra,
    };
    channels.set(id, c);
    return c;
  };
  guild.general = mk('100001', 'general');
  guild.modlog = mk('100002', '📜｜mod-log');
  return { guild, mk };
}

function fakeMessage(guild, member, content, { id = String(Math.random()), at = Date.now() } = {}) {
  return {
    id,
    content,
    guild,
    member,
    author: member.user,
    channel: guild.general,
    channelId: guild.general.id,
    createdTimestamp: at,
    client: guild.client,
  };
}

test('isExempt: admins, staff and listed roles are never touched; plain members are', () => {
  const s = normalizeSettings({});
  assert.equal(isExempt(fakeMember('a', { admin: true }), s), true);
  assert.equal(isExempt(fakeMember('b', { manage: true }), s), true);
  assert.equal(isExempt(fakeMember('c', { roles: ['Moderator'] }), s), true);
  assert.equal(isExempt(fakeMember('d', { roles: ['Member'] }), s), false);
  assert.equal(isExempt(null, s), true);
});

test('guardMessage: a flood removes the messages, times the member out, tells them and logs it', async () => {
  const { guild } = fakeGuild();
  const m = fakeMember('flooder', { roles: ['Member'] });
  let handled = false;
  const base = Date.now();
  for (let i = 0; i < 6; i++) handled = await guardMessage(fakeMessage(guild, m, `spam ${i}`, { id: `m${i}`, at: base + i * 300 }));
  assert.equal(handled, true);
  assert.deepEqual(guild.general.bulk[0], ['m0', 'm1', 'm2', 'm3', 'm4', 'm5']);
  assert.deepEqual(m.calls.find((c) => c[0] === 'timeout').slice(0, 2), ['timeout', 5 * 60_000]);
  assert.ok(guild.general.sent.some((p) => /slow down/.test(p.content)), 'the member is told');
  assert.match(guild.modlog.sent[0].embeds[0].data.title, /flood/);
});

test('guardMessage: a normal message, a bot and an exempt moderator are left alone', async () => {
  const { guild } = fakeGuild();
  assert.equal(await guardMessage(fakeMessage(guild, fakeMember('n1', { roles: ['Member'] }), 'hi everyone')), false);
  const mod = fakeMember('mod1', { roles: ['Moderator'] });
  for (let i = 0; i < 10; i++) assert.equal(await guardMessage(fakeMessage(guild, mod, 'x'.repeat(5), { at: Date.now() + i })), false);
  const bot = fakeMember('b1');
  bot.user.bot = true;
  assert.equal(await guardMessage(fakeMessage(guild, bot, 'hello')), false);
  assert.equal(guild.modlog.sent.length, 0);
});

test('guardMessage: ticket channels are exempt (staff and the member talk freely there)', async () => {
  const { guild, mk } = fakeGuild();
  const ticket = mk('100003', 'ticket-bob', { topic: 'ticket:7' });
  const m = fakeMember('t1', { roles: ['Member'] });
  for (let i = 0; i < 8; i++) {
    const msg = fakeMessage(guild, m, `line ${i}`, { id: `t${i}`, at: Date.now() + i });
    msg.channel = ticket;
    msg.channelId = ticket.id;
    assert.equal(await guardMessage(msg), false);
  }
});

test('guardMessage: caps and links are removed, but only when the Message Content intent is available', async () => {
  const { guild } = fakeGuild();
  runtime.settings = normalizeSettings({ automod: { caps: { enabled: true }, links: { mode: 'allowlist', allow: ['roblox.com'] } } });
  const m = fakeMember('c1', { roles: ['Member'] });
  assert.equal(await guardMessage(fakeMessage(guild, m, 'WHY IS NOBODY ANSWERING ME HERE', { id: 'caps1' })), true);
  assert.deepEqual(guild.general.deleted, ['caps1']);
  assert.equal(await guardMessage(fakeMessage(guild, m, 'check https://scam.example/free', { id: 'link1' })), true);
  assert.equal(await guardMessage(fakeMessage(guild, m, 'my game https://roblox.com/games/1', { id: 'ok1' })), false);

  runtime.features = { members: true, content: false };
  const m2 = fakeMember('c2', { roles: ['Member'] });
  assert.equal(await guardMessage(fakeMessage(guild, m2, 'WHY IS NOBODY ANSWERING ME HERE', { id: 'caps2' })), false, 'content is unreadable without the intent');
});

test('guardMessage: the third violation within ten minutes becomes a warning', async () => {
  const { guild } = fakeGuild();
  runtime.settings = normalizeSettings({ automod: { caps: { enabled: true } } });
  const m = fakeMember('strike1', { roles: ['Member'] });
  for (let i = 0; i < 3; i++) await guardMessage(fakeMessage(guild, m, 'THIS IS ALL CAPITAL LETTERS TEXT', { id: `s${i}` }));
  const warns = await getWarns('999', 'strike1');
  assert.equal(warns.length, 1);
  assert.match(warns[0].reason, /Repeated AutoMod violations/);
  assert.equal(warns[0].by.name, 'AutoMod');
});

test('guardMessage never throws, even when Discord calls fail', async () => {
  const { guild } = fakeGuild();
  guild.general.bulkDelete = async () => { throw new Error('Missing Permissions'); };
  guild.general.send = async () => { throw new Error('Missing Access'); };
  const m = fakeMember('boom', { roles: ['Member'], moderatable: false });
  let result;
  for (let i = 0; i < 6; i++) result = await guardMessage(fakeMessage(guild, m, `s${i}`, { id: `b${i}`, at: Date.now() + i * 100 }));
  assert.equal(result, true);
});

// ---- raid -------------------------------------------------------------------------------------

test('detectRaid counts joins inside the window only', () => {
  const r = { joins: 8, seconds: 20 };
  assert.deepEqual(detectRaid([0, 1000, 2000], 3000, r), { raid: false, count: 3 });
  assert.equal(detectRaid(Array.from({ length: 8 }, (_, i) => i * 1000), 8000, r).raid, true);
  assert.equal(detectRaid(Array.from({ length: 8 }, (_, i) => i * 5000), 40_000, r).raid, false, 'spread out over 40s is a normal evening');
});

test('accountTooNew: off by default, and reports the age and what is left when on', () => {
  const now = 100 * DAY;
  assert.equal(accountTooNew(now - 1000, now, { minAccountAgeDays: 7, accountAgeAction: 'none' }), null);
  assert.equal(accountTooNew(now - 1000, now, { minAccountAgeDays: 0, accountAgeAction: 'kick' }), null);
  assert.equal(accountTooNew(now - 10 * DAY, now, { minAccountAgeDays: 7, accountAgeAction: 'kick' }), null);
  const r = accountTooNew(now - 2 * DAY, now, { minAccountAgeDays: 7, accountAgeAction: 'timeout' });
  assert.equal(Math.round(r.ageDays), 2);
  assert.equal(Math.round(r.remainingMs / DAY), 5);
});

test('RaidGuard alerts once per cooldown, not for every extra joiner', () => {
  const g = new RaidGuard();
  const c = { joins: 3, seconds: 10 };
  assert.equal(g.record('a', 1000, c), null);
  assert.equal(g.record('b', 2000, c), null);
  const hit = g.record('c', 3000, c);
  assert.deepEqual(hit.userIds, ['a', 'b', 'c']);
  assert.equal(g.record('d', 4000, c), null, 'same raid, already alerted');
  const later = g.record('e', 4000 + 6 * 60_000, { joins: 1, seconds: 10 });
  assert.ok(later && later.userIds.includes('e'), 'after the cooldown a new raid alerts again');
});

test('checkAccountAge: timeout for the remaining time (max 28 days), kick with a DM, or nothing', async () => {
  const now = Date.now();
  const young = (over) => fakeMember('y', { createdTimestamp: now - 2 * DAY, ...over });
  const timeoutS = normalizeSettings({ raid: { minAccountAgeDays: 7, accountAgeAction: 'timeout' } });
  const m1 = young();
  assert.match(await checkAccountAge(m1, timeoutS, now), /timed out/);
  const ms = m1.calls.find((c) => c[0] === 'timeout')[1];
  assert.ok(Math.abs(ms - 5 * DAY) < 1000);

  const long = fakeMember('y2', { createdTimestamp: now - DAY });
  await checkAccountAge(long, normalizeSettings({ raid: { minAccountAgeDays: 365, accountAgeAction: 'timeout' } }), now);
  assert.equal(long.calls.find((c) => c[0] === 'timeout')[1], 28 * DAY, 'Discord caps timeouts at 28 days');

  const m2 = young();
  m2.guild = { name: 'Test' };
  assert.match(await checkAccountAge(m2, normalizeSettings({ raid: { minAccountAgeDays: 7, accountAgeAction: 'kick' } }), now), /kicked/);
  assert.ok(m2.calls.some((c) => c[0] === 'dm') && m2.calls.some((c) => c[0] === 'kick'));

  assert.equal(await checkAccountAge(young(), normalizeSettings({}), now), null, 'default is off');
  assert.equal(await checkAccountAge(fakeMember('old'), timeoutS, now), null);
  assert.match(await checkAccountAge(young({ moderatable: false }), timeoutS, now), /cannot time them out/);
});

test('handleJoin: a burst of joins triggers the configured lockdown exactly once', async () => {
  const { guild } = fakeGuild();
  for (const [id, name] of [['1', 'announcements'], ['2', 'media'], ['3', 'suggestions'], ['4', 'bot-commands'], ['5', 'bug-reports']]) {
    guild.channels.cache.set(`c${id}`, { id: `c${id}`, name: name === 'announcements' ? '📣｜announcements' : name, type: ChannelType.GuildText, permissionOverwrites: { edit: async () => {} }, send: async () => {} });
  }
  runtime.settings = normalizeSettings({ raid: { joins: 4, seconds: 20, action: 'lockdown', lockdownMinutes: 10 } });
  const members = Array.from({ length: 6 }, (_, i) => Object.assign(fakeMember(`j${i}`), { guild, client: guild.client }));
  const base = Date.now() + 10 * 60 * 60_000; // far away from other tests' joins so the shared guard starts clean
  const results = [];
  for (const [i, m] of members.entries()) results.push(await handleJoin(m, runtime.settings, base + i * 1000));
  assert.deepEqual(results.map((r) => r.raid), [false, false, false, true, false, false], 'alerts once, at the 4th join');
  assert.equal(guild.puts.length, 1, 'invites paused once');
  assert.ok(guild.modlog.sent.some((p) => /Possible raid/.test(p.embeds?.[0]?.data?.title ?? '')));
  assert.equal((await runtime.kv.get('saa:lockdown')).guildId, '999');
});

test('handleJoin: with the kick response, a member who joins during the raid cooldown is kicked too', async () => {
  const { guild } = fakeGuild();
  runtime.settings = normalizeSettings({ raid: { joins: 4, seconds: 20, action: 'kick' } });
  const members = Array.from({ length: 5 }, (_, i) => Object.assign(fakeMember(`k${i}`), { guild, client: guild.client }));
  const base = Date.now() + 30 * 60 * 60_000; // far from the other raid tests
  const results = [];
  for (const [i, m] of members.entries()) results.push(await handleJoin(m, runtime.settings, base + i * 1000));
  assert.deepEqual(results.map((r) => r.raid), [false, false, false, true, false], 'one alert for the raid');
  assert.ok(members[3].calls.some((c) => c[0] === 'kick'), 'the joiner that completed the pattern is kicked');
  assert.ok(members[4].calls.some((c) => c[0] === 'kick'), 'the joiner during the cooldown is kicked as well');
  assert.ok(guild.modlog.sent.some((p) => /Raid/.test(p.embeds?.[0]?.data?.title ?? '')));
});

test('handleJoin never throws, even for a broken member object', async () => {
  assert.deepEqual(await handleJoin({}, normalizeSettings({})), { raid: false, ageAction: null });
  assert.deepEqual(await handleJoin(null, normalizeSettings({})), { raid: false, ageAction: null });
});

test('handleJoin ignores bots and does nothing when raid protection is off', async () => {
  const { guild } = fakeGuild();
  const bot = Object.assign(fakeMember('bot9'), { guild, client: guild.client });
  bot.user.bot = true;
  assert.deepEqual(await handleJoin(bot, normalizeSettings({})), { raid: false, ageAction: null });
  const m = Object.assign(fakeMember('x9'), { guild, client: guild.client });
  assert.deepEqual(await handleJoin(m, normalizeSettings({ raid: { enabled: false } })), { raid: false, ageAction: null });
});

// ---- native AutoMod sync ----------------------------------------------------------------------

function restSpy(existing = []) {
  const calls = [];
  const rest = {
    get: async (path) => { calls.push(['GET', path]); return existing; },
    post: async (path, o) => { calls.push(['POST', path, o?.body]); return {}; },
    patch: async (path, o) => { calls.push(['PATCH', path, o?.body]); return {}; },
    delete: async (path) => { calls.push(['DELETE', path]); },
  };
  return { rest, calls };
}

test('desiredRules resolves the alert channel and exempt role names to ids', () => {
  const { guild } = fakeGuild();
  const rules = desiredRules(guild, normalizeSettings({}));
  const spam = rules.find((r) => r.name === `${RULE_PREFIX}Spam`);
  assert.equal(spam.actions.find((a) => a.type === 2).metadata.channel_id, guild.modlog.id);
  assert.deepEqual(spam.exempt_roles, ['role-Moderator'], 'only roles that exist are listed');
});

test('desiredRules exempts the staff channels (mod-log, staff-chat, ticket-logs, testers-chat) but not the public ones', () => {
  const { guild, mk } = fakeGuild();
  mk('100010', '🔒｜staff-chat');
  mk('100011', '📋｜ticket-logs');
  mk('100012', '🧪｜testers-chat');
  const rules = desiredRules(guild, normalizeSettings({}));
  for (const r of rules) {
    assert.deepEqual([...r.exempt_channels].sort(), ['100002', '100010', '100011', '100012'], r.name);
    assert.ok(!r.exempt_channels.includes(guild.general.id));
  }
});

test('syncNativeAutoMod pushes once, skips when nothing changed, and pushes again when settings change', async () => {
  const { guild } = fakeGuild();
  const { rest, calls } = restSpy([{ id: 'old', name: `${RULE_PREFIX}Retired` }, { id: 'x', name: 'Carl-bot rule' }]);
  guild.client.rest = rest;
  guild.id = 'sync-test-1';
  const first = await syncNativeAutoMod(guild, { settings: normalizeSettings({}) });
  assert.equal(first.created.length, 5);
  assert.deepEqual(first.removed, [`${RULE_PREFIX}Retired`]);
  assert.ok(!calls.some((c) => c[1]?.endsWith('/x')), 'other bots\' rules are never touched');
  const before = calls.length;
  assert.equal(await syncNativeAutoMod(guild, { settings: normalizeSettings({}) }), null, 'unchanged: no API calls');
  assert.equal(calls.length, before);
  const changed = await syncNativeAutoMod(guild, { settings: normalizeSettings({ automod: { mentions: { limit: 9 } } }) });
  assert.ok(changed);
  assert.equal(calls.some((c) => c[0] === 'POST' && c[2]?.trigger_metadata?.mention_total_limit === 9), true);
  const forced = await syncNativeAutoMod(guild, { settings: normalizeSettings({ automod: { mentions: { limit: 9 } } }), force: true });
  assert.ok(forced, 'force always pushes');
});

test('syncNativeAutoMod keeps retrying after an error (the hash is only remembered on success)', async () => {
  const { guild } = fakeGuild();
  guild.id = 'sync-test-2';
  const { rest } = restSpy();
  let fail = true;
  rest.post = async () => { if (fail) throw new Error('Maximum number of rules reached'); return {}; };
  guild.client.rest = rest;
  const s = normalizeSettings({});
  assert.ok((await syncNativeAutoMod(guild, { settings: s })).errors.length > 0);
  fail = false;
  const retry = await syncNativeAutoMod(guild, { settings: s });
  assert.ok(retry && retry.errors.length === 0, 'second attempt actually ran');
});

// ---- verification gate ------------------------------------------------------------------------

function gateGuild() {
  const { guild } = fakeGuild();
  guild.channels.cache.clear(); // only the channels this test defines
  const sets = new Map();
  const names = ['welcome', 'rules', 'announcements', 'updates', 'general', 'media', 'suggestions', 'bot-commands', 'bug-reports', 'dev-sneak-peeks', 'testers-chat', 'create-ticket', 'staff-chat', 'ticket-logs'];
  for (const n of names) {
    const c = { id: `g-${n}`, name: n, type: ChannelType.GuildText, isVoiceBased: () => false, permissionOverwrites: { set: async (ow) => sets.set(n, ow) }, send: async () => {} };
    guild.channels.cache.set(c.id, c);
  }
  guild.channels.fetch = async () => {};
  guild.roles.cache = new Collection(['Admin', 'Moderator', 'Developer', 'Tester', 'Member'].map((n, i) => [`role-${n}`, { id: `role-${n}`, name: n, position: i + 1 }]));
  const humans = [fakeMember('h1'), fakeMember('h2', { roles: ['Member'] })];
  const bot = fakeMember('botmember');
  bot.user.bot = true;
  for (const m of [...humans, bot]) m.roles.add = async (role) => m.calls.push(['addrole', role.name]);
  guild.members.fetch = async () => new Collection([...humans, bot].map((m) => [m.id, m]));
  return { guild, sets, humans, bot };
}

test('applyGate(on): existing members get the Member role first, non-public channels are hidden, public stay open', async () => {
  const { guild, sets, humans, bot } = gateGuild();
  const r = await applyGate(guild, true);
  assert.equal(r.granted, 1, 'only the human without the role');
  assert.deepEqual(humans[0].calls, [['addrole', 'Member']]);
  assert.deepEqual(humans[1].calls, [], 'already a member');
  assert.deepEqual(bot.calls, [], 'bots are skipped');
  const hidesEveryone = (n) => sets.get(n).find((o) => o.id === '999')?.deny?.includes(P.ViewChannel) ?? false;
  for (const n of ['general', 'media', 'bug-reports', 'dev-sneak-peeks']) assert.ok(hidesEveryone(n), `${n} should be hidden`);
  for (const n of ['welcome', 'rules', 'announcements', 'updates', 'create-ticket']) assert.ok(!hidesEveryone(n), `${n} should stay public`);
  assert.ok(sets.get('general').find((o) => o.id === 'role-Member').allow.includes(P.ViewChannel));
});

test('applyGate(off): everything goes back to the normal blueprint permissions and nobody is given roles', async () => {
  const { guild, sets, humans } = gateGuild();
  const r = await applyGate(guild, false);
  assert.equal(r.granted, 0);
  assert.deepEqual(humans[0].calls, []);
  assert.ok(!(sets.get('general').find((o) => o.id === '999')?.deny ?? []).includes(P.ViewChannel));
  assert.ok(sets.get('announcements').find((o) => o.id === '999').deny.includes(P.SendMessages), 'read-only stays read-only');
});

test('verifyMember: gives the Member role once, politely refuses the second time', async () => {
  const { guild } = gateGuild();
  const m = fakeMember('v1');
  m.roles.add = async (role) => { m.calls.push(['addrole', role.name]); m.roles.cache.set(role.id, role); };
  const replies = [];
  const i = { guild, member: m, reply: async (p) => replies.push(p) };
  await verifyMember(i);
  assert.deepEqual(m.calls, [['addrole', 'Member']]);
  assert.match(replies[0].content, /verified/);
  await verifyMember(i);
  assert.equal(m.calls.length, 1);
  assert.match(replies[1].content, /already/);
});

test('the welcome panel carries the Verify button and buttons are routed by id', async () => {
  const { guild } = fakeGuild();
  const panel = welcomePanel(guild);
  assert.equal(panel.components[0].components[0].data.custom_id, IDS.verify);
  assert.equal(handleButton({ customId: 'something:else' }), null);
});

// ---- panels -----------------------------------------------------------------------------------

test('syncPanel edits the bot\'s own message in place, posts when missing, never touches others\' messages', async () => {
  const { guild } = fakeGuild();
  const welcome = { id: 'w1', name: '👋｜welcome', type: ChannelType.GuildText, sent: [], send: async (p) => { welcome.sent.push(p); }, messages: { fetch: async () => msgs } };
  guild.channels.cache.set('w1', welcome);
  const edits = [];
  let msgs = new Collection([
    ['1', { author: { id: 'someone' }, embeds: [{ title: '👽 Welcome to the jungle' }], edit: async () => edits.push('WRONG') }],
    ['2', { author: { id: 'bot' }, embeds: [{ title: '👽 Welcome to Steal an Alien!' }], edit: async (p) => edits.push(p) }],
  ]);
  assert.equal(await syncPanel(guild, 'welcome'), 'updated');
  assert.equal(edits.length, 1);
  assert.ok(edits[0].components, 'the new Verify button was added to the existing message');
  msgs = new Collection();
  assert.equal(await syncPanel(guild, 'welcome'), 'posted');
  assert.equal(welcome.sent.length, 1);
  assert.match(await syncPanel(guild, 'nope'), /unknown panel/);
  assert.match(await syncPanel(guild, 'rules'), /no #rules channel/);
  assert.deepEqual(Object.keys(PANELS).sort(), ['rules', 'tickets', 'welcome']);
});

// ---- jobs -------------------------------------------------------------------------------------

test('processJobs runs queued dashboard jobs oldest first and reports each result', async () => {
  const { guild } = fakeGuild();
  for (const n of ['general', 'media']) guild.channels.cache.set(n, { id: n, name: n, type: ChannelType.GuildText, permissionOverwrites: { edit: async () => {} }, send: async () => {} });
  const client = { guilds: { cache: new Collection([[guild.id, guild]]) } };
  const now = Date.now();
  const by = { id: '42', name: 'Dana' };
  await runtime.kv.push('saa:jobs', { id: 'j1', type: 'lockdown', payload: { on: true, minutes: 5 }, by, guildId: guild.id, at: now });
  await runtime.kv.push('saa:jobs', { id: 'j2', type: 'reload-settings', payload: {}, by, guildId: guild.id, at: now });
  await runtime.kv.push('saa:jobs', { id: 'j3', type: 'format-disk', payload: {}, by, guildId: guild.id, at: now });
  await runtime.kv.push('saa:jobs', { id: 'j4', type: 'lockdown', payload: { on: true }, by, guildId: guild.id, at: now - 10 * 60_000 });
  await runtime.kv.push('saa:jobs', 'garbage');
  assert.equal(await processJobs(client, now), 5);
  assert.equal(await runtime.kv.pop('saa:jobs'), null, 'queue is empty');
  const results = (await runtime.kv.list('saa:job-results', 10)).reverse();
  assert.deepEqual(results.map((r) => [r.id, r.ok]), [['j1', true], ['j2', true], ['j3', false], ['j4', false], [null, false]]);
  assert.match(results[0].message, /locked/);
  assert.match(results[2].message, /unknown job type/);
  assert.match(results[3].message, /expired/);
  assert.equal((await runtime.kv.get('saa:lockdown')).guildId, guild.id, 'the lockdown really happened');
  assert.deepEqual(Object.keys(HANDLERS).sort(), ['apply-gate', 'lockdown', 'reload-settings', 'repost-panel', 'sync-automod']);
});

test('processJobs handles at most ten jobs per tick and survives a failing job', async () => {
  const { guild } = fakeGuild();
  guild.client.rest = restSpy().rest;
  const client = { guilds: { cache: new Collection([[guild.id, guild]]) } };
  const now = Date.now();
  for (let i = 0; i < 12; i++) await runtime.kv.push('saa:jobs', { id: `r${i}`, type: 'repost-panel', payload: { panel: 'nope' }, by: null, guildId: guild.id, at: now });
  assert.equal(await processJobs(client, now), 10);
  assert.equal((await runtime.kv.list('saa:jobs', 50)).length, 2);
  runtime.kv.pop = async () => { throw new Error('should not be reached'); };
});

// ---- fixes from the QA review -----------------------------------------------------------------

test('applyGate(on) refuses, and changes nothing, when the Member role is missing', async () => {
  const { guild, sets, humans } = gateGuild();
  guild.roles.cache.delete('role-Member');
  await assert.rejects(() => applyGate(guild, true), /lock everyone out/);
  assert.equal(sets.size, 0, 'no channel was touched');
  assert.deepEqual(humans[0].calls, []);
});

test('applyGate(on) refuses, and hides nothing, when a member cannot be given the role', async () => {
  const { guild, sets, humans } = gateGuild();
  humans[0].roles.add = async () => { throw new Error('Missing Permissions'); };
  await assert.rejects(() => applyGate(guild, true), /Could not give.*Nothing was hidden/);
  assert.equal(sets.size, 0, 'channels stay visible so nobody is locked out');
});

test('guardMessage still reports the message as handled when the follow-up fails (no XP for a deleted message)', async () => {
  const { guild } = fakeGuild();
  runtime.settings = normalizeSettings({ automod: { caps: { enabled: true } } });
  runtime.kv.set = async () => { throw new Error('store is down'); };
  runtime.kv.push = async () => { throw new Error('store is down'); };
  const m = fakeMember('kvdown', { roles: ['Member'] });
  const results = [];
  for (let i = 0; i < 3; i++) results.push(await guardMessage(fakeMessage(guild, m, 'THIS IS ALL CAPITAL LETTERS TEXT', { id: `k${i}` })));
  assert.deepEqual(results, [true, true, true], 'the third one tries to warn, the store throws, the message is still removed');
  assert.equal(guild.general.deleted.length, 3);
});

test('jobs: inherited property names are not job types, and failures are not reported as success', async () => {
  const { guild } = fakeGuild();
  const client = { guilds: { cache: new Collection([[guild.id, guild]]) } };
  const now = Date.now();
  for (const type of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    await runtime.kv.push('saa:jobs', { id: type, type, payload: {}, by: null, guildId: guild.id, at: now });
  }
  await runtime.kv.push('saa:jobs', { id: 'panel', type: 'repost-panel', payload: { panel: 'constructor' }, by: null, guildId: guild.id, at: now });
  await processJobs(client, now);
  const results = await runtime.kv.list('saa:job-results', 20);
  assert.equal(results.length, 5);
  assert.ok(results.every((r) => r.ok === false), JSON.stringify(results));
  assert.match(results.find((r) => r.id === 'panel').message, /unknown panel/);
  assert.equal(await syncPanel(guild, 'toString'), 'unknown panel "toString"');
});

test('sync-automod job fails loudly when Discord rejects a rule', async () => {
  const { guild } = fakeGuild();
  guild.client.rest = { ...restSpy().rest, post: async () => { throw new Error('Maximum number of rules reached'); } };
  guild.id = 'job-sync';
  const client = { guilds: { cache: new Collection([[guild.id, guild]]) } };
  const now = Date.now();
  await runtime.kv.push('saa:jobs', { id: 's1', type: 'sync-automod', payload: {}, by: null, guildId: guild.id, at: now });
  await processJobs(client, now);
  const [result] = await runtime.kv.list('saa:job-results', 1);
  assert.equal(result.ok, false);
  assert.match(result.message, /Maximum number of rules reached/);
});