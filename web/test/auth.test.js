import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../lib/context.js';
import { sign } from '../lib/session.js';
import { ADMIN_ID, DEV_ID, GUILD, MOD_ID, NOW, ROLE_IDS, SECRET, VICTIM_ID, call, fakeDiscord, makeServices, resetLimits, sessionCookie } from './helpers.js';

const cookieOf = (res, name) => {
  const all = [].concat(res.headers['set-cookie'] ?? []);
  return all.find((c) => c.startsWith(`${name}=`));
};

// ---- basic gates ------------------------------------------------------------------------------------

test('unknown paths are 404 and the health check works without a login', async () => {
  const s = makeServices();
  assert.equal((await call(s, { url: '/api/nope' })).status, 404);
  const health = await call(s, { url: '/api/health' });
  assert.equal(health.status, 200);
  assert.deepEqual(health.json, { ok: true, configured: true });
});

test('every protected route answers 401 without a session, with a clear message', async () => {
  const s = makeServices();
  for (const [method, url] of [['GET', '/api/me'], ['GET', '/api/guild'], ['POST', '/api/send'], ['PUT', '/api/settings'], ['POST', '/api/mod/ban'], ['DELETE', '/api/channels/123456789012345678']]) {
    const res = await call(s, { method, url, body: {} });
    assert.equal(res.status, 401, `${method} ${url}`);
    assert.match(res.json.error, /sign in/i);
  }
});

test('a missing configuration gives a 503 that names the missing variable (never a crash)', async () => {
  const s = makeServices({ extraConfig: { clientSecret: '' } });
  const res = await call(s, { url: '/api/me', cookie: sessionCookie(s) });
  assert.equal(res.status, 503);
  assert.match(res.json.error, /DISCORD_CLIENT_SECRET/);
  assert.equal((await call(s, { url: '/api/health' })).json.configured, false);
});

test('tampered, expired and foreign-secret cookies are rejected', async () => {
  const s = makeServices();
  const good = sessionCookie(s);
  assert.equal((await call(s, { cookie: good })).status, 200);
  const [name, value] = good.split('=');
  const forged = `${name}=${encodeURIComponent(decodeURIComponent(value).replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')))}`;
  assert.equal((await call(s, { cookie: forged })).status, 401);
  assert.equal((await call(s, { cookie: sessionCookie(s, { exp: NOW - 1 }) })).status, 401);
  const foreign = `saa_session=${encodeURIComponent(sign({ uid: ADMIN_ID, level: 'admin', chk: NOW, exp: NOW + 1e6 }, 'a-different-long-secret-for-the-test-1'))}`;
  assert.equal((await call(s, { cookie: foreign })).status, 401);
});

// ---- CSRF and permission levels ---------------------------------------------------------------------

test('CSRF: a write without the custom header, or from another origin, is refused before anything runs', async () => {
  const s = makeServices();
  const cookie = sessionCookie(s);
  const noHeader = await call(s, { method: 'POST', url: '/api/send', cookie, body: { content: 'x' }, headers: { 'x-saa': '0' } });
  assert.equal(noHeader.status, 403);
  const foreign = await call(s, { method: 'POST', url: '/api/send', cookie, body: { content: 'x', channelId: '600000000000000001' }, headers: { origin: 'https://evil.example.org' } });
  assert.equal(foreign.status, 403);
  assert.match(foreign.json.error, /another site/);
  assert.equal(s.discord.calls.filter((c) => c[0] === 'sendMessage').length, 0, 'nothing was sent');
  const same = await call(s, { method: 'POST', url: '/api/send', cookie, body: { content: 'x', channelId: '600000000000000001' }, headers: { origin: 'https://dash.example.com' } });
  assert.equal(same.status, 200);
  assert.equal((await call(s, { method: 'POST', url: '/api/send', cookie, body: { content: 'x', channelId: '600000000000000001' }, headers: { origin: 'not a url' } })).status, 403);
});

