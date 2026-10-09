import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DiscordApiError, createDiscord } from '../lib/discord.js';
import { HttpError, hostOf, isLocalHost, originOf, parseCookies, serializeCookie } from '../lib/http.js';
import { describeError, matchRoute } from '../lib/router.js';
import { limit, resetLimits } from '../lib/ratelimit.js';
import { sign, verify } from '../lib/session.js';
import { buildMessage, cleanEmbed, cleanEmoji, color, httpsUrl, isSnowflake, parseMessageLink } from '../lib/validate.js';
import { channelKey, plainName } from '../lib/util.js';

const SECRET = 'a-long-enough-secret-for-the-tests-1234';

// ---- sessions ---------------------------------------------------------------------------------------

test('session: a signed token verifies; edits, forgeries, expiry and other secrets are all rejected', () => {
  const token = sign({ uid: '1', level: 'staff', exp: 5000 }, SECRET);
  assert.deepEqual(verify(token, SECRET, 1000), { uid: '1', level: 'staff', exp: 5000 });
  assert.equal(verify(token, SECRET, 5000), null, 'expired exactly now');
  assert.equal(verify(token, 'another-secret-another-secret-12345', 1000), null);

  const [body, sig] = token.split('.');
  const tampered = Buffer.from(JSON.stringify({ uid: '1', level: 'admin', exp: 5000 })).toString('base64url');
  assert.equal(verify(`${tampered}.${sig}`, SECRET, 1000), null, 'promoting yourself to admin must fail');
  assert.equal(verify(`${body}.${sig.slice(0, -2)}AA`, SECRET, 1000), null, 'corrupted signature');
  for (const junk of ['', 'abc', '.', 'a.b.c', null, undefined, 42, 'x'.repeat(5000)]) assert.equal(verify(junk, SECRET, 1000), null, String(junk).slice(0, 20));
});

test('session: a token without a numeric expiry is never valid, and short secrets are refused', () => {
  assert.equal(verify(sign({ uid: '1' }, SECRET), SECRET, 0), null);
  assert.throws(() => sign({ exp: 1 }, 'short'), /SESSION_SECRET/);
  assert.throws(() => verify('a.b', '', 0), /SESSION_SECRET/);
});

// ---- http helpers -----------------------------------------------------------------------------------

test('parseCookies handles several cookies, encoded values and malformed ones', () => {
  assert.deepEqual(parseCookies('a=1; b=hello%20world; c'), { a: '1', b: 'hello world' });
  assert.deepEqual(parseCookies('bad=%E0%A4%A; ok=1'), { ok: '1' });
  assert.deepEqual(parseCookies(undefined), {});
});

test('serializeCookie sets HttpOnly and SameSite always, Secure only on https, and encodes the value', () => {
  const c = serializeCookie('s', 'a b;c', { maxAge: 60, secure: true });
  assert.match(c, /^s=a%20b%3Bc; Path=\/; HttpOnly; SameSite=Lax; Secure; Max-Age=60$/);
  assert.doesNotMatch(serializeCookie('s', 'v', { secure: false }), /Secure/);
});

test('originOf, hostOf and isLocalHost read proxies correctly and BASE_URL wins', () => {
  const req = { headers: { host: 'internal:3000', 'x-forwarded-host': 'dash.example.com', 'x-forwarded-proto': 'https' }, socket: {} };
  assert.equal(hostOf(req), 'dash.example.com');
  assert.equal(originOf(req, {}), 'https://dash.example.com');
  assert.equal(originOf(req, { BASE_URL: 'https://mine.example.com/' }), 'https://mine.example.com');
  assert.equal(originOf({ headers: { host: 'localhost:8080' }, socket: {} }, {}), 'http://localhost:8080');
  assert.ok(isLocalHost({ headers: { host: 'localhost:8080' } }) && isLocalHost({ headers: { host: '127.0.0.1:3000' } }));
  assert.ok(!isLocalHost({ headers: { host: 'localhost.evil.com' } }) && !isLocalHost({ headers: { host: 'evil.com' } }));
});

// ---- validation -------------------------------------------------------------------------------------

test('isSnowflake accepts Discord ids only', () => {
  assert.ok(isSnowflake('123456789012345678'));
  for (const bad of ['', '123', 'abc', '12345678901234567x', 123456789012345678, null, '../etc', '1'.repeat(30)]) assert.ok(!isSnowflake(bad), String(bad));
});

