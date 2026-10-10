import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { Collection } from 'discord.js';
import { buildLeaderboard, publishLeaderboard } from '../src/leaderboard.js';
import { LevelStore } from '../src/levels/store.js';
import { levelFromXp, rankForLevel } from '../src/levels/math.js';
import { runtime } from '../src/runtime.js';
import { FileKv, KEYS } from '../src/shared/kv.js';

const dirs = [];
let store;
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'saa-lb-'));
  dirs.push(dir);
  store = new LevelStore(join(dir, 'levels.json'));
  runtime.kv = new FileKv(join(dir, 'kv.json'));
});
afterEach(() => {
  store.flush(); // cancels the pending debounced save so nothing is written into a deleted folder
  runtime.kv?.flush?.();
  runtime.kv = null;
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

const KEYS_EXPECTED = ['id', 'name', 'avatar', 'xp', 'level', 'current', 'needed', 'rank'];

/** A fake guild: members cache and the client's user cache, like discord.js has them. */
function fakeGuild(id, { members = [], users = [] } = {}) {
  const memberCache = new Collection(members.map((m) => [m.id, m]));
  const userCache = new Collection(users.map((u) => [u.id, u]));
  return { id, name: `guild ${id}`, members: { cache: memberCache }, client: { users: { cache: userCache } } };
}
const member = (id, displayName, username = `${id}_user`) => ({
  id,
  displayName,
  user: { id, username, displayAvatarURL: ({ size }) => `https://cdn.example/${id}.png?size=${size}` },
});

test('buildLeaderboard: best first, exact shape, progress and rank from the level math', () => {
  store.add('g1', 'a', 150); // level 1, 50 of 155 into it
  store.add('g1', 'b', 10_000);
  store.add('g1', 'c', 40);
  store.add('g1', 'zero', 0); // no XP: not ranked
  const guild = fakeGuild('g1', { members: [member('a', 'Ann'), member('b', 'Bo')] });
  const board = buildLeaderboard(store, guild, 50, 1234);
  assert.equal(board.at, 1234);
  assert.deepEqual(board.entries.map((e) => e.id), ['b', 'a', 'c']);
  for (const e of board.entries) assert.deepEqual(Object.keys(e).sort(), [...KEYS_EXPECTED].sort());
  const ann = board.entries[1];
  assert.deepEqual({ xp: ann.xp, level: ann.level, current: ann.current, needed: ann.needed }, { xp: 150, level: 1, current: 50, needed: 155 });
  assert.equal(ann.rank, rankForLevel(1).name);
  assert.equal(board.entries[2].rank, null, 'below the first rank tier');
  assert.equal(board.entries[2].level, levelFromXp(40).level);
});

test('buildLeaderboard: name is the member display name, else the cached username, else null; avatar is a CDN url or null', () => {
  store.add('g2', 'm1', 500);
  store.add('g2', 'u1', 400);
  store.add('g2', 'ghost', 300);
  const guild = fakeGuild('g2', {
    members: [member('m1', 'Display One', 'login_one')],
    users: [{ id: 'u1', username: 'cached_two', displayAvatarURL: () => 'https://cdn.example/u1.png' }],
  });
  const [m1, u1, ghost] = buildLeaderboard(store, guild).entries;
  assert.equal(m1.name, 'Display One');
  assert.equal(m1.avatar, 'https://cdn.example/m1.png?size=128');
  assert.equal(u1.name, 'cached_two', 'not a member, but the client knows the user');
  assert.equal(u1.avatar, 'https://cdn.example/u1.png');
  assert.equal(ghost.name, null);
  assert.equal(ghost.avatar, null);
});

test('buildLeaderboard: top 50 at most, limit is clamped, and the result is plain JSON', () => {
  for (let i = 0; i < 60; i++) store.add('g3', `user${i}`, 1000 + i);
  const guild = fakeGuild('g3');
  assert.equal(buildLeaderboard(store, guild).entries.length, 50);
  assert.equal(buildLeaderboard(store, guild, 500).entries.length, 50, 'the website expects at most 50');
  assert.equal(buildLeaderboard(store, guild, 3).entries.length, 3);
  assert.equal(buildLeaderboard(store, guild, 0).entries.length, 50, 'nonsense limit falls back to 50');
  assert.equal(buildLeaderboard(store, guild).entries[0].id, 'user59');
  const board = buildLeaderboard(store, guild);
  assert.deepEqual(JSON.parse(JSON.stringify(board)), board, 'survives a JSON round trip unchanged');
});

test('buildLeaderboard: an empty server gives an empty entries list', () => {
  const board = buildLeaderboard(store, fakeGuild('empty'), 50, 5);
  assert.deepEqual(board, { at: 5, entries: [] });
});

test('publishLeaderboard: writes the guild snapshot under the website key and a per-guild key', async () => {
  store.add('big', 'a', 900);
  store.add('big', 'b', 100);
  store.add('small', 'x', 50);
  const big = fakeGuild('big', { members: [member('a', 'Ann')] });
  const small = fakeGuild('small');
  const client = { guilds: { cache: new Collection([['big', big], ['small', small]]) } };
  const result = await publishLeaderboard(client, { store });
  assert.equal(result.published, 2);
  const website = await runtime.kv.get(KEYS.leaderboard);
  assert.deepEqual(website.entries.map((e) => e.id), ['a', 'b'], 'the server with the most ranked members is the one the site shows');
  assert.equal(website.entries[0].name, 'Ann');
  assert.deepEqual((await runtime.kv.get(`${KEYS.leaderboard}:small`)).entries.map((e) => e.id), ['x']);
});

test('publishLeaderboard: a guild with no XP is skipped (nothing written for it)', async () => {
  const client = { guilds: { cache: new Collection([['empty', fakeGuild('empty')]]) } };
  assert.deepEqual(await publishLeaderboard(client, store), { published: 0 });
  assert.equal(await runtime.kv.get(KEYS.leaderboard), null);
  assert.equal(await runtime.kv.get(`${KEYS.leaderboard}:empty`), null);
});

test('publishLeaderboard never throws: a failing store write or a missing client is just reported', async () => {
  store.add('g9', 'a', 10);
  const client = { guilds: { cache: new Collection([['g9', fakeGuild('g9')]]) } };
  runtime.kv.set = async () => { throw new Error('store is down'); };
  assert.deepEqual(await publishLeaderboard(client, store), { published: 0 });
  assert.deepEqual(await publishLeaderboard(undefined, undefined), { published: 0 });
  runtime.kv = null;
  assert.deepEqual(await publishLeaderboard(client, store), { published: 0 }, 'no store configured');
});
