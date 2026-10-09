import { KEYS, kvFromEnv } from './shared/kv.js';
import { normalizeSettings } from './shared/settings.js';

/**
 * Process-wide state shared by every module: the key-value store (Upstash when configured, else a local file)
 * and the live dashboard settings. The scheduler refreshes the settings, so a change saved on the website
 * reaches the bot within about a minute.
 */
export const runtime = {
  kv: null,
  settings: normalizeSettings({}),
  listeners: new Set(),
  features: { members: false, content: false }, // which privileged intents Discord granted
  tempRooms: new Set(), // channel ids of temporary voice rooms (kept out of the logs)
};

const log = (...args) => console.log(new Date().toISOString(), ...args);

export function initRuntime(dataDir) {
  runtime.kv = kvFromEnv(process.env, { file: `${dataDir.replace(/[\\/]$/, '')}/kv.json` });
  log(`Settings store: ${runtime.kv.kind === 'upstash' ? 'Upstash Redis (shared with the website)' : 'local file (the website cannot see it)'}`);
  return runtime.kv;
}

export const getSettings = () => runtime.settings;

/** Calls `fn(settings)` whenever the settings actually change. Returns an unsubscribe function. */
export function onSettings(fn) {
  runtime.listeners.add(fn);
  return () => runtime.listeners.delete(fn);
}

function apply(next) {
  const changed = JSON.stringify(next) !== JSON.stringify(runtime.settings);
  runtime.settings = next;
  if (changed) {
    for (const fn of runtime.listeners) {
      try {
        fn(next);
      } catch (e) {
        log('settings listener failed:', e.message);
      }
    }
  }
  return changed;
}

/** Re-reads the settings from the store. If the store is unreachable the last known settings stay in force. */
export async function refreshSettings() {
  try {
    return apply(normalizeSettings(await runtime.kv.get(KEYS.settings)));
  } catch (e) {
    log('Could not refresh settings (keeping the current ones):', e.message);
    return false;
  }
}

export async function saveSettings(input) {
  const next = normalizeSettings(input);
  await runtime.kv.set(KEYS.settings, next);
  apply(next);
  return next;
}

/** One line in the dashboard's activity log. Never throws: logging must not break the action it describes. */
export async function audit(entry) {
  try {
    await runtime.kv.push(KEYS.audit, { at: Date.now(), source: 'bot', ...entry }, 300);
  } catch (e) {
    log('audit write failed:', e.message);
  }
}
