import '../i18n/ranks.js';
import { get } from '../lib/api.js';
import { locale, t } from '../lib/i18n.js';
import { ago, emptyState, fullTime, h, put } from '../lib/ui.js';

export async function render(main) {
  const { entries, at } = await get('/api/leaderboard');
  put(main, h('header', { class: 'page-head' }, h('h1', { class: 'page-title', text: t('ranks.title') }), h('p', { class: 'page-sub', text: at ? t('ranks.updated', { when: ago(at) }) : t('ranks.sub') })));

  if (!entries?.length) {
    put(main, h('div', { class: 'card' }, emptyState(t('ranks.emptyTitle'), t('ranks.emptyText'))));
    return;
  }

  put(
    main,
    h(
      'section',
      { class: 'card' },
      h(
        'ol',
        { class: 'list', style: undefined },
        entries.map((e, i) => {
          const pct = e.needed ? Math.min(100, Math.round((e.current / e.needed) * 100)) : 0;
          const bar = h('div', { class: 'xp-bar', role: 'img', 'aria-label': t('ranks.toNext', { pct }) }, h('span', {}));
          bar.firstChild.style.setProperty('--w', `${pct}%`);
          return h(
            'li',
            { class: 'rank-row' },
            h('span', { class: `rank-n ${i < 3 ? 'top' : ''}`, text: i < 3 ? ['🥇', '🥈', '🥉'][i] : String(i + 1) }),
            e.avatar ? h('img', { class: 'avatar', src: e.avatar, alt: '' }) : h('span', { class: 'avatar' }),
            h('div', {}, h('div', { class: 'item-title' }, h('bdi', { text: e.name ?? t('ranks.unnamed', { id: e.id }) }), e.rank ? h('span', { class: 'badge badge-accent', text: e.rank, style: undefined }) : null), bar),
            h('div', { class: 'muted small', title: fullTime(at) }, h('strong', { text: t('ranks.level', { level: e.level }) }), h('div', { text: t('ranks.xp', { xp: e.xp.toLocaleString(locale()) }) })),
          );
        }),
      ),
    ),
  );
}
