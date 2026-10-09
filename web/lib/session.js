import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Stateless signed sessions: base64url(JSON) + "." + HMAC-SHA256. Nothing secret is inside the cookie, and it
 * cannot be forged or edited without SESSION_SECRET. Used for the login session and for the short OAuth state.
 */

export const SESSION_MAX_AGE_S = 8 * 60 * 60; // 8 hours
export const REVALIDATE_AFTER_MS = 10 * 60 * 1000; // staff status is re-checked this often

const b64 = (buf) => Buffer.from(buf).toString('base64url');

function mac(secret, data) {
  return createHmac('sha256', secret).update(data).digest();
}

export function requireSecret(secret) {
  if (!secret || secret.length < 24) throw new Error('SESSION_SECRET is missing or shorter than 24 characters.');
  return secret;
}

export function sign(payload, secret) {
  requireSecret(secret);
  const body = b64(JSON.stringify(payload));
  return `${body}.${b64(mac(secret, body))}`;
}

/** @returns the payload, or null for anything forged, malformed or expired (payload.exp is in ms). */
export function verify(token, secret, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 4096) return null;
  const dot = token.indexOf('.');
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1), 'base64url');
  const expected = mac(requireSecret(secret), body);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof payload.exp !== 'number' || payload.exp <= now) return null;
    return payload;
  } catch {
    return null;
  }
}

export const newState = () => randomBytes(16).toString('base64url');

/** Constant-time string comparison (for the OAuth state). */
export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}