test('levels: staff cannot use admin routes, admins can, and each answer says why', async () => {
  const s = makeServices();
  const staff = sessionCookie(s, { uid: MOD_ID, level: 'staff' });
  const admin = sessionCookie(s, { uid: ADMIN_ID, level: 'admin' });
  for (const [method, url, body] of [
    ['PUT', '/api/settings', { settings: {} }],
    ['POST', '/api/channels', { name: 'x', type: 'text' }],
    ['POST', '/api/roles', { name: 'x' }],
    ['DELETE', '/api/roles/500000000000000007', { confirm: 'Plain' }],
    ['POST', '/api/members/roles', { userId: VICTIM_ID, add: [ROLE_IDS.news] }],
    ['POST', '/api/panels/repost', { panel: 'welcome' }],
  ]) {
    const denied = await call(s, { method, url, body, cookie: staff });
    assert.equal(denied.status, 403, `${method} ${url} as staff`);
    assert.match(denied.json.error, /admin/i);
  }
  assert.equal((await call(s, { method: 'POST', url: '/api/roles', body: { name: 'Fine' }, cookie: admin })).status, 200);
  assert.equal((await call(s, { url: '/api/me', cookie: staff })).status, 200, 'staff can read');
});

// ---- OAuth ------------------------------------------------------------------------------------------

test('login redirects to Discord with the right client, scope and a state cookie bound to this browser', async () => {
  const s = makeServices();
  const res = await call(s, { url: '/api/auth/login' });
  assert.equal(res.status, 302);
  const url = new URL(res.location);
  assert.equal(url.origin + url.pathname, 'https://discord.com/oauth2/authorize');
  assert.equal(url.searchParams.get('client_id'), '999');
  assert.equal(url.searchParams.get('scope'), 'identify');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://dash.example.com/api/auth/callback');
  assert.ok(url.searchParams.get('state').length >= 16);
  const state = cookieOf(res, 'saa_oauth');
  assert.match(state, /HttpOnly/);
  assert.match(state, /SameSite=Lax/);
  assert.match(state, /Secure/);
});

function oauthFetch({ user = { id: MOD_ID, username: 'moduser' }, tokenOk = true, userOk = true } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/oauth2/token')) return { ok: tokenOk, status: tokenOk ? 200 : 400, json: async () => (tokenOk ? { access_token: 'AT' } : { error: 'invalid_grant' }) };
    return { ok: userOk, status: userOk ? 200 : 401, json: async () => user };
  };
  fn.calls = calls;
  return fn;
}

async function startLogin(s) {
  const res = await call(s, { url: '/api/auth/login' });
  const state = new URL(res.location).searchParams.get('state');
  const cookie = cookieOf(res, 'saa_oauth').split(';')[0];
  return { state, cookie };
}

test('callback: a moderator who completes the flow gets a signed session cookie and lands on the dashboard', async () => {
  const fetch = oauthFetch();
  const s = makeServices({ fetch });
  const { state, cookie } = await startLogin(s);
  const res = await call(s, { url: `/api/auth/callback?code=abc&state=${state}`, cookie });
  assert.equal(res.status, 302);
  assert.equal(res.location, '/');
  const session = cookieOf(res, 'saa_session');
  assert.match(session, /HttpOnly/);
  assert.match(session, /Max-Age=28800/);
  assert.match(cookieOf(res, 'saa_oauth'), /Max-Age=0/, 'the one-time state cookie is cleared');
  const sent = fetch.calls[0].init.body.toString();
  assert.match(sent, /grant_type=authorization_code/);
  assert.match(sent, /code=abc/);
  assert.match(sent, /redirect_uri=https%3A%2F%2Fdash\.example\.com%2Fapi%2Fauth%2Fcallback/);

  const me = await call(s, { url: '/api/me', cookie: session.split(';')[0] });
  assert.equal(me.status, 200);
  assert.equal(me.json.level, 'staff');
  assert.equal(me.json.guild.name, 'Steal an alien');
});

test('callback: wrong state, missing state cookie, denied consent and token failures never create a session', async () => {
  const s = makeServices({ fetch: oauthFetch() });
  const { state, cookie } = await startLogin(s);
  const expectFail = async (url, ck, code) => {
    const res = await call(s, { url, cookie: ck });
    assert.equal(res.location, `/?error=${code}`, url);
    assert.equal(cookieOf(res, 'saa_session'), undefined, 'no session');
  };
  await expectFail(`/api/auth/callback?code=abc&state=WRONG`, cookie, 'state');
  await expectFail(`/api/auth/callback?code=abc&state=${state}`, undefined, 'state');
  await expectFail(`/api/auth/callback?state=${state}`, cookie, 'state');
  await expectFail(`/api/auth/callback?error=access_denied&state=${state}`, cookie, 'denied');
  const badToken = makeServices({ fetch: oauthFetch({ tokenOk: false }) });
  const login = await startLogin(badToken);
  const res = await call(badToken, { url: `/api/auth/callback?code=abc&state=${login.state}`, cookie: login.cookie });
  assert.equal(res.location, '/?error=token');
});

