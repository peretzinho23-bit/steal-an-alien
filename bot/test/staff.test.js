import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { ChannelType, Collection, Events, PermissionFlagsBits as P } from 'discord.js';
import { roleProblem } from '../src/commands/roles.js';
import { confirmAction } from '../src/commands/channels.js';
import { checkLockdownExpiry, everyoneSendWhenOpen, everyoneViewWhenShown, getLockdown, lockdownOff, lockdownOn, specFor } from '../src/lockdown.js';
import { formatters, registerLogs } from '../src/logs.js';
import { runtime } from '../src/runtime.js';
import { FileKv } from '../src/shared/kv.js';
import { normalizeSettings } from '../src/shared/settings.js';
import { ensureMissingChannels } from '../src/setup.js';
import { addTempBan, addWarn, applyEscalation, clearWarns, getWarns, processTempBans, removeWarn, stepForCount } from '../src/warns.js';

const dirs = [];
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'saa-staff-'));
  dirs.push(dir);
  runtime.kv = new FileKv(join(dir, 'kv.json'));
  runtime.settings = normalizeSettings({});
  runtime.tempRooms = new Set();
});
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

// ---- warns ------------------------------------------------------------------------------------

test('stepForCount fires only on the exact threshold', () => {
  const esc = runtime.settings.automod.warns.escalation;
  assert.equal(stepForCount(esc, 1), null);
  assert.equal(stepForCount(esc, 3).action, 'timeout');
  assert.equal(stepForCount(esc, 4), null, 'between thresholds nothing happens');
  assert.equal(stepForCount(esc, 5).action, 'kick');
  assert.equal(stepForCount(esc, 7).action, 'ban');
  assert.equal(stepForCount([], 3), null);
});

test('warns: add, count, remove by id, clear, and the index of warned users', async () => {
  const by = { id: 'm1', name: 'mod#1' };
  const a = await addWarn('g', 'u', { by, reason: 'spam' });
  const b = await addWarn('g', 'u', { by, reason: 'x'.repeat(900) });
  assert.equal(a.count, 1);
  assert.equal(b.count, 2);
  assert.equal(b.warn.reason.length, 400, 'reason is capped');
  assert.deepEqual((await runtime.kv.get('saa:warn-users')).g, { u: 2 });

  assert.equal(await removeWarn('g', 'u', 'nope'), null);
  assert.equal(await removeWarn('g', 'u', a.warn.id), 1);
  assert.equal((await getWarns('g', 'u')).length, 1);
  assert.equal(await clearWarns('g', 'u'), 1);
  assert.deepEqual(await getWarns('g', 'u'), []);
  assert.deepEqual((await runtime.kv.get('saa:warn-users')).g, {}, 'cleared users leave the index');
});

test('warns keep only the newest 100 per member', async () => {
  for (let i = 0; i < 105; i++) await addWarn('g', 'u', { by: null, reason: `r${i}` });
  const list = await getWarns('g', 'u');
  assert.equal(list.length, 100);
  assert.equal(list.at(-1).reason, 'r104');
});

const fakeMember = (over = {}) => {
  const calls = [];
  return {
    calls,
    moderatable: true,
    kickable: true,
    timeout: async (ms, reason) => calls.push(['timeout', ms, reason]),
    kick: async (reason) => calls.push(['kick', reason]),
    ...over,
  };
};
const guildWith = (member) => {
  const bans = [];
  return {
    bans,
    members: { fetch: async () => member, ban: async (id, o) => bans.push([id, o]), unban: async () => {} },
  };
};

test('applyEscalation: timeout at 3, kick at 5, ban at 7, nothing in between', async () => {
  const m = fakeMember();
  const g = guildWith(m);
  assert.match(await applyEscalation(g, { id: 'u' }, 3), /timed out for 60 minute/);
  assert.deepEqual(m.calls[0].slice(0, 2), ['timeout', 3_600_000]);
  assert.equal(await applyEscalation(g, { id: 'u' }, 4), null);
  assert.equal(await applyEscalation(g, { id: 'u' }, 5), 'kicked');
  assert.equal(await applyEscalation(g, { id: 'u' }, 7), 'banned');
  assert.equal(g.bans[0][0], 'u');
});

