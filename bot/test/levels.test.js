import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { Collection } from 'discord.js';
import { RANKS, ROLES } from '../src/blueprint.js';
import { levelFromXp, nextRank, progressBar, randomXp, rankForLevel, totalXpForLevel, xpToNext } from '../src/levels/math.js';
import { LevelStore } from '../src/levels/store.js';
import { LevelSystem, MESSAGE_COOLDOWN_MS } from '../src/levels/system.js';

const dirs = [];
const tempFile = () => {
  const dir = mkdtempSync(join(tmpdir(), 'saa-levels-'));
  dirs.push(dir);
  return join(dir, 'levels.json');
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

test('xp curve: known values', () => {
  assert.equal(xpToNext(0), 100);
  assert.equal(xpToNext(1), 155);
  assert.equal(xpToNext(2), 220);
  assert.equal(totalXpForLevel(0), 0);
  assert.equal(totalXpForLevel(3), 475);
});

test('levelFromXp: boundaries and progress', () => {
  assert.deepEqual(levelFromXp(0), { level: 0, current: 0, needed: 100 });
  assert.deepEqual(levelFromXp(99), { level: 0, current: 99, needed: 100 });
  assert.deepEqual(levelFromXp(100), { level: 1, current: 0, needed: 155 });
  assert.deepEqual(levelFromXp(254), { level: 1, current: 154, needed: 155 });
  assert.equal(levelFromXp(255).level, 2);
});

test('levelFromXp is the exact inverse of totalXpForLevel for levels 1..80', () => {
  for (let level = 1; level <= 80; level++) {
    assert.equal(levelFromXp(totalXpForLevel(level)).level, level, `at the threshold of ${level}`);
    assert.equal(levelFromXp(totalXpForLevel(level) - 1).level, level - 1, `one XP before ${level}`);
  }
});

test('levelFromXp survives garbage input', () => {
  for (const bad of [-5, NaN, undefined, null, '12']) assert.ok(levelFromXp(bad).level >= 0);
  assert.equal(levelFromXp(-5).level, 0);
});

test('rankForLevel / nextRank follow the tiers', () => {
  assert.equal(rankForLevel(0), null);
  assert.equal(rankForLevel(1).name, 'Lv.1 Recruit');
  assert.equal(rankForLevel(4).name, 'Lv.1 Recruit');
  assert.equal(rankForLevel(5).name, 'Lv.5 Scout');
  assert.equal(rankForLevel(49).name, 'Lv.30 Overlord');
  assert.equal(rankForLevel(50).name, 'Lv.50 Legend');
  assert.equal(rankForLevel(500).name, 'Lv.50 Legend');
  assert.equal(nextRank(0).name, 'Lv.1 Recruit');
  assert.equal(nextRank(5).name, 'Lv.10 Abductor');
  assert.equal(nextRank(50), null);
});

test('rank tiers are ascending, unique and do not reuse a staff colour', () => {
  for (let i = 1; i < RANKS.length; i++) assert.ok(RANKS[i].level > RANKS[i - 1].level);
  assert.equal(new Set(RANKS.map((r) => r.name)).size, RANKS.length);
  const staffColours = new Set(ROLES.map((r) => r.color));
  for (const r of RANKS) assert.ok(!staffColours.has(r.color), `${r.name} clashes with a staff colour`);
  assert.ok(!ROLES.some((r) => RANKS.some((k) => k.name === r.name)), 'rank name equals a role name');
});

test('progressBar and randomXp stay in bounds', () => {
  assert.equal(progressBar(0, 100), '▱'.repeat(10));
  assert.equal(progressBar(50, 100), '▰'.repeat(5) + '▱'.repeat(5));
  assert.equal(progressBar(100, 100), '▰'.repeat(10));
  assert.equal(progressBar(150, 100), '▰'.repeat(10));
  assert.equal(randomXp(() => 0), 15);
  assert.equal(randomXp(() => 0.9999999), 25);
});

test('store: add, floor at zero, ranking, position', () => {
  const store = new LevelStore(tempFile());
  store.add('g', 'a', 50);
  store.add('g', 'b', 200, { message: true });
  store.add('g', 'c', 120);
  store.add('g', 'c', -999);
  assert.equal(store.get('g', 'c').xp, 0, 'XP never goes negative');
  assert.deepEqual(store.ranking('g').map(([id]) => id), ['b', 'a'], 'members with 0 XP are not ranked');
  assert.equal(store.position('g', 'b'), 1);
  assert.equal(store.position('g', 'a'), 2);
  assert.equal(store.position('g', 'c'), null);
  assert.equal(store.get('g', 'b').messages, 1);
  assert.equal(store.get('other-guild', 'a').xp, 0, 'guilds are separate');
  store.set('g', 'a', 999);
  assert.equal(store.get('g', 'a').xp, 999);
  store.reset('g', 'a');
  assert.equal(store.get('g', 'a').xp, 0);
});

test('store: survives a restart (flush then reload)', () => {
  const file = tempFile();
  const first = new LevelStore(file);
  first.add('g', 'a', 321, { message: true });
  first.flush();
  const second = new LevelStore(file);
  assert.deepEqual(second.get('g', 'a'), { xp: 321, messages: 1 });
  assert.ok(!existsSync(`${file}.tmp`), 'no temp file left behind');
});

test('store: a corrupt file is moved aside, never overwritten', () => {
  const file = tempFile();
  writeFileSync(file, '{ this is not json', 'utf8');
  const store = new LevelStore(file);
  assert.deepEqual(store.ranking('g'), []);
  const files = readdirSync(join(file, '..'));
  assert.ok(files.some((f) => f.includes('.corrupt-')), `no .corrupt file in ${files}`);
});

// ---- LevelSystem with fakes ------------------------------------------------------------------

function fakeGuildAndMember() {
  const roles = new Collection(RANKS.map((r, i) => [`role${i}`, { id: `role${i}`, name: r.name }]));
  const memberRoles = new Collection();
  const calls = [];
  const member = {
    id: 'u1',
    user: { tag: 'tester#0001', bot: false },
    guild: { id: 'g1', roles: { cache: roles } },
    roles: {
      cache: memberRoles,
      add: async (r) => { calls.push(['add', r.name]); memberRoles.set(r.id, r); },
      remove: async (list) => { for (const r of [].concat(list)) { calls.push(['remove', r.name]); memberRoles.delete(r.id); } },
    },
  };
  const sent = [];
  const channel = { send: async (p) => sent.push(p) };
  return { member, calls, sent, channel, memberRoles };
}

test('grant: crossing level 1 gives Recruit and announces the new rank', async () => {
  const system = new LevelSystem(new LevelStore(tempFile()));
  const { member, calls, sent, channel } = fakeGuildAndMember();
  const result = await system.grant(member, 100, channel);
  assert.deepEqual(result, { before: 0, after: 1 });
  assert.deepEqual(calls, [['add', 'Lv.1 Recruit']]);
  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /level 1/);
  assert.match(sent[0].content, /Lv\.1 Recruit/);
});

