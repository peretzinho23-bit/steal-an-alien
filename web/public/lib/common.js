import { get } from './api.js';
import { t } from './i18n.js';
import { h, toast } from './ui.js';

let guildPromise = null;
/** Channels and roles of the server, fetched once per page visit. */
export function guildData({ fresh = false } = {}) {
  if (fresh || !guildPromise) {
    guildPromise = get('/api/guild').catch((e) => {
      guildPromise = null;
      throw e;
    });
  }
  return guildPromise;
}

/** Waits (up to a minute) for the bot to report that it handled a queued job, then tells the person. */
export async function watchJob(id, doneLabel) {
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const { results } = await get('/api/jobs');
      const found = results.find((r) => r.id === id);
      if (found) {
        toast(found.ok ? `${doneLabel}: ${found.message}` : t('common.job.failed', { message: found.message }), found.ok ? 'ok' : 'error');
        return found;
      }
    } catch {
      return null;
    }
  }
  toast(t('common.job.timeout'), 'error');
  return null;
}

export const levelLabel = (level) => (level === 'admin' || level === 'staff' ? t(`common.level.${level}`) : null);

export function levelBadge(level) {
  const label = levelLabel(level);
  return label ? h('span', { class: `badge ${level === 'admin' ? 'badge-accent' : ''}`, text: label }) : null;
}

/** Channel types we can post in. */
export const isText = (c) => c.type === 0 || c.type === 5;

/** Options grouped by category, for a <select>. */
export function channelOptions(channels, { type = 'text', selected } = {}) {
  const wanted = type === 'text' ? (c) => c.type === 0 || c.type === 5 : type === 'voice' ? (c) => c.type === 2 || c.type === 13 : (c) => c.type === 4;
  const categories = channels.filter((c) => c.type === 4);
  const groups = [];
  const loose = channels.filter((c) => wanted(c) && !c.parentId);
  if (type === 'category') return categories.map((c) => h('option', { value: c.id, selected: c.id === selected, text: c.name }));
  if (loose.length) groups.push(h('optgroup', { label: t('common.category.none') }, loose.map((c) => h('option', { value: c.id, selected: c.id === selected, text: `#${c.name}` }))));
  for (const cat of categories) {
    const inside = channels.filter((c) => wanted(c) && c.parentId === cat.id);
    if (inside.length) groups.push(h('optgroup', { label: cat.name }, inside.map((c) => h('option', { value: c.id, selected: c.id === selected, text: `#${c.name}` }))));
  }
  return groups;
}

export const roleColor = (role) => (role.color ? `#${role.color.toString(16).padStart(6, '0')}` : null);