test('applyEscalation: reports (does not throw) when the bot cannot act or Discord errors', async () => {
  const weak = fakeMember({ moderatable: false, kickable: false });
  assert.match(await applyEscalation(guildWith(weak), { id: 'u' }, 3), /could not time out/);
  assert.match(await applyEscalation(guildWith(weak), { id: 'u' }, 5), /could not kick/);
  const boom = guildWith(fakeMember());
  boom.members.ban = async () => { throw new Error('Missing Permissions'); };
  assert.match(await applyEscalation(boom, { id: 'u' }, 7), /escalation failed: Missing Permissions/);
});

test('processTempBans lifts only the expired ones and retries real failures', async () => {
  const unbanned = [];
  let failFor = null;
  const client = {
    guilds: {
      cache: new Collection([
        ['g', {
          members: {
            unban: async (id) => {
              if (id === failFor) throw Object.assign(new Error('boom'), { code: 50013 });
              if (id === 'gone') throw Object.assign(new Error('Unknown Ban'), { code: 10026 });
              unbanned.push(id);
            },
          },
        }],
      ]),
    },
  };
  const now = 1_000_000;
  await addTempBan({ guildId: 'g', userId: 'due', until: now - 1, by: 'm', reason: 'r' });
  await addTempBan({ guildId: 'g', userId: 'later', until: now + 60_000, by: 'm', reason: 'r' });
  await addTempBan({ guildId: 'g', userId: 'gone', until: now - 5, by: 'm', reason: 'r' });
  failFor = 'stuck';
  await addTempBan({ guildId: 'g', userId: 'stuck', until: now - 5, by: 'm', reason: 'r' });

  const lifted = await processTempBans(client, now);
  assert.equal(lifted, 2, 'due + already-unbanned count as lifted');
  assert.deepEqual(unbanned, ['due']);
  const left = (await runtime.kv.get('saa:tempbans')).map((b) => b.userId).sort();
  assert.deepEqual(left, ['later', 'stuck'], 'future bans and failed ones stay queued');
});

test('a second tempban for the same member replaces the first', async () => {
  await addTempBan({ guildId: 'g', userId: 'u', until: 1, by: 'm', reason: 'a' });
  await addTempBan({ guildId: 'g', userId: 'u', until: 2, by: 'm', reason: 'b' });
  const list = await runtime.kv.get('saa:tempbans');
  assert.equal(list.length, 1);
  assert.equal(list[0].until, 2);
});

// ---- role rules -------------------------------------------------------------------------------

test('roleProblem: hierarchy, managed roles, @everyone and Administrator roles', () => {
  const guild = { id: 'G', ownerId: 'OWNER' };
  const role = (o = {}) => ({ id: 'r', position: 3, managed: false, editable: true, isAdminRole: false, ...o });
  const actor = (o = {}) => ({ id: 'u', highestPosition: 5, isAdmin: false, ...o });
  assert.equal(roleProblem({ actor: actor(), role: role(), guild }), null);
  assert.match(roleProblem({ actor: actor(), role: role({ id: 'G' }), guild }), /@everyone/);
  assert.match(roleProblem({ actor: actor(), role: role({ managed: true }), guild }), /managed/);
  assert.match(roleProblem({ actor: actor(), role: role({ editable: false }), guild }), /above my highest/);
  assert.match(roleProblem({ actor: actor({ highestPosition: 3 }), role: role(), guild }), /at or above your/);
  assert.match(roleProblem({ actor: actor(), role: role({ isAdminRole: true }), guild }), /administrator/i);
  assert.equal(roleProblem({ actor: actor({ isAdmin: true }), role: role({ isAdminRole: true }), guild }), null);
  assert.equal(roleProblem({ actor: actor({ id: 'OWNER', highestPosition: 0 }), role: role(), guild }), null, 'the owner is above every role');
});

// ---- lockdown ---------------------------------------------------------------------------------

function fakeChannel(name, type = ChannelType.GuildText, extra = {}) {
  const edits = [];
  const sent = [];
  return {
    id: String(100000 + Math.floor(Math.random() * 900000)),
    name,
    type,
    edits,
    sent,
    isVoiceBased: () => type === ChannelType.GuildVoice,
    permissionOverwrites: { edit: async (id, bits, opts) => edits.push({ id, bits, opts }) },
    send: async (p) => sent.push(p),
    ...extra,
  };
}

