import { renderMarkdown } from './markdown.js';
import { h } from './ui.js';

/** Builds the Discord-looking preview of a message. `msg` is the same shape the composer keeps in its state. */
export function buildPreview(msg, { botName, roles, channels }) {
  const ctx = { roles, channels };
  const mentions = [msg.pingEveryone ? '@everyone' : null, ...msg.pingRoleIds.map((id) => `<@&${id}>`)].filter(Boolean).join(' ');
  const text = [mentions, msg.text].filter(Boolean).join('\n');
  const e = msg.useEmbed ? msg : null;
  const hasEmbed = e && (e.title || e.description || e.image || e.thumbnail || e.fields.some((f) => f.name && f.value));

  const embed = hasEmbed
    ? h(
        'div',
        { class: 'discord-embed', style: undefined, dataset: {} },
        h(
          'div',
          { class: 'discord-embed-top' },
          h('div', {}, e.title ? h('div', { class: 'discord-embed-title', dir: 'auto', text: e.title }) : null, e.description ? h('div', { class: 'discord-embed-desc', dir: 'auto' }, renderMarkdown(e.description, ctx)) : null),
          e.thumbnail ? h('img', { class: 'discord-thumb', src: e.thumbnail, alt: '', referrerpolicy: 'no-referrer' }) : null,
        ),
        e.fields.some((f) => f.name && f.value)
          ? h('div', { class: 'discord-fields' }, e.fields.filter((f) => f.name && f.value).map((f) => h('div', {}, h('div', { class: 'discord-field-name', dir: 'auto', text: f.name }), h('div', { class: 'discord-field-value', dir: 'auto' }, renderMarkdown(f.value, ctx)))))
          : null,
        e.image ? h('img', { class: 'discord-image', src: e.image, alt: '', referrerpolicy: 'no-referrer' }) : null,
        e.footer || e.timestamp ? h('div', { class: 'discord-footer', dir: 'auto', text: [e.footer, e.timestamp ? new Date().toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' }) : null].filter(Boolean).join(' • ') }) : null,
      )
    : null;
  if (embed) embed.style.setProperty('--embed-color', e.color || '#5b3df5');

  const empty = !text && !embed;
  return h(
    'div',
    { class: 'discord', role: 'img', 'aria-label': 'תצוגה מקדימה של ההודעה בדיסקורד' },
    h('div', { class: 'beam' }),
    h(
      'div',
      { class: 'discord-msg' },
      h('div', { class: 'discord-avatar' }, h('img', { src: '/favicon.svg', alt: '' })),
      h(
        'div',
        { class: 'discord-body' },
        h('div', { class: 'discord-head' }, h('span', { class: 'discord-name', text: botName }), h('span', { class: 'discord-tag', text: 'APP' }), h('span', { class: 'discord-time', text: 'היום' })),
        empty ? h('div', { class: 'discord-placeholder', text: 'כאן תראה איך ההודעה תיראה בדיסקורד...' }) : null,
        text ? h('div', { class: 'discord-text', dir: 'auto' }, renderMarkdown(text, ctx)) : null,
        embed,
      ),
    ),
  );
}
