import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const SAVE_DELAY_MS = 2000;

/**
 * XP storage in one JSON file: { [guildId]: { [userId]: { xp, messages } } }.
 * Writes are debounced and atomic (temp file + rename), so a crash never leaves half a file.
 */
export class LevelStore {
  constructor(file) {
    this.file = file;
    this.data = {};
    this.timer = null;
    this.#load();
  }

  #load() {
    if (!existsSync(this.file)) return;
    try {
      this.data = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch (e) {
      // Never overwrite a file we could not read: move it aside so the XP can still be recovered.
      const aside = `${this.file}.corrupt-${Date.now()}`;
      renameSync(this.file, aside);
      console.error(`levels file was unreadable (${e.message}); moved to ${aside}`);
      this.data = {};
    }
  }

  #entry(guildId, userId) {
    const guild = (this.data[guildId] ??= {});
    return (guild[userId] ??= { xp: 0, messages: 0 });
  }

  get(guildId, userId) {
    return { ...(this.data[guildId]?.[userId] ?? { xp: 0, messages: 0 }) };
  }

  /** Adds (or removes, if negative) XP and returns the new total. XP never goes below 0. */
  add(guildId, userId, amount, { message = false } = {}) {
    const entry = this.#entry(guildId, userId);
    entry.xp = Math.max(0, entry.xp + Math.trunc(amount));
    if (message) entry.messages++;
    this.#scheduleSave();
    return entry.xp;
  }

  set(guildId, userId, xp) {
    this.#entry(guildId, userId).xp = Math.max(0, Math.trunc(xp));
    this.#scheduleSave();
  }

  reset(guildId, userId) {
    delete this.data[guildId]?.[userId];
    this.#scheduleSave();
  }

  /** [[userId, {xp, messages}], ...] best first, members with 0 XP left out. */
  ranking(guildId) {
    return Object.entries(this.data[guildId] ?? {})
      .filter(([, e]) => e.xp > 0)
      .sort((a, b) => b[1].xp - a[1].xp);
  }

  /** 1-based place in the server, or null with no XP. */
  position(guildId, userId) {
    const index = this.ranking(guildId).findIndex(([id]) => id === userId);
    return index === -1 ? null : index + 1;
  }

  #scheduleSave() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
    this.timer.unref?.();
  }

  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data), 'utf8');
    renameSync(tmp, this.file);
  }
}