function fakeGuild(names = []) {
  const channels = new Collection();
  const puts = [];
  const guild = {
    id: '999',
    name: 'Test',
    channels: { cache: channels },
    client: { rest: { put: async (route, o) => puts.push({ route, body: o.body }) } },
    puts,
  };
  for (const [name, type] of names) {
    const c = fakeChannel(name, type);
    channels.set(c.id, c);
  }
  return guild;
}
const byName = (guild, name) => [...guild.channels.cache.values()].find((c) => c.name === name);

const SERVER = [
  ['👋｜welcome'], ['📣｜announcements'], ['general'], ['📷｜media'], ['💡｜suggestions'], ['🤖｜bot-commands'], ['🐛｜bug-reports'],
  ['🛠｜dev-sneak-peeks'], ['📜｜mod-log'], ['General', ChannelType.GuildVoice],
];

test('specFor / everyoneSendWhenOpen: read-only channels stay read-only, others inherit', () => {
  assert.equal(specFor(fakeChannel('📣｜announcements')).access, 'read');
  assert.equal(specFor(fakeChannel('general')).access, 'chat');
  assert.equal(specFor(fakeChannel('General', ChannelType.GuildVoice)).type, 'voice', 'voice General is not text general');
  assert.equal(specFor(fakeChannel('my-new-channel')), null);
  assert.equal(everyoneSendWhenOpen(fakeChannel('📣｜announcements')), false);
  assert.equal(everyoneSendWhenOpen(fakeChannel('general')), null);
  assert.equal(everyoneSendWhenOpen(fakeChannel('whatever')), null);
  assert.equal(everyoneViewWhenShown(fakeChannel('💬｜staff-chat')), false, 'staff channels stay hidden');
  assert.equal(everyoneViewWhenShown(fakeChannel('general')), null);
});

test('lockdownOn locks only the chat channels, pauses invites (<=24h) and remembers it', async () => {
  const guild = fakeGuild(SERVER);
  const r = await lockdownOn(guild, { minutes: 10, reason: 'test' });
  assert.equal(r.locked, 5, 'general, media, suggestions, bot-commands, bug-reports');
  for (const name of ['general', '📷｜media', '💡｜suggestions', '🤖｜bot-commands', '🐛｜bug-reports']) {
    const edit = byName(guild, name).edits[0];
    assert.equal(edit.id, '999');
    assert.equal(edit.bits.SendMessages, false, name);
  }
  for (const name of ['📣｜announcements', '👋｜welcome', '🛠｜dev-sneak-peeks']) assert.equal(byName(guild, name).edits.length, 0, `${name} must not be touched`);
  assert.equal(guild.puts[0].route, '/guilds/999/incident-actions');
  const until = Date.parse(guild.puts[0].body.invites_disabled_until);
  assert.ok(until > Date.now() && until <= Date.now() + 24 * 3600 * 1000);
  assert.equal((await getLockdown()).locked.length, 5);
  assert.match(byName(guild, 'general').sent[0], /lockdown/i, 'members are told');
  assert.equal(byName(guild, '📜｜mod-log').sent.length, 1, 'staff log entry');
});

test('lockdownOff reopens the channels, resumes invites and clears the state', async () => {
  const guild = fakeGuild(SERVER);
  await lockdownOn(guild, { minutes: 10 });
  guild.puts.length = 0;
  const r = await lockdownOff(guild, {});
  assert.equal(r.wasLocked, true);
  assert.equal(r.opened, 5);
  assert.equal(byName(guild, 'general').edits.at(-1).bits.SendMessages, null);
  assert.deepEqual(guild.puts[0].body, { invites_disabled_until: null });
  assert.equal(await getLockdown(), null);
});

test('lockdownOn survives a failing invite pause and a channel that cannot be edited', async () => {
  const guild = fakeGuild(SERVER);
  guild.client.rest.put = async () => { throw new Error('Missing Access'); };
  byName(guild, 'general').permissionOverwrites.edit = async () => { throw new Error('Missing Permissions'); };
  const r = await lockdownOn(guild, { minutes: 5 });
  assert.equal(r.locked, 4);
  assert.equal(r.invitesPaused, false);
  assert.match(byName(guild, '📜｜mod-log').sent[0].embeds[0].data.fields.map((f) => f.value).join(' '), /NOT paused/);
});

