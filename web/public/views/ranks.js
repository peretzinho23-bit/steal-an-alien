import { get } from '../lib/api.js';
import { ago, emptyState, fullTime, h, put } from '../lib/ui.js';

export async function render(main) {
  const { entries, at } = await get('/api/leaderboard');
  put(main, h('header', { class: 'page-head' }, h('h1', { class: 'page-title', text: 'דרגות' }), h('p', { class: 'page-sub' }, at ? `הטבלה מתעדכנת מהבוט כל כמה דקות. עודכנה ${ago(at)}.` : 'הטבלה מתעדכנת מהבוט כל כמה דקות.')));

  if (!entries?.length) {
    put(main, h('div', { class: 'card' }, emptyState('אין עדיין נתונים', 'כשהחברים יתחילו לכתוב ולהיות בערוצי קול הם יצברו XP, והטבלה תופיע כאן. אם הבוט כבר רץ, חכה כמה דקות.')));
    return;
  }

  put(main, 
    h(
      'section',
      { class: 'card' },
      h(
        'ol',
        { class: 'list', style: undefined },
        entries.map((e, i) => {
          const pct = e.needed ? Math.min(100, Math.round((e.current / e.needed) * 100)) : 0;
          const bar = h('div', { class: 'xp-bar', role: 'img', 'aria-label': `${pct}% עד הרמה הבאה` }, h('span', {}));
          bar.firstChild.style.setProperty('--w', `${pct}%`);
          return h(
            'li',
            { class: 'rank-row' },
            h('span', { class: `rank-n ${i < 3 ? 'top' : ''}`, text: i < 3 ? ['🥇', '🥈', '🥉'][i] : String(i + 1) }),
            e.avatar ? h('img', { class: 'avatar', src: e.avatar, alt: '' }) : h('span', { class: 'avatar' }),
            h('div', {}, h('div', { class: 'item-title' }, h('bdi', { text: e.name ?? `מזהה ${e.id}` }), e.rank ? h('span', { class: 'badge badge-accent', text: e.rank, style: undefined }) : null), bar),
            h('div', { class: 'muted small', title: fullTime(at) }, h('strong', { text: `רמה ${e.level}` }), h('div', { text: `${e.xp.toLocaleString('he-IL')} XP` })),
          );
        }),
      ),
    ),
  );
}