test('httpsUrl and color validate strictly', () => {
  assert.equal(httpsUrl('https://example.com/a.png', 'x'), 'https://example.com/a.png');
  for (const bad of ['http://example.com', 'javascript:alert(1)', 'data:text/html,hi', 'ftp://x', 'not a url', 'https://' + 'a'.repeat(3000)]) assert.throws(() => httpsUrl(bad, 'x'), HttpError, bad.slice(0, 30));
  assert.equal(color('#5B3DF5'), 0x5b3df5);
  assert.equal(color(255), 255);
  assert.equal(color(''), undefined);
  for (const bad of ['#GGGGGG', -1, 0x1000000, 'red', 1.5]) assert.throws(() => color(bad), HttpError, String(bad));
});

test('cleanEmbed enforces Discord limits and drops fields we do not allow', () => {
  const ok = cleanEmbed({ title: 'T', description: 'D', color: '#ff0000', footer: 'F', image: 'https://x.io/i.png', fields: [{ name: 'a', value: 'b', inline: true }], evil: '<script>', author: { name: 'x' } });
  assert.deepEqual(Object.keys(ok).sort(), ['color', 'description', 'fields', 'footer', 'image', 'title']);
  assert.throws(() => cleanEmbed({ title: 'x'.repeat(257) }), /between 0 and 256/);
  assert.throws(() => cleanEmbed({ description: 'x'.repeat(4097) }), HttpError);
  assert.throws(() => cleanEmbed({ title: 'a', fields: Array.from({ length: 26 }, () => ({ name: 'a', value: 'b' })) }), /at most 25/);
  assert.throws(() => cleanEmbed({ title: 'a', fields: [{ name: '', value: 'b' }] }), /required/);
  assert.throws(() => cleanEmbed({}), /empty/);
  assert.throws(() => cleanEmbed({ title: 'a', image: 'http://x.io/i.png' }), /https/);
  assert.throws(() => cleanEmbed('string'), HttpError);
  assert.throws(() => cleanEmbed(null), HttpError);
});

const ADMIN = 'admin';
const STAFF = 'staff';
const pingable = new Set(['500000000000000004']);

test('buildMessage: plain text, embeds-only and the "nothing to send" error', () => {
  assert.equal(buildMessage({ content: ' hi ' }, { level: STAFF }).content, 'hi');
  const e = buildMessage({ embeds: [{ title: 'News' }] }, { level: STAFF });
  assert.equal(e.content, undefined);
  assert.equal(e.embeds.length, 1);
  assert.throws(() => buildMessage({}, { level: STAFF }), /Write some text/);
  assert.throws(() => buildMessage({ embeds: 'nope' }, { level: STAFF }), /must be a list/);
  assert.throws(() => buildMessage({ content: 'x'.repeat(2001) }, { level: STAFF }), HttpError);
  assert.throws(() => buildMessage({ embeds: Array.from({ length: 11 }, () => ({ title: 'a' })) }, { level: STAFF }), /At most 10/);
  assert.throws(() => buildMessage({ embeds: Array.from({ length: 3 }, () => ({ description: 'x'.repeat(3000) })) }, { level: STAFF }), /6000/);
});

test('buildMessage: nothing pings unless it is selected AND allowed', () => {
  const plain = buildMessage({ content: 'hello @everyone and <@&500000000000000001>' }, { level: STAFF });
  assert.deepEqual(plain.allowed_mentions, { parse: [], roles: [], users: [] }, 'typed mentions are inert');

  const withRole = buildMessage({ content: 'news', pingRoleIds: ['500000000000000004'] }, { level: STAFF, pingableRoleIds: pingable });
  assert.equal(withRole.content, '<@&500000000000000004>\nnews');
  assert.deepEqual(withRole.allowed_mentions, { parse: [], roles: ['500000000000000004'], users: [] });

  assert.throws(() => buildMessage({ content: 'x', pingRoleIds: ['500000000000000001'] }, { level: ADMIN, pingableRoleIds: pingable }), /cannot be pinged/, 'even admins only ping allowed roles');
  assert.throws(() => buildMessage({ content: 'x', pingRoleIds: ['nope'] }, { level: ADMIN, pingableRoleIds: pingable }), /valid Discord id/);
  assert.throws(() => buildMessage({ content: 'x', pingEveryone: true }, { level: STAFF }), /Only admins/);
  const every = buildMessage({ content: 'x', pingEveryone: true }, { level: ADMIN });
  assert.equal(every.content, '@everyone\nx');
  assert.deepEqual(every.allowed_mentions.parse, ['everyone']);
});