test('checkLockdownExpiry ends a lockdown only when its time is up', async () => {
  const guild = fakeGuild(SERVER);
  const client = { guilds: { cache: new Collection([[guild.id, guild]]) } };
  await lockdownOn(guild, { minutes: 10 });
  assert.equal(await checkLockdownExpiry(client, Date.now() + 5 * 60_000), false);
  assert.ok(await getLockdown());
  assert.equal(await checkLockdownExpiry(client, Date.now() + 11 * 60_000), true);
  assert.equal(await getLockdown(), null);
});

// ---- logs -------------------------------------------------------------------------------------

function logSetup(logsOverride = {}) {
  runtime.settings = normalizeSettings({ logs: logsOverride });
  const guild = fakeGuild([['📜｜mod-log']]);
  const logChan = byName(guild, '📜｜mod-log');
  const client = new EventEmitter();
  registerLogs(client);
  const user = { id: '5', tag: 'bob#1', username: 'bob', bot: false, createdAt: new Date(Date.now() - 86_400_000), toString: () => '<@5>' };
  return { guild, logChan, client, user };
}
const settle = () => new Promise((r) => setImmediate(r));

test('logs: a join produces one embed in #mod-log; switching the log off silences it', async () => {
  const on = logSetup();
  on.client.emit(Events.GuildMemberAdd, { guild: Object.assign(on.guild, { memberCount: 42 }), user: on.user });
  await settle();
  assert.equal(on.logChan.sent.length, 1);
  assert.match(on.logChan.sent[0].embeds[0].data.title, /joined/);

  const off = logSetup({ joins: false });
  off.client.emit(Events.GuildMemberAdd, { guild: off.guild, user: off.user });
  await settle();
  assert.equal(off.logChan.sent.length, 0);
});

test('logs: bot messages, unchanged edits and ticket channels are ignored', () => {
  const ticket = fakeChannel('ticket-bob', ChannelType.GuildText, { topic: 'ticket:5', toString: () => '#ticket' });
  const normal = fakeChannel('general', ChannelType.GuildText, { toString: () => '#general' });
  assert.equal(formatters.messageDelete({ author: { bot: true }, channel: normal }), null);
  assert.equal(formatters.messageDelete({ author: { bot: false, id: '1', tag: 'a#1', toString: () => '<@1>' }, channel: ticket, content: 'hi' }), null);
  assert.ok(formatters.messageDelete({ author: { bot: false, id: '1', tag: 'a#1', toString: () => '<@1>' }, channel: normal, content: 'hi' }));
  assert.equal(formatters.messageUpdate({ content: 'same' }, { content: 'same', channel: normal }), null);
  assert.equal(formatters.messageUpdate({ content: '' }, { content: 'new', channel: normal }), null, 'no old text (intent off): nothing to show');
  assert.equal(formatters.channelCreate(ticket), null);
  runtime.tempRooms.add('room1');
  assert.equal(formatters.channelCreate(fakeChannel('room', ChannelType.GuildVoice, { id: 'room1' })), null, 'temporary voice rooms are not logged');
});

test('logs: a deleted message without cached content still logs, and a failing send never throws', async () => {
  const { guild, logChan, client, user } = logSetup();
  const channel = fakeChannel('general', ChannelType.GuildText, { toString: () => '#general' });
  client.emit(Events.MessageDelete, { guild, author: null, channel, content: null, attachments: new Collection() });
  await settle();
  assert.match(logChan.sent[0].embeds[0].data.description, /not available/);
  logChan.send = async () => { throw new Error('Missing Access'); };
  client.emit(Events.GuildMemberAdd, { guild, user });
  await settle(); // reaching here without an unhandled rejection is the assertion
});

test('logs: timeouts are described from the member update event', () => {
  const user = { id: '5', tag: 'bob#1', toString: () => '<@5>' };
  const mk = (ts) => ({ user, communicationDisabledUntilTimestamp: ts });
  assert.equal(formatters.timeout(mk(null), mk(null)), null);
  assert.match(formatters.timeout(mk(null), mk(Date.now() + 60_000)).data.title, /timed out/);
  assert.match(formatters.timeout(mk(Date.now() + 60_000), mk(null)).data.title, /removed/);
});

