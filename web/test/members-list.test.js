import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { DiscordApiError } from '../lib/discord.js';
import { createWarnStore } from '../lib/shared/warnStore.js';
import { ADMIN_ID, DEV_ID, GUILD, MOD_ID, NOW, OWNER, ROLE_IDS, VICTIM_ID, call, fakeDiscord, makeServices, resetLimits, sessionCookie } from './helpers.js';

beforeEach(() => resetLimits());

const staff = (s) => sessionCookie(s, { uid: MOD_ID, level: 'staff', name: 'Mo' });
const BOT_ID = '700000000000000005';
const TIMED_ID = '700000000000000006';
const big = (id) => BigInt(id);

/** A member as Discord's list endpoint returns it. */
const member = (id, username, roles = [], extra = {}) => ({ user: { id, username }, roles, nick: null, joined_at: '2026-01-01T00:00:00.000Z', ...extra });

/** Everyone in the default fake server, plus a bot, a timed-out member, and 120 plain members. */
function population() {
  const base = fakeDiscord();
  const all = Object.values(base.data.members);
  all.push(member(BOT_ID, 'helperbot', [], { user: { id: BOT_ID, username: 'helperbot', bot: true } }));
  all.push(member(TIMED_ID, 'quiet', [ROLE_IDS.plain], { communication_disabled_until: new Date(NOW + 3_600_000).toISOString() }));
  for (let i = 0; i < 120; i++) all.push(member(String(710000000000000000n + BigInt(i)), `plain${i}`));
  return all;
}

/** Makes the fake Discord serve the member list like the real endpoint: id order, `after` exclusive, `limit` honoured. */
function serve(s, all) {
  const sorted = [...all].sort((a, b) => (big(a.user.id) < big(b.user.id) ? -1 : big(a.user.id) > big(b.user.id) ? 1 : 0));
  s.discord.listMembers = async (after, limit = 1000) => {
    s.discord.calls.push(['listMembers', after, limit]);
    return sorted.filter((m) => !after || big(m.user.id) > big(after)).slice(0, limit);
  };
  return sorted;
}

const list = (s, query = '', cookie = staff(s)) => call(s, { url: `/api/members/list${query ? `?${query}` : ''}`, cookie });
const ids = (json) => json.members.map((m) => m.id);

// ---- shape and filters ------------------------------------------------------------------------------

test('filter=all returns members in id order with the shared member shape and a warning count', async () => {
  const s = makeServices();
  const all = serve(s, population());
  const { status, json } = await list(s, 'limit=100');
  assert.equal(status, 200);
  assert.deepEqual(ids(json), all.slice(0, 100).map((m) => m.user.id));
  const first = json.members[0];
  assert.deepEqual(Object.keys(first).sort(), ['avatar', 'bot', 'id', 'joinedAt', 'level', 'name', 'roles', 'timeoutUntil', 'username', 'warnCount'].sort());
  assert.equal(first.warnCount, 0);
  assert.equal(json.total, all.length, 'every member Discord returned is counted as scanned');
  assert.equal(s.discord.calls.at(-1)[0], 'listMembers');
  assert.equal(s.discord.calls.at(-1)[2], 1000, 'Discord is asked for up to 1000 members');
});

test('filter=staff gives everyone with a staff or admin level, and nobody else', async () => {
  const s = makeServices();
  serve(s, population());
  const { json } = await list(s, 'filter=staff&limit=100');
  const byId = Object.fromEntries(json.members.map((m) => [m.id, m]));
  assert.ok(byId[MOD_ID] && byId[ADMIN_ID] && byId[OWNER]);
  assert.ok(json.members.every((m) => m.level === 'staff' || m.level === 'admin'));
  assert.ok(!byId[DEV_ID], 'a developer without staff rights is not staff');
});

test('filter=admins gives only admins (the owner counts as an admin)', async () => {
  const s = makeServices();
  serve(s, population());
  const { json } = await list(s, 'filter=admins');
  assert.deepEqual(ids(json).sort(), [ADMIN_ID, OWNER].sort());
  assert.ok(json.members.every((m) => m.level === 'admin'));
});

test('filter=bots gives only bot accounts', async () => {
  const s = makeServices();
  serve(s, population());
  const { json } = await list(s, 'filter=bots');
  assert.deepEqual(ids(json), [BOT_ID]);
  assert.equal(json.next, null, 'the list ended inside the scan');
});

test('filter=timeout gives only people whose timeout is still running', async () => {
  const s = makeServices();
  serve(s, population());
  const { json } = await list(s, 'filter=timeout');
  assert.deepEqual(ids(json), [TIMED_ID]);
  assert.ok(json.members[0].timeoutUntil);
  s.clock += 2 * 3_600_000;
  const later = await list(s, 'filter=timeout');
  assert.deepEqual(later.json.members, [], 'an expired timeout no longer counts');
});

test('filter=warned gives people with warnings, each with its count', async () => {
  const s = makeServices();
  serve(s, population());
  const store = createWarnStore(s.kv);
  await store.add(GUILD, VICTIM_ID, { by: { id: '1', name: 'x' }, reason: 'spam' });
  await store.add(GUILD, VICTIM_ID, { by: { id: '1', name: 'x' }, reason: 'more spam' });
  const { json } = await list(s, 'filter=warned');
  assert.deepEqual(json.members.map((m) => [m.id, m.warnCount]), [[VICTIM_ID, 2]]);
});

