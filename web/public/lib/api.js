import { t } from './i18n.js';

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => {
  onUnauthorized = fn;
};

const statusText = (status) => (status in { 401: 1, 403: 1, 404: 1, 429: 1, 503: 1 } ? t(`api.status.${status}`) : t('api.status.other', { status }));

/** Calls the dashboard API. Every write carries the custom header the server requires against cross-site requests. */
export async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: { 'X-SAA': '1', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, t('api.offline'));
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty or non-JSON body */
  }
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth/')) onUnauthorized();
    const detail = data?.error;
    const base = statusText(res.status);
    throw new ApiError(res.status, detail && res.status !== 401 ? `${base} ${detail}` : base);
  }
  return data;
}

export const get = (path) => api(path);
export const post = (path, body = {}) => api(path, { method: 'POST', body });
export const put = (path, body = {}) => api(path, { method: 'PUT', body });
export const patch = (path, body = {}) => api(path, { method: 'PATCH', body });
export const del = (path, body = {}) => api(path, { method: 'DELETE', body });
