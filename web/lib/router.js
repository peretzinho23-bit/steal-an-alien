import { authenticate, callback, devLogin, login, logout, me, requireLevel } from './auth.js';
import { DiscordApiError } from './discord.js';
import { configProblems } from './context.js';
import { HttpError, hostOf, isSecureRequest, readJson, redirect, sendJson } from './http.js';
import { limit } from './ratelimit.js';
import * as members from './handlers/members.js';
import * as messages from './handlers/messages.js';
import * as server from './handlers/server.js';

/** [method, path pattern, who may call it, handler]. "public" skips the login; "staff" and "admin" need that level. */
export const ROUTES = [
  ['GET', '/api/health', 'public', ({ services }) => ({ ok: true, configured: configProblems(services.config).length === 0 })],
  ['GET', '/api/auth/login', 'public', login],
  ['GET', '/api/auth/callback', 'public', callback],
  ['GET', '/api/auth/dev', 'public', devLogin],
  ['POST', '/api/auth/logout', 'public', logout],

  ['GET', '/api/me', 'staff', me],
  ['GET', '/api/guild', 'staff', server.guildInfo],
  ['GET', '/api/status', 'staff', server.status],
  ['GET', '/api/leaderboard', 'staff', server.leaderboard],
  ['GET', '/api/activity', 'staff', server.activity],
  ['GET', '/api/jobs', 'staff', server.jobResults],

  ['POST', '/api/send', 'staff', messages.send],
  ['GET', '/api/messages/lookup', 'staff', messages.lookup],
  ['POST', '/api/messages/edit', 'staff', messages.edit],
  ['POST', '/api/messages/delete', 'staff', messages.remove],
  ['POST', '/api/messages/react', 'staff', messages.react],

  ['GET', '/api/members/search', 'staff', members.search],
  ['GET', '/api/members/warned', 'staff', members.warned],
  ['GET', '/api/members/:id', 'staff', members.detail],
  ['POST', '/api/mod/warn', 'staff', members.warn],
  ['POST', '/api/mod/unwarn', 'staff', members.unwarn],
  ['POST', '/api/mod/timeout', 'staff', members.timeout],
  ['POST', '/api/mod/untimeout', 'staff', members.untimeout],
  ['POST', '/api/mod/kick', 'staff', members.kick],
  ['POST', '/api/mod/ban', 'staff', members.ban],
  ['POST', '/api/mod/unban', 'staff', members.unban],
  ['POST', '/api/lockdown', 'staff', server.lockdown],

  ['GET', '/api/settings', 'staff', server.getSettings],
  ['PUT', '/api/settings', 'admin', server.putSettings],
  ['POST', '/api/channels', 'admin', server.createChannel],
  ['PATCH', '/api/channels/:id', 'admin', server.patchChannel],
  ['DELETE', '/api/channels/:id', 'admin', server.deleteChannel],
  ['POST', '/api/roles', 'admin', server.createRole],
  ['DELETE', '/api/roles/:id', 'admin', server.deleteRole],
  ['POST', '/api/members/roles', 'admin', server.memberRoles],
  ['POST', '/api/panels/repost', 'admin', server.repostPanel],
];

const compiled = ROUTES.map(([method, pattern, access, handler]) => ({
  method,
  access,
  handler,
  regex: new RegExp(`^${pattern.replace(/:[a-z]+/gi, '([^/]+)')}$`),
  names: [...pattern.matchAll(/:([a-z]+)/gi)].map((m) => m[1]),
}));

export function matchRoute(method, path) {
  for (const route of compiled) {
    if (route.method !== method) continue;
    const m = route.regex.exec(path);
    if (m) return { route, params: Object.fromEntries(route.names.map((n, i) => [n, decodeURIComponent(m[i + 1])])) };
  }
  return null;
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Cross-site request forgery: a custom header a foreign page cannot send, and an Origin that must be us. */
export function checkCsrf(req) {
  if (req.headers['x-saa'] !== '1') throw new HttpError(403, 'Missing request header.');
  const origin = req.headers.origin;
  if (origin) {
    let host;
    try {
      host = new URL(origin).host;
    } catch {
      throw new HttpError(403, 'Bad origin.');
    }
    if (host !== hostOf(req)) throw new HttpError(403, 'This request came from another site.');
  }
}

/** Discord's errors, in words the person using the dashboard can act on. Never includes tokens or stack traces. */
export function describeError(e) {
  if (e instanceof HttpError) return { status: e.status, message: e.message };
  if (e instanceof DiscordApiError) {
    if (e.status === 403 || e.code === 50013) return { status: 502, message: `Discord refused this: ${e.message}. The bot may need a higher role or a permission.` };
    if (e.status === 404) return { status: 404, message: 'Discord could not find that (it may have been deleted).' };
    if (e.status === 429) return { status: 503, message: 'Discord is rate limiting the bot. Try again in a few seconds.' };
    if (e.status === 400) return { status: 422, message: `Discord did not accept this: ${e.message}` };
    return { status: 502, message: `Discord error: ${e.message}` };
  }
  return { status: 500, message: 'Something went wrong on the server.' };
}

export function createHandler(getServices) {
  return async function handler(req, res) {
    try {
      const services = getServices();
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname.replace(/\/+$/, '') || '/';
      const matched = matchRoute(req.method, path);
      if (!matched) throw new HttpError(404, 'Not found.');
      const { route, params } = matched;

      const problems = configProblems(services.config);
      if (problems.length && route.access !== 'public') throw new HttpError(503, `The site is not configured yet. Missing: ${problems.join(', ')}.`);

      const unsafe = UNSAFE.has(req.method);
      if (unsafe) checkCsrf(req);

      const ctx = { req, res, url, params, services, body: {}, session: null };
      const cookies = [];
      if (route.access !== 'public') {
        const auth = await authenticate(req, services);
        ctx.session = auth.session;
        if (auth.cookie) cookies.push(auth.cookie);
        requireLevel(auth.session, route.access);
        if (unsafe) limit(`api:${auth.session.uid}`, 120, 60_000, services.now());
      }
      if (unsafe) ctx.body = await readJson(req);

      const result = await route.handler(ctx);
      if (result?.cookies) cookies.push(...result.cookies);
      const headers = cookies.length ? { 'Set-Cookie': cookies } : {};
      if (result?.redirect) return redirect(res, result.redirect, headers);
      return sendJson(res, 200, result?.json ?? result ?? { ok: true }, headers);
    } catch (e) {
      const { status, message } = describeError(e);
      if (status === 500) console.error('API error:', e);
      const headers = {};
      if (status === 429) headers['Retry-After'] = '10';
      sendJson(res, status, { error: message }, headers);
    }
  };
}

export { isSecureRequest };
