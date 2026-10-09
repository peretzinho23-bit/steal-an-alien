import { checkLockdownExpiry } from './lockdown.js';
import { KEYS } from './shared/kv.js';
import { refreshSettings, runtime } from './runtime.js';
import { processTempBans } from './warns.js';

const log = (...args) => console.log(new Date().toISOString(), ...args);

/**
 * Background jobs on fixed intervals. A task never overlaps itself and one failing task never stops the others.
 * Intervals are chosen to stay well inside Upstash's free request budget.
 */
export function startScheduler(client, extraTasks = []) {
  const tasks = [
    { name: 'settings', every: 60_000, run: () => refreshSettings() },
    { name: 'tempbans', every: 60_000, run: () => processTempBans(client) },
    { name: 'lockdown', every: 30_000, run: () => checkLockdownExpiry(client) },
    { name: 'heartbeat', every: 120_000, run: () => runtime.kv.set(KEYS.heartbeat, { at: Date.now(), guilds: client.guilds.cache.size, ping: Math.round(client.ws.ping) }) },
    ...extraTasks,
  ];
  const timers = tasks.map((task) => {
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        await task.run();
      } catch (e) {
        log(`task "${task.name}" failed:`, e.message);
      } finally {
        running = false;
      }
    };
    const timer = setInterval(tick, task.every);
    timer.unref?.();
    tick();
    return timer;
  });
  return () => timers.forEach(clearInterval);
}