test('grant: a level without a new tier announces the level but not a rank, roles untouched', async () => {
  const system = new LevelSystem(new LevelStore(tempFile()));
  const { member, calls, sent, channel } = fakeGuildAndMember();
  await system.grant(member, 100, channel); // level 1
  calls.length = 0;
  sent.length = 0;
  await system.grant(member, 155, channel); // level 2
  assert.deepEqual(calls, [], 'still Recruit, nothing to change');
  assert.match(sent[0].content, /level 2/);
  assert.doesNotMatch(sent[0].content, /is now a/);
});

test('grant: reaching level 5 swaps Recruit for Scout (exactly one rank role)', async () => {
  const store = new LevelStore(tempFile());
  const system = new LevelSystem(store);
  const { member, calls, memberRoles, channel } = fakeGuildAndMember();
  await system.grant(member, 100, channel);
  calls.length = 0;
  await system.grant(member, totalXpForLevel(5) - 100, channel);
  assert.deepEqual(calls, [['remove', 'Lv.1 Recruit'], ['add', 'Lv.5 Scout']]);
  assert.deepEqual([...memberRoles.values()].map((r) => r.name), ['Lv.5 Scout']);
});

test('grant: no level change means no role calls and no message', async () => {
  const system = new LevelSystem(new LevelStore(tempFile()));
  const { member, calls, sent, channel } = fakeGuildAndMember();
  await system.grant(member, 20, channel);
  assert.deepEqual(calls, []);
  assert.deepEqual(sent, []);
});

test('grant: losing XP below a tier removes the role silently', async () => {
  const store = new LevelStore(tempFile());
  const system = new LevelSystem(store);
  const { member, calls, sent, channel } = fakeGuildAndMember();
  await system.grant(member, 100, channel);
  calls.length = 0;
  sent.length = 0;
  await system.grant(member, -100, channel);
  assert.deepEqual(calls, [['remove', 'Lv.1 Recruit']]);
  assert.deepEqual(sent, [], 'no congratulations for going down');
});

test('onMessage: one XP award per cooldown, bots and DMs ignored', async () => {
  const store = new LevelStore(tempFile());
  const system = new LevelSystem(store);
  const { member, channel } = fakeGuildAndMember();
  const message = { author: { id: 'u1', bot: false }, guild: member.guild, member, channel };
  await system.onMessage(message);
  const afterFirst = store.get('g1', 'u1').xp;
  assert.ok(afterFirst >= 15 && afterFirst <= 25, `first message gave ${afterFirst}`);
  await system.onMessage(message);
  assert.equal(store.get('g1', 'u1').xp, afterFirst, 'second message inside the cooldown gives nothing');
  system.cooldowns.set('g1:u1', Date.now() - MESSAGE_COOLDOWN_MS - 1);
  await system.onMessage(message);
  assert.ok(store.get('g1', 'u1').xp > afterFirst, 'after the cooldown XP flows again');

  await system.onMessage({ ...message, author: { id: 'bot', bot: true } });
  await system.onMessage({ ...message, author: { id: 'u2', bot: false }, guild: null });
  assert.equal(store.get('g1', 'bot').xp, 0);
  assert.equal(store.get('g1', 'u2').xp, 0);
});
