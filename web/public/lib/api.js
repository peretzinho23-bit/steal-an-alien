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

const HEBREW_BY_STATUS = {
  401: 'צריך להתחבר מחדש.',
  403: 'אין לך הרשאה לפעולה הזו.',
  404: 'לא נמצא.',
  429: 'יותר מדי בקשות. חכה כמה שניות ונסה שוב.',
  503: 'השירות לא זמין כרגע.',
};

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
    throw new ApiError(0, 'אין חיבור לשרת. בדוק את האינטרנט ונסה שוב.');
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
    const base = HEBREW_BY_STATUS[res.status] ?? `שגיאה (${res.status}).`;
    throw new ApiError(res.status, detail && res.status !== 401 ? `${base} ${detail}` : base);
  }
  return data;
}

export const get = (path) => api(path);
export const post = (path, body = {}) => api(path, { method: 'POST', body });
export const put = (path, body = {}) => api(path, { method: 'PUT', body });
export const patch = (path, body = {}) => api(path, { method: 'PATCH', body });
export const del = (path, body = {}) => api(path, { method: 'DELETE', body });