test('buildMessage: reply reference and the 2000 character limit including pings', () => {
  const p = buildMessage({ content: 'a', replyTo: '123456789012345678' }, { level: STAFF });
  assert.deepEqual(p.message_reference, { message_id: '123456789012345678', fail_if_not_exists: false });
  assert.throws(() => buildMessage({ content: 'a', replyTo: 'x' }, { level: STAFF }), HttpError);
  assert.throws(() => buildMessage({ content: 'x'.repeat(1995), pingEveryone: true }, { level: ADMIN }), /2000/);
});

test('parseMessageLink accepts Discord links only', () => {
  const link = 'https://discord.com/channels/111111111111111111/222222222222222222/333333333333333333';
  assert.deepEqual(parseMessageLink(link), { guildId: '111111111111111111', channelId: '222222222222222222', messageId: '333333333333333333' });
  assert.ok(parseMessageLink(link.replace('discord.com', 'ptb.discord.com')));
  assert.ok(parseMessageLink(`${link}?x=1`));
  for (const bad of ['', 'https://evil.com/channels/1/2/3', 'http://discord.com/channels/111111111111111111/222222222222222222/333333333333333333', 'https://discord.com.evil.io/channels/111111111111111111/222222222222222222/333333333333333333', 'https://discord.com/channels/@me/222222222222222222/333333333333333333', null]) {
    assert.equal(parseMessageLink(bad), null, String(bad));
  }
});

test('cleanEmoji allows real emoji and server emoji, and nothing that could alter the URL path', () => {
  for (const ok of ['👍', '🎉', '❤️', '1️⃣', 'party:123456789012345678']) assert.equal(cleanEmoji(ok), ok);
  for (const bad of ['../../x', 'a/b', '😀/😀', '', 'thumbsup', '%2e%2e', 'x'.repeat(40), '?query=1']) assert.throws(() => cleanEmoji(bad), HttpError, bad);
});

// ---- util -------------------------------------------------------------------------------------------

test('channelKey and plainName match the bot\'s rules (emoji prefixes ignored)', () => {
  assert.equal(channelKey('👋｜welcome'), 'welcome');
  assert.equal(channelKey('General'), 'general');
  assert.equal(channelKey('➕｜Create Room'), 'create-room');
  assert.equal(plainName('🛡 Moderator'), 'moderator');
  assert.equal(plainName('Admin'), 'admin');
});

// ---- routing and errors -----------------------------------------------------------------------------

test('matchRoute matches methods and parameters, and nothing else', () => {
  assert.equal(matchRoute('GET', '/api/me').route.access, 'staff');
  assert.equal(matchRoute('GET', '/api/auth/login').route.access, 'public');
  assert.deepEqual(matchRoute('DELETE', '/api/channels/123456789012345678').params, { id: '123456789012345678' });
  assert.equal(matchRoute('GET', '/api/channels/123'), null, 'wrong method');
  assert.equal(matchRoute('GET', '/api/me/extra'), null);
  assert.equal(matchRoute('GET', '/api/members/search').route.handler.name, 'search', 'static path wins over :id');
  assert.equal(matchRoute('GET', '/api/members/warned').route.handler.name, 'warned');
  assert.equal(matchRoute('GET', '/api/members/700000000000000004').route.handler.name, 'detail');
});

test('every admin-only route is a write, and no route is open without a reason', () => {
  const open = ['/api/health', '/api/auth/login', '/api/auth/callback', '/api/auth/dev', '/api/auth/logout'];
  for (const path of open) assert.equal(matchRoute(path === '/api/auth/logout' ? 'POST' : 'GET', path).route.access, 'public');
  for (const [method, path] of [['PUT', '/api/settings'], ['POST', '/api/channels'], ['POST', '/api/roles'], ['POST', '/api/members/roles'], ['POST', '/api/panels/repost']]) {
    assert.equal(matchRoute(method, path).route.access, 'admin', `${method} ${path}`);
  }
  assert.equal(matchRoute('POST', '/api/send').route.access, 'staff');
});

test('describeError turns Discord errors into advice and hides everything internal', () => {
  assert.deepEqual(describeError(new HttpError(422, 'bad')), { status: 422, message: 'bad' });
  assert.match(describeError(new DiscordApiError(403, 50013, 'Missing Permissions')).message, /higher role or a permission/);
  assert.equal(describeError(new DiscordApiError(404, 10003, 'Unknown Channel')).status, 404);
  assert.equal(describeError(new DiscordApiError(429, 0, 'slow')).status, 503);
  assert.equal(describeError(new DiscordApiError(400, 50035, 'Invalid Form Body')).status, 422);
  assert.equal(describeError(new DiscordApiError(500, 0, 'oops')).status, 502);
  const generic = describeError(new Error('secret stack token=abc'));
  assert.deepEqual(generic, { status: 500, message: 'Something went wrong on the server.' });
});