test('callback: someone who is not staff (or not even in the server) is turned away', async () => {
  for (const id of [DEV_ID, VICTIM_ID, '700000000000000099']) {
    const s = makeServices({ fetch: oauthFetch({ user: { id, username: 'x' } }) });
    const { state, cookie } = await startLogin(s);
    const res = await call(s, { url: `/api/auth/callback?code=abc&state=${state}`, cookie });
    assert.equal(res.location, '/?error=not-staff', id);
    assert.equal(cookieOf(res, 'saa_session'), undefined);
  }
});

test('callback: a state cookie cannot be replayed after it expired', async () => {
  const s = makeServices({ fetch: oauthFetch() });
  const { state, cookie } = await startLogin(s);
  s.clock += 11 * 60_000;
  const res = await call(s, { url: `/api/auth/callback?code=abc&state=${state}`, cookie });
  assert.equal(res.location, '/?error=state');
});

// ---- session renewal --------------------------------------------------------------------------------

test('staff status is re-checked every 10 minutes: a removed role locks the person out, a kept role renews the cookie', async () => {
  const s = makeServices();
  const cookie = sessionCookie(s, { uid: MOD_ID, level: 'staff' });
  assert.equal((await call(s, { cookie })).headers['set-cookie'], undefined, 'fresh session: no re-check yet');

  s.clock += 11 * 60_000;
  const renewed = await call(s, { cookie });
  assert.equal(renewed.status, 200);
  assert.ok(cookieOf(renewed, 'saa_session'), 'cookie was renewed');

  s.discord.data.members[MOD_ID].roles = []; // the moderator role is taken away
  s.clock += 11 * 60_000;
  const gone = await call(s, { cookie: sessionCookie(s, { uid: MOD_ID, level: 'staff', chk: NOW }) });
  assert.equal(gone.status, 401);
  assert.match(gone.json.error, /no longer/);
});

test('a role change is picked up on renewal (staff promoted to admin gets admin rights)', async () => {
  const s = makeServices();
  const stale = sessionCookie(s, { uid: MOD_ID, level: 'staff', chk: NOW - 11 * 60_000 });
  s.discord.data.members[MOD_ID].roles = [ROLE_IDS.admin];
  const res = await call(s, { method: 'POST', url: '/api/roles', body: { name: 'Fine' }, cookie: stale });
  assert.equal(res.status, 200, 'promotion applies at the next check');
});

test('logout clears the session cookie', async () => {
  const s = makeServices();
  const res = await call(s, { method: 'POST', url: '/api/auth/logout', body: {}, cookie: sessionCookie(s) });
  assert.equal(res.status, 200);
  assert.match(cookieOf(res, 'saa_session'), /Max-Age=0/);
});

// ---- dev login --------------------------------------------------------------------------------------

test('dev login: off by default, off on any real host, off on Vercel; only on localhost with the switch', async () => {
  const off = makeServices();
  assert.equal((await call(off, { url: '/api/auth/dev', headers: { host: 'localhost:3000', 'x-forwarded-proto': 'http' } })).status, 404);
  const on = makeServices({ allowDevLogin: true });
  assert.equal((await call(on, { url: '/api/auth/dev' })).status, 404, 'enabled but the host is dash.example.com');
  assert.equal((await call(on, { url: '/api/auth/dev', headers: { host: 'localhost.evil.com' } })).status, 404);
  const ok = await call(on, { url: '/api/auth/dev', headers: { host: 'localhost:3000', 'x-forwarded-proto': 'http' } });
  assert.equal(ok.status, 302);
  assert.ok(cookieOf(ok, 'saa_session'));
  assert.doesNotMatch(cookieOf(ok, 'saa_session'), /Secure/, 'plain http on localhost');

  assert.equal(loadConfig({ ALLOW_DEV_LOGIN: '1', VERCEL: '1' }).allowDevLogin, false, 'never on Vercel');
  assert.equal(loadConfig({ ALLOW_DEV_LOGIN: '1' }).allowDevLogin, true);
  assert.equal(loadConfig({}).allowDevLogin, false);
});

test('a dev session works on localhost and is not re-validated against a real member', async () => {
  const on = makeServices({ allowDevLogin: true });
  const cookie = sessionCookie(on, { uid: '0', level: 'admin', dev: true, chk: NOW - 60 * 60_000 });
  const res = await call(on, { cookie });
  assert.equal(res.status, 200);
  assert.equal(res.json.dev, true);
  resetLimits();
});
