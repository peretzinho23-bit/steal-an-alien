import { describeSync, syncNativeAutoMod } from './automod.js';
import { applyGate } from './gate.js';
import { lockdownOff, lockdownOn } from './lockdown.js';
import { syncPanels } from './panels.js';
import { KEYS } from './shared/kv.js';
import { getSettings, refreshSettings, runtime } from './runtime.js';

const log = (...args) => console.log(new Date().toISOString(), ...args);
const MAX_PER_TICK = 10;
const MAX_AGE_MS = 5 * 60_000; // a lockdown requested a long time ago (bot was offline) must not fire now

const asInt = (v, d, min, max) => (Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Math.trunc(Number(v)))) : d);

/** Someone acting through the dashboard, shaped like a Discord user for the log helpers. */
const actor = (by) => ({ id: by?.id ?? '0', tag: `${by?.name ?? 'dashboard'} (dashboard)`, toString: () => `<@${by?.id ?? '0'}> (dashboard)` });

/** What the website may ask the bot to do. Everything else is rejected. */
export const HANDLERS = {
  async lockdown({ payload, by }, guild) {
    if (payload?.on) {
      const r = await lockdownOn(guild, { minutes: asInt(payload.minutes, 15, 1, 1440), by: actor(by), reason: `Lockdown from the dashboard by ${by?.name ?? 'unknown'}` });
      return `locked ${r.locked} channel(s), invites ${r.invitesPaused ? 'paused' : 'not paused'}`;
    }
    const r = await lockdownOff(guild, { by: actor(by), reason: `Lockdown ended from the dashboard by ${by?.name ?? 'unknown'}` });
    return `reopened ${r.opened} channel(s)`;
  },
  async 'reload-settings'() {
    return (await refreshSettings()) ? 'settings changed' : 'settings unchanged';
  },
  async 'sync-automod'(job, guild) {
    const summary = await syncNativeAutoMod(guild, { force: true });
    if (summary?.errors.length) throw new Error(describeSync(summary)); // a partial failure must not look like success
    return describeSync(summary);
  },
  async 'apply-gate'(job, guild) {
    const r = await applyGate(guild, getSettings().raid.gate);
    return `gate ${getSettings().raid.gate ? 'on' : 'off'}: ${r.updated} channel(s), ${r.granted} member(s) got the Member role`;
  },
  async 'repost-panel'({ payload }, guild) {
    const result = await syncPanels(guild, [String(payload?.panel)]);
    if (/failed|unknown panel|no #/.test(result)) throw new Error(result);
    return result;
  },
};

async function runJob(client, job, now) {
  if (!job || typeof job.type !== 'string') return { ok: false, message: 'malformed job' };
  if (now - (job.at ?? 0) > MAX_AGE_MS) return { ok: false, message: 'expired (the bot was offline too long)' };
  // own properties only: "constructor" or "toString" coming from the shared store must not count as job types
  if (!Object.hasOwn(HANDLERS, job.type)) return { ok: false, message: `unknown job type "${job.type}"` };
  const handler = HANDLERS[job.type];
  const guild = client.guilds.cache.get(job.guildId) ?? client.guilds.cache.first();
  if (!guild) return { ok: false, message: 'the bot is not in that server' };
  try {
    return { ok: true, message: String(await handler(job, guild)) };
  } catch (e) {
    log(`job ${job.type} failed:`, e.message);
    return { ok: false, message: e.message };
  }
}

/** Takes up to ten queued jobs from the store and runs them, oldest first. Reports each result back. */
export async function processJobs(client, now = Date.now()) {
  let done = 0;
  for (; done < MAX_PER_TICK; done++) {
    const job = await runtime.kv.pop(KEYS.jobs);
    if (!job) break;
    const result = await runJob(client, job, now);
    await runtime.kv
      .push(KEYS.jobResults, { id: job?.id ?? null, type: typeof job?.type === 'string' ? job.type : null, at: now, ...result }, 50)
      .catch((e) => log('could not store a job result:', e.message));
  }
  return done;
}
