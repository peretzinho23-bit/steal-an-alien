import { h } from './ui.js';

/**
 * Discord-style markdown rendered to DOM nodes for the live preview. Never uses innerHTML: every piece of text
 * becomes a text node, links only for http(s), so whatever is typed cannot inject markup.
 */

const INLINE = new RegExp(
  [
    '`([^`\\n]+)`', //                 1 code
    '\\*\\*([\\s\\S]+?)\\*\\*', //     2 bold
    '__([\\s\\S]+?)__', //             3 underline
    '~~([\\s\\S]+?)~~', //             4 strike
    '\\*([^*\\n]+)\\*', //             5 italic
    '(?<![A-Za-z0-9])_([^_\\n]+)_(?![A-Za-z0-9])', // 6 italic with underscores
    '<@&(\\d+)>', //                   7 role mention
    '<#(\\d+)>', //                    8 channel mention
    '<@!?(\\d+)>', //                  9 user mention
    '(@everyone|@here)', //           10 mass mention
    '(https?:\\/\\/[^\\s<]+)', //      11 link
  ].join('|'),
  'g',
);

function inline(text, ctx) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1] !== undefined) out.push(h('code', { text: m[1] }));
    else if (m[2] !== undefined) out.push(h('strong', {}, inline(m[2], ctx)));
    else if (m[3] !== undefined) out.push(h('u', {}, inline(m[3], ctx)));
    else if (m[4] !== undefined) out.push(h('s', {}, inline(m[4], ctx)));
    else if (m[5] !== undefined || m[6] !== undefined) out.push(h('em', {}, inline(m[5] ?? m[6], ctx)));
    else if (m[7] !== undefined) out.push(h('span', { class: 'discord-mention', text: `@${ctx.roles?.find((r) => r.id === m[7])?.name ?? 'role'}` }));
    else if (m[8] !== undefined) out.push(h('span', { class: 'discord-mention', text: `#${ctx.channels?.find((c) => c.id === m[8])?.name ?? 'channel'}` }));
    else if (m[9] !== undefined) out.push(h('span', { class: 'discord-mention', text: '@member' }));
    else if (m[10] !== undefined) out.push(h('span', { class: 'discord-mention', text: m[10] }));
    else if (m[11] !== undefined) out.push(h('a', { href: m[11], target: '_blank', rel: 'noopener noreferrer', text: m[11] }));
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** @returns DocumentFragment */
export function renderMarkdown(text, ctx = {}) {
  const frag = document.createDocumentFragment();
  let last = 0;
  for (const m of text.matchAll(/```(?:[a-z]+\n)?([\s\S]*?)```/gi)) {
    if (m.index > last) frag.append(...inline(text.slice(last, m.index), ctx));
    frag.append(h('pre', { text: m[1].replace(/\n$/, '') }));
    last = m.index + m[0].length;
  }
  if (last < text.length) frag.append(...inline(text.slice(last), ctx));
  return frag;
}
