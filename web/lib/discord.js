const API = 'https://discord.com/api/v10';
const TIMEOUT_MS = 10_000;
const MAX_RETRY_WAIT_S = 5;

export class DiscordApiError extends Error {
  constructor(status, code, message, path) {
    super(message);
    this.status = status;
    this.code = code;
    this.path = path;
  }
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A small Discord REST client bound to one server. Every call is made as the bot, so the dashboard keeps working
 * when the bot process is offline. Retries once on a rate limit, never retries anything else.
 */
export function createDiscord({ token, guildId, fetchImpl = globalThis.fetch, sleep = defaultSleep }) {
  if (!token) throw new Error('DISCORD_BOT_TOKEN is not set.');
  if (!guildId) throw new Error('GUILD_ID is not set.');

  async function request(method, path, { body, query, reason } = {}, attempt = 0) {
    const url = new URL(`${API}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    const headers = { Authorization: `Bot ${token}`, 'User-Agent': 'StealAnAlienDashboard (staff dashboard, 1.0)' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (reason) headers['X-Audit-Log-Reason'] = encodeURIComponent(reason).slice(0, 512);

    const res = await fetchImpl(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 429 && attempt < 1) {
      const data = await res.json().catch(() => ({}));
      await sleep(Math.min(Number(data.retry_after ?? 1), MAX_RETRY_WAIT_S) * 1000);
      return request(method, path, { body, query, reason }, attempt + 1);
    }
    if (res.status === 204) return null;
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new DiscordApiError(res.status, data?.code, data?.message ?? res.statusText ?? 'Discord error', path);
    return data;
  }

  const g = `/guilds/${guildId}`;
  const emojiPath = (emoji) => encodeURIComponent(emoji);

  return {
    guildId,
    request,
    /** (method, path, body) shape used by the shared AutoMod sync */
    rest: (method, path, body) => request(method, path, body === undefined ? {} : { body }),

    guild: () => request('GET', g, { query: { with_counts: true } }),
    channels: () => request('GET', `${g}/channels`),
    roles: () => request('GET', `${g}/roles`),
    member: (userId) => request('GET', `${g}/members/${userId}`),
    searchMembers: (query, limit = 10) => request('GET', `${g}/members/search`, { query: { query, limit } }),

    sendMessage: (channelId, payload) => request('POST', `/channels/${channelId}/messages`, { body: payload }),
    editMessage: (channelId, messageId, payload) => request('PATCH', `/channels/${channelId}/messages/${messageId}`, { body: payload }),
    deleteMessage: (channelId, messageId, reason) => request('DELETE', `/channels/${channelId}/messages/${messageId}`, { reason }),
    getMessage: (channelId, messageId) => request('GET', `/channels/${channelId}/messages/${messageId}`),
    react: (channelId, messageId, emoji) => request('PUT', `/channels/${channelId}/messages/${messageId}/reactions/${emojiPath(emoji)}/@me`),

    createChannel: (payload, reason) => request('POST', `${g}/channels`, { body: payload, reason }),
    patchChannel: (channelId, payload, reason) => request('PATCH', `/channels/${channelId}`, { body: payload, reason }),
    deleteChannel: (channelId, reason) => request('DELETE', `/channels/${channelId}`, { reason }),

    createRole: (payload, reason) => request('POST', `${g}/roles`, { body: payload, reason }),
    deleteRole: (roleId, reason) => request('DELETE', `${g}/roles/${roleId}`, { reason }),
    addRole: (userId, roleId, reason) => request('PUT', `${g}/members/${userId}/roles/${roleId}`, { reason }),
    removeRole: (userId, roleId, reason) => request('DELETE', `${g}/members/${userId}/roles/${roleId}`, { reason }),

    timeout: (userId, untilIso, reason) => request('PATCH', `${g}/members/${userId}`, { body: { communication_disabled_until: untilIso }, reason }),
    kick: (userId, reason) => request('DELETE', `${g}/members/${userId}`, { reason }),
    ban: (userId, { deleteSeconds = 0, reason } = {}) => request('PUT', `${g}/bans/${userId}`, { body: { delete_message_seconds: deleteSeconds }, reason }),
    unban: (userId, reason) => request('DELETE', `${g}/bans/${userId}`, { reason }),
    getBan: (userId) => request('GET', `${g}/bans/${userId}`),

    /** Direct message; resolves to false (never throws) when the person has DMs closed. */
    async dm(userId, content) {
      try {
        const channel = await request('POST', '/users/@me/channels', { body: { recipient_id: userId } });
        await request('POST', `/channels/${channel.id}/messages`, { body: { content } });
        return true;
      } catch {
        return false;
      }
    },
  };
}
