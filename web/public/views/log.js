import { get } from '../lib/api.js';
import { clear, debounce, emptyState, h, put } from '../lib/ui.js';
import { actionLabel, activityItem } from './overview.js';

export async function render(main) {
  const { entries } = await get('/api/activity?limit=200');
  put(main, h('header', { class: 'page-head' }, h('h1', { class: 'page-title', text: 'יומן פעילות' }), h('p', { class: 'page-sub', text: 'כל מה שהצוות והבוט עשו: הכרזות, אזהרות, השתקות, שינויי הגדרות ועוד. מוצגות 200 הפעולות האחרונות.' })));

  let source = 'all';
  let query = '';
  const list = h('div', {});
  const search = h('input', { class: 'input', type: 'search', dir: 'auto', placeholder: 'חפש בפעולות', 'aria-label': 'חיפוש ביומן' });
  const filters = h(
    'div',
    { class: 'tabs', role: 'group', 'aria-label': 'מקור' },
    [['all', 'הכל'], ['web', 'האתר'], ['bot', 'הבוט']].map(([id, label]) => h('button', { class: 'tab', type: 'button', 'aria-selected': String(id === source), dataset: { id }, onClick: () => ((source = id), mark(), draw()) }, label)),
  );
  const mark = () => filters.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.id === source)));

  function draw() {
    const q = query.toLowerCase();
    const shown = entries.filter((e) => (source === 'all' || e.source === source) && (!q || `${actionLabel(e.action)} ${JSON.stringify(e)}`.toLowerCase().includes(q)));
    put(clear(list), shown.length ? h('ul', { class: 'list' }, shown.map(activityItem)) : emptyState('אין תוצאות', entries.length ? 'נסה מסנן או חיפוש אחר.' : 'עוד לא נרשמה פעילות. היומן צריך את האחסון המשותף (Redis) כדי לעבוד.'));
  }
  search.addEventListener('input', debounce(() => ((query = search.value.trim()), draw()), 200));

  put(main, h('div', { class: 'card stack' }, h('div', { class: 'row-wrap' }, search), filters, list));
  draw();
}