test('rate limiter blocks the Nth+1 call in the window and recovers afterwards', () => {
  resetLimits();
  for (let i = 0; i < 3; i++) limit('k', 3, 1000, 100 + i);
  assert.throws(() => limit('k', 3, 1000, 500), /Too many requests/);
  assert.doesNotThrow(() => limit('other', 3, 1000, 500), 'keys are independent');
  assert.doesNotThrow(() => limit('k', 3, 1000, 5000), 'old calls fall out of the window');
  resetLimits();
});

// ---- the Discord client -----------------------------------------------------------------------------

function scriptedFetch(responses) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), init });
    const r = responses.shift();
    if (r instanceof Error) throw r;
    return { status: r.status, ok: r.status < 400, json: async () => r.json ?? null };
  };
  return { fetchImpl, seen };
}

test('discord client: auth header, JSON body, query string, audit-log reason encoding, 204 handling', async () => {
  const { fetchImpl, seen } = scriptedFetch([{ status: 200, json: [{ id: 1 }] }, { status: 204 }]);
  const d = createDiscord({ token: 'TKN', guildId: '111111111111111111', fetchImpl });
  assert.deepEqual(await d.searchMembers('bob smith', 5), [{ id: 1 }]);
  assert.match(seen[0].url, /\/guilds\/111111111111111111\/members\/search\?query=bob\+smith&limit=5$/);
  assert.equal(seen[0].init.headers.Authorization, 'Bot TKN');
  assert.equal(await d.kick('222222222222222222', 'rule 1: שלום'), null);
  assert.equal(seen[1].init.method, 'DELETE');
  assert.doesNotMatch(seen[1].init.headers['X-Audit-Log-Reason'], /[^\x20-\x7e]/, 'header must be plain ASCII');
  assert.throws(() => createDiscord({ token: '', guildId: 'x', fetchImpl }), /DISCORD_BOT_TOKEN/);
  assert.throws(() => createDiscord({ token: 't', guildId: '', fetchImpl }), /GUILD_ID/);
});

test('discord client: retries once on a rate limit, then gives up; errors carry status, code and message', async () => {
  const slept = [];
  const { fetchImpl, seen } = scriptedFetch([{ status: 429, json: { retry_after: 0.5 } }, { status: 200, json: { ok: 1 } }]);
  const d = createDiscord({ token: 'T', guildId: '1', fetchImpl, sleep: async (ms) => slept.push(ms) });
  assert.deepEqual(await d.request('GET', '/x'), { ok: 1 });
  assert.deepEqual(slept, [500]);
  assert.equal(seen.length, 2);

  const twice = scriptedFetch([{ status: 429, json: { retry_after: 100 } }, { status: 429, json: { retry_after: 1 } }]);
  const d2 = createDiscord({ token: 'T', guildId: '1', fetchImpl: twice.fetchImpl, sleep: async (ms) => slept.push(ms) });
  await assert.rejects(() => d2.request('GET', '/x'), (e) => e instanceof DiscordApiError && e.status === 429);
  assert.equal(slept.at(-1), 5000, 'the wait is capped at 5 seconds');

  const bad = scriptedFetch([{ status: 403, json: { code: 50013, message: 'Missing Permissions' } }]);
  const d3 = createDiscord({ token: 'T', guildId: '1', fetchImpl: bad.fetchImpl });
  await assert.rejects(() => d3.request('POST', '/x', { body: {} }), (e) => e.status === 403 && e.code === 50013 && /Missing Permissions/.test(e.message));
});

test('discord client: dm() never throws, it reports false when DMs are closed', async () => {
  const closed = scriptedFetch([{ status: 200, json: { id: '5' } }, { status: 403, json: { code: 50007, message: 'Cannot send messages to this user' } }]);
  assert.equal(await createDiscord({ token: 'T', guildId: '1', fetchImpl: closed.fetchImpl }).dm('9', 'hi'), false);
  const ok = scriptedFetch([{ status: 200, json: { id: '5' } }, { status: 200, json: { id: 'm' } }]);
  assert.equal(await createDiscord({ token: 'T', guildId: '1', fetchImpl: ok.fetchImpl }).dm('9', 'hi'), true);
});