test('role filter keeps only people with that role, and combines with another filter', async () => {
  const s = makeServices();
  serve(s, population());
  assert.deepEqual(ids((await list(s, `role=${ROLE_IDS.dev}`)).json), [DEV_ID]);
  assert.deepEqual(ids((await list(s, `role=${ROLE_IDS.plain}`)).json), [TIMED_ID]);
  assert.deepEqual(ids((await list(s, `role=${ROLE_IDS.plain}&filter=timeout`)).json), [TIMED_ID]);
  assert.deepEqual(ids((await list(s, `role=${ROLE_IDS.plain}&filter=bots`)).json), []);
});

// ---- paging -----------------------------------------------------------------------------------------

test('paging with after/next walks the whole list once, with no repeats and no gaps', async () => {
  const s = makeServices();
  const all = serve(s, population());
  const seen = [];
  let cursor = null;
  let pages = 0;
  do {
    const { json } = await list(s, `limit=20${cursor ? `&after=${cursor}` : ''}`);
    assert.ok(json.members.length <= 20);
    seen.push(...ids(json));
    cursor = json.next;
    pages++;
  } while (cursor && pages < 50);
  assert.equal(pages, Math.ceil(all.length / 20));
  assert.deepEqual(seen, all.map((m) => m.user.id));
});

test('next is the last id on the page when more matches exist, and null on the last page', async () => {
  const s = makeServices();
  serve(s, population());
  const first = (await list(s, 'filter=staff&limit=2')).json;
  assert.equal(first.members.length, 2);
  assert.equal(first.next, first.members[1].id);
  const second = (await list(s, `filter=staff&limit=2&after=${first.next}`)).json;
  assert.ok(!second.members.some((m) => first.members.some((f) => f.id === m.id)));
  const last = (await list(s, 'filter=staff&limit=100')).json;
  assert.equal(last.next, null);
});

test('a page with no matches still continues, so a rare filter finds people past the first 1000', async () => {
  const s = makeServices();
  const crowd = Array.from({ length: 1000 }, (_, i) => member(String(720000000000000000n + BigInt(i)), `crowd${i}`));
  const dev = member('730000000000000001', 'latecomer', [ROLE_IDS.dev]);
  serve(s, [...crowd, dev]);
  const first = (await list(s, `role=${ROLE_IDS.dev}`)).json;
  assert.deepEqual(first.members, []);
  assert.equal(first.next, crowd[999].user.id, 'the scan went through a full page, so the cursor moves on');
  const second = (await list(s, `role=${ROLE_IDS.dev}&after=${first.next}`)).json;
  assert.deepEqual(ids(second), ['730000000000000001']);
  assert.equal(second.next, null);
});

test('limit defaults to 50, is clamped to 1..100 and ignores nonsense', async () => {
  const s = makeServices();
  serve(s, population());
  assert.equal((await list(s, '')).json.members.length, 50);
  assert.equal((await list(s, 'limit=500')).json.members.length, 100);
  assert.equal((await list(s, 'limit=0')).json.members.length, 1);
  assert.equal((await list(s, 'limit=-7')).json.members.length, 1);
  assert.equal((await list(s, 'limit=abc')).json.members.length, 50);
});

test('bad query values are refused before anything is asked of Discord', async () => {
  const s = makeServices();
  serve(s, population());
  assert.equal((await list(s, 'filter=everyone')).status, 422);
  assert.equal((await list(s, 'after=nope')).status, 422);
  assert.equal((await list(s, 'role=nope')).status, 422);
  assert.equal(s.discord.calls.filter((c) => c[0] === 'listMembers').length, 0);
});

test('the cursor is passed on to Discord as after', async () => {
  const s = makeServices();
  serve(s, population());
  await list(s, `after=${VICTIM_ID}`);
  assert.deepEqual(s.discord.calls.at(-1), ['listMembers', VICTIM_ID, 1000]);
});

// ---- access and storage -----------------------------------------------------------------------------

test('the list is for staff only: no session gets 401', async () => {
  const s = makeServices();
  serve(s, population());
  assert.equal((await call(s, { url: '/api/members/list' })).status, 401);
  assert.equal(s.discord.calls.filter((c) => c[0] === 'listMembers').length, 0);
});

test('works without storage: no warning counts, and the warned filter is empty', async () => {
  const s = makeServices({ kv: null });
  serve(s, population());
  const everyone = await list(s, 'limit=5');
  assert.equal(everyone.status, 200);
  assert.equal(everyone.json.members.length, 5);
  assert.ok(!('warnCount' in everyone.json.members[0]));
  assert.deepEqual((await list(s, 'filter=warned')).json, { members: [], next: null, total: 0 });
  assert.equal((await list(s, 'filter=staff')).status, 200);
});

test('a Discord error (for example a missing intent) becomes a readable error, not a crash', async () => {
  const s = makeServices();
  s.discord.listMembers = async () => {
    throw new DiscordApiError(403, 50001, 'Missing Access', '/guilds/x/members');
  };
  const res = await list(s, '');
  assert.equal(res.status, 502);
  assert.match(res.json.error, /Discord refused/);
});
