import '../i18n/log.js';
import { get } from '../lib/api.js';
import { t } from '../lib/i18n.js';
import { clear, debounce, emptyState, h, put } from '../lib/ui.js';
import { actionLabel, activityItem } from './overview.js';

const LIMIT = 200;

export async function render(main) {
  const { entries } = await get(`/api/activity?limit=${LIMIT}`);
  put(main, h('header', { class: 'page-head' }, h('h1', { class: 'page-title', text: t('log.title') }), h('p', { class: 'page-sub', text: t('log.sub', { count: LIMIT }) })));

  let source = 'all';
  let query = '';
  const list = h('div', {});
  const search = h('input', { class: 'input', type: 'search', dir: 'auto', placeholder: t('log.searchPlaceholder'), 'aria-label': t('log.searchAria') });
  const filters = h(
    'div',
    { class: 'tabs', role: 'group', 'aria-label': t('log.source') },
    ['all', 'web', 'bot'].map((id) => h('button', { class: 'tab', type: 'button', 'aria-selected': String(id === source), dataset: { id }, onClick: () => ((source = id), mark(), draw()) }, t(`log.${id}`))),
  );
  const mark = () => filters.querySelectorAll('.tab').forEach((tab) => tab.setAttribute('aria-selected', String(tab.dataset.id === source)));

  function draw() {
    const q = query.toLowerCase();
    const shown = entries.filter((e) => (source === 'all' || e.source === source) && (!q || `${actionLabel(e.action)} ${JSON.stringify(e)}`.toLowerCase().includes(q)));
    put(clear(list), shown.length ? h('ul', { class: 'list' }, shown.map(activityItem)) : emptyState(t('log.noResults'), entries.length ? t('log.noResultsText') : t('log.emptyText')));
  }
  search.addEventListener('input', debounce(() => ((query = search.value.trim()), draw()), 200));

  put(main, h('div', { class: 'card stack' }, h('div', { class: 'row-wrap' }, search), filters, list));
  draw();
}
