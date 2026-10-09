/** Small HTTP helpers that work with Vercel's Node functions and with a plain node:http server alike. */

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const MAX_BODY_BYTES = 200 * 1024;

export function sendJson(res, status, data, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(data));
}

export function redirect(res, location, headers = {}) {
  res.statusCode = 302;
  res.setHeader('Location', location);
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end();
}

/** Reads the JSON body (Vercel pre-parses it; a plain Node server does not). Rejects anything over 200 KB. */
export async function readJson(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
    return parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body));
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request body is too large.');
    chunks.push(chunk);
  }
  return parse(Buffer.concat(chunks).toString('utf8'));
}

function parse(text) {
  if (!text.trim()) return {};
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value;
  } catch {
    throw new HttpError(400, 'The request body must be a JSON object.');
  }
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const key = part.slice(0, i).trim();
    try {
      out[key] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* ignore a malformed cookie value */
    }
  }
  return out;
}

export function serializeCookie(name, value, { maxAge, secure = true, sameSite = 'Lax', path = '/' } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, 'HttpOnly', `SameSite=${sameSite}`];
  if (secure) parts.push('Secure');
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
  return parts.join('; ');
}

export const clearCookie = (name, opts = {}) => serializeCookie(name, '', { ...opts, maxAge: 0 });

/** True when the request came in over HTTPS (directly or behind a proxy such as Vercel). */
export function isSecureRequest(req) {
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim();
  return proto === 'https' || Boolean(req.socket?.encrypted);
}

export const hostOf = (req) => String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '').split(',')[0].trim();

/** Origin of this site: BASE_URL when configured, otherwise derived from the request. */
export function originOf(req, env = process.env) {
  if (env.BASE_URL) return env.BASE_URL.replace(/\/+$/, '');
  return `${isSecureRequest(req) ? 'https' : 'http'}://${hostOf(req)}`;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
export const isLocalHost = (req) => LOCAL_HOSTS.has(hostOf(req).replace(/:\d+$/, '').toLowerCase());