// ---- confirmAction ----------------------------------------------------------------------------

function confirmInteraction(click) {
  const replies = [];
  const message = { awaitMessageComponent: async () => { if (click === 'timeout') throw new Error('time'); return { customId: click, user: { id: 'u' }, update: async (p) => replies.push(p) }; } };
  return { user: { id: 'u' }, replies, reply: async (p) => replies.push(p), fetchReply: async () => message, editReply: async (p) => replies.push(p) };
}

test('confirmAction: yes -> true, no -> false, silence -> false', async () => {
  assert.equal(await confirmAction(confirmInteraction('confirm:yes'), 'sure?'), true);
  assert.equal(await confirmAction(confirmInteraction('confirm:no'), 'sure?'), false);
  const silent = confirmInteraction('timeout');
  assert.equal(await confirmAction(silent, 'sure?'), false);
  assert.match(silent.replies.at(-1).content, /cancelled/i);
});

// ---- ensureMissingChannels --------------------------------------------------------------------

function blueprintGuild() {
  const channels = new Collection();
  const created = [];
  const roles = new Collection([
    ['r-admin', { id: 'r-admin', name: 'Admin' }],
    ['r-mod', { id: 'r-mod', name: 'Moderator' }],
    ['r-member', { id: 'r-member', name: 'Member' }],
  ]);
  const guild = {
    id: '999',
    channels: {
      cache: channels,
      fetch: async () => channels,
      create: async (o) => {
        const c = fakeChannel(o.name, o.type, { parentId: o.parent, topic: o.topic, overwrites: o.permissionOverwrites });
        channels.set(c.id, c);
        created.push(c);
        return c;
      },
    },
    roles: { cache: roles, fetch: async () => roles },
    members: { fetchMe: async () => ({ id: 'bot' }) },
  };
  return { guild, created, channels };
}

test('ensureMissingChannels creates only what is missing, in the right category, with staff-only access', async () => {
  const { guild, created, channels } = blueprintGuild();
  const first = await ensureMissingChannels(guild);
  assert.ok(first.length >= 15, `expected the whole blueprint, got ${first.length}`);
  const modLog = [...channels.values()].find((c) => c.name === '📜｜mod-log');
  const staffCategory = [...channels.values()].find((c) => c.type === ChannelType.GuildCategory && c.name === '🔒 STAFF');
  assert.ok(modLog && staffCategory);
  assert.equal(modLog.parentId, staffCategory.id);
  assert.ok(modLog.overwrites.find((o) => o.id === '999').deny.includes(P.ViewChannel), 'mod-log is hidden from everyone');
  assert.ok(modLog.overwrites.find((o) => o.id === 'r-mod').allow.includes(P.ViewChannel));

  const before = created.length;
  const second = await ensureMissingChannels(guild);
  assert.deepEqual(second, [], 'second run changes nothing');
  assert.equal(created.length, before);

  channels.delete(modLog.id);
  assert.deepEqual(await ensureMissingChannels(guild), ['📜｜mod-log'], 'a deleted channel is recreated, nothing else');
});

test('ensureMissingChannels with the gate on hides non-public channels from @everyone', async () => {
  const { guild, channels } = blueprintGuild();
  await ensureMissingChannels(guild, { gated: true });
  const get = (name) => [...channels.values()].find((c) => c.name === name);
  const denyView = (c) => c.overwrites.find((o) => o.id === '999')?.deny?.includes(P.ViewChannel) ?? false;
  assert.ok(denyView(get('general')), 'general hidden until verified');
  assert.ok(denyView(get('🐛｜bug-reports')));
  assert.ok(!denyView(get('👋｜welcome')), 'welcome stays visible');
  assert.ok(!denyView(get('📜｜rules')));
  assert.ok(!denyView(get('🎫｜create-ticket')), 'ticket button stays visible');
  assert.ok(get('general').overwrites.find((o) => o.id === 'r-member').allow.includes(P.ViewChannel), 'members see it');
});
