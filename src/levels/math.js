import { RANKS } from '../blueprint.js';

/** XP needed to go from `level` to `level + 1` (the classic 5n² + 50n + 100 curve). */
export const xpToNext = (level) => 5 * level * level + 50 * level + 100;

/** Total XP at which `level` is reached. */
export function totalXpForLevel(level) {
  let total = 0;
  for (let l = 0; l < level; l++) total += xpToNext(l);
  return total;
}

/** Level plus progress inside it: { level, current, needed }. */
export function levelFromXp(totalXp) {
  let remaining = Math.max(0, Math.floor(Number(totalXp) || 0));
  let level = 0;
  while (remaining >= xpToNext(level)) {
    remaining -= xpToNext(level);
    level++;
  }
  return { level, current: remaining, needed: xpToNext(level) };
}

/** Highest rank tier reached at this level, or null below the first tier. */
export function rankForLevel(level) {
  let best = null;
  for (const rank of RANKS) if (rank.level <= level) best = rank;
  return best;
}

/** The next tier above this level, or null at the top. */
export const nextRank = (level) => RANKS.find((r) => r.level > level) ?? null;

/** "▰▰▰▱▱▱▱▱▱▱" */
export function progressBar(current, needed, size = 10) {
  const filled = Math.min(size, Math.floor((current / needed) * size));
  return '▰'.repeat(filled) + '▱'.repeat(size - filled);
}

export const randomXp = (rng = Math.random) => 15 + Math.floor(rng() * 11); // 15..25
