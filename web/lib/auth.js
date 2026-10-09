import { HttpError, clearCookie, isLocalHost, isSecureRequest, originOf, parseCookies, serializeCookie } from './http.js';
import { REVALIDATE_AFTER_MS, SESSION_MAX_AGE_S, newState, safeEqual, sign, verify } from './session.js';
import { DiscordApiError } from './discord.js';
import { computeLevel, hasLevel } from './shared/permissions.js';
import { avatarUrl, guildIconUrl } from './util.js';

const SESSION_COOKIE = 'saa_session';
const STATE_COOKIE = 'saa_oauth';
const DISCORD = 'https://discord.com/api/v10';

/** admin | staff | null for one member of the server, decided from their roles right now. */
export async function levelOf(services, userId) {
  const [guild, roles] = await Promise.all([services.guild(), services.roles()]);
  let member;
  try {
    member = await services.discord.member(userId);
  } catch (e) {
    if (e instanceof DiscordApiError && e.status === 404) return null; // not in the server
    throw e;
  }
  return computeLevel({ guildId: services.config.guildId, ownerId: guild.owner_id, userId, memberRoleIds: member.roles ?? [], guildRoles: roles });
}

const cookieOpts = (req) => ({ secure: isSecureRequest(req) });

function sessionCookie(req, services, session) {
  return serializeCookie(SESSION_COOKIE, sign(session, services.config.sessionSecret), { ...cookieOpts(req), maxAge: SESSION_MAX_AGE_S });
}

const newSession = (services, user, level) => ({
  uid: user.id,
  name: user.global_name ?? user.username ?? 'unknown',
  avatar: avatarUrl(user),
  level,
  chk: services.now(),
  exp: services.now() + SESSION_MAX_AGE_S * 1000,
});

/**
 * Reads the signed cookie. Staff status is re-checked against Discord every 10 minutes, so removing someone's
 * Moderator role locks them out of the dashboard within that time.
 * @returns { session, cookie? } where cookie is a refreshed Set-Cookie value when the session was renewed
 */
export async function authenticate(req, services) {
  const raw = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  const session = raw ? verify(raw, services.config.sessionSecret, services.now()) : null;
  if (!session) throw new HttpError(401, 'Please sign in with Discord.');
  if (services.now() - session.chk < REVALIDATE_AFTER_MS) return { session };
  if (session.dev) return { session: { ...session, chk: services.now() } }; // dev sessions have no real member to re-check
  const level = await levelOf(services, session.uid);
  if (!level) throw new HttpError(401, 'You no longer have staff access to this server.');
  const renewed = { ...session, level, chk: services.now() };
  return { session: renewed, cookie: sessionCookie(req, services, renewed) };
}

export function requireLevel(session, required) {
  if (!hasLevel(session.level, required)) {
    throw new HttpError(403, required === 'admin' ? 'This needs an admin.' : 'This is for staff only.');
  }
}

// ---- routes ---------------------------------------------------------------------------------------------

export function login({ req, services, url }) {
  const { config } = services;
  if (!config.clientId) throw new HttpError(500, 'האתר עוד לא מוגדר (חסר DISCORD_CLIENT_ID).');
  const state = newState();
  const redirectUri = `${originOf(req)}/api/auth/callback`;
  const target = new URL('https://discord.com/oauth2/authorize');
  target.search = new URLSearchParams({
    client_id: config.clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: 'identify',
    state,
    prompt: 'none',
  }).toString();
  return {
    redirect: target.toString(),
    cookies: [serializeCookie(STATE_COOKIE, sign({ state, exp: services.now() + 10 * 60_000 }, config.sessionSecret), { ...cookieOpts(req), maxAge: 600 })],
  };
}

export async function callback({ req, services, url }) {
  const { config } = services;
  const clear = clearCookie(STATE_COOKIE, cookieOpts(req));
  const fail = (code) => ({ redirect: `/?error=${code}`, cookies: [clear] });
  if (url.searchParams.get('error')) return fail('denied');

  const stored = verify(parseCookies(req.headers.cookie)[STATE_COOKIE] ?? '', config.sessionSecret, services.now());
  const state = url.searchParams.get('state') ?? '';
  const code = url.searchParams.get('code') ?? '';
  if (!stored || !state || !safeEqual(stored.state, state) || !code) return fail('state');

  const tokenRes = await services.fetch(`${DISCORD}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${originOf(req)}/api/auth/callback`,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!tokenRes.ok) return fail('token');
  const { access_token: accessToken } = await tokenRes.json();
  const meRes = await services.fetch(`${DISCORD}/users/@me`, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10_000) });
  if (!meRes.ok) return fail('user');
  const user = await meRes.json();

  const level = await levelOf(services, user.id);
  if (!level) return fail('not-staff');
  return { redirect: '/', cookies: [clear, sessionCookie(req, services, newSession(services, user, level))] };
}

export function logout({ req }) {
  return { json: { ok: true }, cookies: [clearCookie(SESSION_COOKIE, cookieOpts(req))] };
}

/**
 * Local testing only: signs in as a fake admin. It needs ALLOW_DEV_LOGIN=1, is never active on Vercel and
 * answers 404 unless the request really is to localhost.
 */
export function devLogin({ req, services }) {
  if (!services.config.allowDevLogin || !isLocalHost(req)) throw new HttpError(404, 'Not found.');
  const session = { ...newSession(services, { id: '0', username: 'Local tester' }, 'admin'), dev: true };
  return { redirect: '/', cookies: [sessionCookie(req, services, session)] };
}

export async function me({ session, services }) {
  const guild = await services.guild().catch(() => null);
  return {
    user: { id: session.uid, name: session.name, avatar: session.avatar },
    level: session.level,
    dev: Boolean(session.dev),
    guild: guild ? { id: guild.id, name: guild.name, icon: guildIconUrl(guild), members: guild.approximate_member_count ?? null } : null,
    redis: Boolean(services.kv),
  };
}
