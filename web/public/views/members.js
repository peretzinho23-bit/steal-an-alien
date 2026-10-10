import '../i18n/members.js';
import { get, post } from '../lib/api.js';
import { guildData, levelBadge } from '../lib/common.js';
import { t } from '../lib/i18n.js';
import { ago, busy, clear, confirmDialog, debounce, emptyState, fullTime, h, icon, modal, put, skeleton, toast } from '../lib/ui.js';

const FILTERS = ['all', 'staff', 'admins', 'bots', 'timeout', 'warned'];
const DURATIONS = [10, 60, 360, 1440, 10080];
const PAGE = 50;
/** How many Discord pages to scan in one click when a page comes back empty (a rare filter can skip a lot). */
const MAX_SCANS = 10;

const warnText = (n) => (n === 1 ? t('members.warnOne') : t('members.warnMany', { count: n }));
const isTimedOut = (m) => Boolean(m.timeoutUntil) && Date.parse(m.timeoutUntil) > Date.now();

export async function render(main, { me }) {
  put(main, h('header', { class: 'page-head' }, h('h1', { class: 'page-title', text: t('members.title') }), h('p', { class: 'page-sub', text: t('members.sub') })));

  const state = { filter: 'all', role: '', next: null, selected: null, seq: 0, searching: false };
  const detail = h('div', {});
  const list = h('ul', { class: 'list members-list' });
  const hint = h('div', {});
  const moreHost = h('div', { class: 'members-more' });
  const status = h('p', { class: 'muted small members-status', role: 'status', 'aria-live': 'polite' });
  const searchNote = h('p', { class: 'muted small', hidden: true, text: t('members.filtersPaused') });

  const input = h('input', { class: 'input', type: 'search', dir: 'auto', placeholder: t('members.searchPlaceholder'), 'aria-label': t('members.searchAria'), autocomplete: 'off' });
  const chips = FILTERS.map((id) =>
    h('button', { class: 'members-chip', type: 'button', 'aria-pressed': String(id === state.filter), dataset: { filter: id }, text: t(`members.filter.${id}`), onClick: () => setFilter(id) }),
  );
  const filterGroup = h('div', { class: 'members-filters', role: 'group', 'aria-label': t('members.filtersLabel') }, chips);
  const roleSelect = h('select', { class: 'input' }, h('option', { value: '', text: t('members.allRoles') }));
  roleSelect.addEventListener('change', () => {
    state.role = roleSelect.value;
    loadBrowse();
  });
  guildData()
    .then(({ roles }) => put(roleSelect, roles.map((r) => h('option', { value: r.id, text: r.name }))))
    .catch(() => {
      /* without the roles the role filter just offers "all roles" */
    });

  const warnedHost = h('div', {});
  const unbanId = h('input', { class: 'input', dir: 'ltr', inputmode: 'numeric', placeholder: t('members.unban.placeholder'), 'aria-label': t('members.unban.label') });

  const onSearch = debounce(async () => {
    const q = input.value.trim();
    if (!q) {
      if (state.searching) {
        state.searching = false;
        setFiltersEnabled(true);
        loadBrowse();
      }
      return;
    }
    state.searching = true;
    setFiltersEnabled(false);
    const token = ++state.seq;
    state.next = null;
    clear(moreHost);
    clear(list);
    if (q.length < 2) return put(clear(hint), h('p', { class: 'muted small', text: t('members.typeTwo') }));
    put(clear(hint), skeleton(2));
    try {
      const { members } = await get(`/api/members/search?q=${encodeURIComponent(q)}`);
      if (token !== state.seq) return;
      clear(hint);
      put(list, members.map(row));
      if (!members.length) put(hint, emptyState(t('members.noneFound'), t('members.noneFoundText')));
      status.textContent = t('members.shown', { count: members.length });
      markSelected(state.selected);
    } catch (e) {
      if (token === state.seq) put(clear(hint), h('p', { class: 'muted', dir: 'auto', text: e.message }));
    }
  }, 350);
  input.addEventListener('input', onSearch);

  put(
    main,
    h(
      'div',
      { class: 'split' },
      h(
        'div',
        { class: 'stack' },
        h(
          'section',
          { class: 'card stack' },
          h('label', { class: 'field' }, h('span', { class: 'field-label', text: t('members.searchLabel') }), input),
          searchNote,
          h('div', { class: 'members-toolbar' }, filterGroup, h('label', { class: 'field members-role-field' }, h('span', { class: 'field-label', text: t('members.roleLabel') }), roleSelect)),
          status,
          hint,
          list,
          moreHost,
        ),
        h('section', { class: 'card' }, h('h2', { class: 'card-title', text: t('members.warnedTitle') }), warnedHost),
        h(
          'section',
          { class: 'card stack' },
          h('h2', { class: 'card-title', text: t('members.unban.title') }),
          h('p', { class: 'card-sub', text: t('members.unban.sub') }),
          h('div', { class: 'row' }, unbanId, h('button', { class: 'btn btn-secondary', type: 'button', onClick: (e) => unban(e.currentTarget) }, t('members.unban.button'))),
        ),
      ),
      h('div', { class: 'preview-sticky' }, detail),
    ),
  );

  showEmpty();
  loadBrowse();
  loadWarned();

  function setFilter(id) {
    state.filter = id;
    chips.forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.filter === id)));
    loadBrowse();
  }

  function setFiltersEnabled(on) {
    chips.forEach((c) => (c.disabled = !on));
    roleSelect.disabled = !on;
    searchNote.hidden = on;
  }

  /** Browse mode: one page of the list, filtered and sorted by id. `more` appends the next page. */
  async function loadBrowse({ more = false } = {}) {
    const token = ++state.seq;
    if (!more) {
      state.next = null;
      clear(list);
      clear(moreHost);
    }
    put(clear(hint), more ? null : skeleton(4));
    let cursor = more ? state.next : null;
    const found = [];
    let page = { members: [], next: null };
    try {
      for (let scans = 0; scans < MAX_SCANS; scans++) {
        const params = new URLSearchParams({ filter: state.filter, limit: String(PAGE) });
        if (state.role) params.set('role', state.role);
        if (cursor) params.set('after', cursor);
        page = await get(`/api/members/list?${params}`);
        if (token !== state.seq) return;
        found.push(...page.members);
        if (found.length || !page.next) break;
        cursor = page.next;
      }
    } catch (e) {
      if (token !== state.seq) return;
      put(clear(hint), h('p', { class: 'muted', dir: 'auto', text: e.message }));
      return;
    }
    state.next = page.next;
    clear(hint);
    put(list, found.map(row));
    if (!list.children.length && !state.next) put(hint, emptyState(t('members.emptyTitle'), t('members.emptyText')));
    renderMore();
    status.textContent = t('members.shown', { count: list.children.length });
    markSelected(state.selected);
  }

  function renderMore() {
    clear(moreHost);
    if (state.next) moreHost.append(h('button', { class: 'btn btn-secondary', type: 'button', onClick: (e) => loadMore(e.currentTarget) }, t('members.loadMore')));
  }

  async function loadMore(button) {
    const first = list.children.length;
    await busy(button, t('members.loading'), () => loadBrowse({ more: true }));
    // the button is gone or replaced: keep keyboard users on the first new person
    if (document.activeElement === document.body || document.activeElement === null) list.children[first]?.querySelector('button')?.focus();
  }

  /** One person in the list. Clicking (or Enter on) the row opens the panel on the right. */
  function row(m) {
    const roles = m.roles ?? [];
    const warnings = m.warnCount > 0 ? h('span', { class: 'badge badge-warn' }, icon('alert', { size: 14 }), warnText(m.warnCount)) : null;
    const timed = isTimedOut(m) ? h('span', { class: 'badge badge-bad', text: t('members.timedOut') }) : null;
    return h(
      'li',
      { class: 'members-row' },
      h(
        'button',
        { class: 'members-person', type: 'button', dataset: { id: m.id }, 'aria-current': m.id === state.selected ? 'true' : null, onClick: () => open(m.id) },
        m.avatar ? h('img', { class: 'avatar', src: m.avatar, alt: '' }) : h('span', { class: 'avatar' }),
        h(
          'span',
          { class: 'members-person-main' },
          h('span', { class: 'item-title' }, h('bdi', { text: m.name })),
          h('span', { class: 'muted small' }, h('bdi', { dir: 'ltr', text: `@${m.username}` }), m.bot ? ` · ${t('members.bot')}` : ''),
          roles.length
            ? h(
                'span',
                { class: 'members-roles' },
                roles.slice(0, 3).map((r) => h('span', { class: 'members-role' }, h('bdi', { text: r.name }))),
                roles.length > 3 ? h('span', { class: 'members-role', text: `+${roles.length - 3}` }) : null,
              )
            : null,
          m.joinedAt ? h('span', { class: 'muted small', text: t('members.joined', { when: ago(Date.parse(m.joinedAt)) }) }) : null,
        ),
        h('span', { class: 'members-badges' }, levelBadge(m.level), warnings, timed),
      ),
    );
  }

  function markSelected(id) {
    state.selected = id ?? null;
    list.querySelectorAll('.members-person').forEach((b) => (state.selected && b.dataset.id === state.selected ? b.setAttribute('aria-current', 'true') : b.removeAttribute('aria-current')));
  }

  /** Replaces one row after an action, so its badges match the person's new state. Keeps keyboard focus on it. */
  function refreshRow(member, warnCount) {
    const old = [...list.querySelectorAll('.members-person')].find((b) => b.dataset.id === member.id)?.closest('li');
    if (!old) return;
    const focused = old.contains(document.activeElement);
    const fresh = row({ ...member, warnCount });
    old.replaceWith(fresh);
    if (focused) fresh.querySelector('button')?.focus({ preventScroll: true });
  }

  function showEmpty() {
    put(clear(detail), h('div', { class: 'card' }, emptyState(t('members.pickTitle'), t('members.pickText'))));
  }

  async function loadWarned() {
    try {
      const { users } = await get('/api/members/warned');
      put(
        clear(warnedHost),
        users.length
          ? h(
              'ul',
              { class: 'list' },
              users.map((u) =>
                h(
                  'li',
                  {},
                  u.avatar ? h('img', { class: 'avatar', src: u.avatar, alt: '' }) : h('span', { class: 'avatar' }),
                  h(
                    'div',
                    { class: 'item-main' },
                    h('div', { class: 'item-title', dir: 'auto', text: u.name ?? t('members.unnamed', { id: u.id }) }),
                    h('div', { class: 'muted small', text: [warnText(u.count), u.inServer ? null : t('members.leftServer')].filter(Boolean).join(' · ') }),
                  ),
                  u.inServer ? h('button', { class: 'btn btn-secondary btn-sm', type: 'button', onClick: () => open(u.id) }, t('members.open')) : null,
                ),
              ),
            )
          : h('p', { class: 'muted', text: t('members.warnedEmpty') }),
      );
    } catch (e) {
      put(clear(warnedHost), h('p', { class: 'muted', dir: 'auto', text: e.message }));
    }
  }

  async function open(id) {
    markSelected(id);
    put(clear(detail), h('div', { class: 'card' }, skeleton(5)));
    try {
      const { member, warns } = await get(`/api/members/${id}`);
      drawDetail(member, warns);
      refreshRow(member, warns.length);
    } catch (e) {
      put(clear(detail), h('div', { class: 'card' }, h('p', { class: 'muted', dir: 'auto', text: e.message })));
    }
  }

  function drawDetail(m, warns) {
    const locked = m.level === 'admin' || (m.level === 'staff' && me.level !== 'admin') || m.id === me.user.id || m.bot;
    const act = (fn) => async (e) => {
      try {
        await busy(e.currentTarget, t('members.busy'), fn);
        await open(m.id);
        loadWarned();
      } catch (err) {
        toast(err.message, 'error');
      }
    };
    const info = [m.joinedAt ? t('members.joined', { when: ago(Date.parse(m.joinedAt)) }) : null, isTimedOut(m) ? t('members.mutedUntil', { time: fullTime(Date.parse(m.timeoutUntil)) }) : null].filter(Boolean).join(' · ');
    const lockedText = m.id === me.user.id ? t('members.lockedSelf') : m.bot ? t('members.lockedBot') : t('members.lockedStaff');
    put(
      clear(detail),
      h(
        'div',
        { class: 'card stack' },
        h(
          'div',
          { class: 'row' },
          m.avatar ? h('img', { class: 'avatar', src: m.avatar, alt: '' }) : h('span', { class: 'avatar' }),
          h('div', { class: 'item-main' }, h('div', { class: 'item-title' }, h('bdi', { text: m.name })), h('div', { class: 'muted small' }, h('bdi', { dir: 'ltr', text: `@${m.username}` }), m.bot ? ` · ${t('members.bot')}` : '')),
          levelBadge(m.level),
        ),
        h('div', { class: 'chips' }, m.roles.length ? m.roles.map((r) => h('span', { class: 'chip chip-static' }, h('bdi', { text: r.name }))) : h('span', { class: 'muted small', text: t('members.noRoles') })),
        info ? h('p', { class: 'muted small', text: info }) : null,
        locked ? h('div', { class: 'banner', role: 'status' }, icon('alert'), h('p', { text: lockedText })) : null,
        h(
          'div',
          { class: 'row-wrap' },
          h('button', { class: 'btn btn-secondary', type: 'button', disabled: locked, onClick: act(() => warnDialog(m)) }, t('members.action.warn')),
          h('button', { class: 'btn btn-secondary', type: 'button', disabled: locked, onClick: act(() => timeoutDialog(m)) }, t('members.action.timeout')),
          isTimedOut(m) ? h('button', { class: 'btn btn-secondary', type: 'button', disabled: locked, onClick: act(async () => (await post('/api/mod/untimeout', { userId: m.id }), toast(t('members.timeoutRemoved')))) }, t('members.action.untimeout')) : null,
          h('button', { class: 'btn btn-danger', type: 'button', disabled: locked, onClick: act(() => kickDialog(m)) }, t('members.action.kick')),
          h('button', { class: 'btn btn-danger', type: 'button', disabled: locked, onClick: act(() => banDialog(m)) }, t('members.action.ban')),
        ),
      ),
      h(
        'div',
        { class: 'card' },
        h('h2', { class: 'card-title', text: t('members.warnsTitle', { count: warns.length }) }),
        warns.length
          ? h(
              'ul',
              { class: 'list' },
              warns
                .slice()
                .reverse()
                .map((w) =>
                  h(
                    'li',
                    {},
                    h('div', { class: 'item-main' }, h('div', { dir: 'auto', text: w.reason }), h('div', { class: 'muted small' }, `${w.by?.name ?? t('members.unknown')} · `, h('time', { title: fullTime(w.at), text: ago(w.at) }))),
                    h(
                      'button',
                      { class: 'btn btn-ghost btn-sm', type: 'button', 'aria-label': t('members.removeWarn'), disabled: m.level === 'admin', onClick: act(async () => (await post('/api/mod/unwarn', { userId: m.id, warnId: w.id }), toast(t('members.warnRemoved')))) },
                      icon('trash', { size: 16 }),
                    ),
                  ),
                ),
            )
          : h('p', { class: 'muted', text: t('members.noWarns') }),
      ),
    );
  }

  async function reasonDialog({ title, text, confirmLabel, danger, extra, required }) {
    return modal(
      (close) => {
        const reason = h('textarea', { class: 'input', dir: 'auto', maxlength: '400', 'aria-label': t('members.reasonLabel'), placeholder: required ? t('members.reasonRequired') : t('members.reasonOptional') });
        const ok = h('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, type: 'button', disabled: Boolean(required), onClick: () => close({ reason: reason.value.trim(), ...(extra?.read?.() ?? {}) }) }, confirmLabel);
        if (required) reason.addEventListener('input', () => (ok.disabled = reason.value.trim().length < 3));
        return h(
          'div',
          { class: 'dlg-body' },
          h('h2', { class: 'dlg-title', text: title }),
          text ? h('p', { class: 'dlg-text', dir: 'auto', text }) : null,
          extra?.node ?? null,
          h('label', { class: 'field' }, h('span', { class: 'field-label', text: t('members.reasonLabel') }), reason),
          h('div', { class: 'dlg-actions' }, ok, h('button', { class: 'btn btn-ghost', type: 'button', onClick: () => close(null) }, t('ui.cancel'))),
        );
      },
      { label: title },
    );
  }

  async function warnDialog(m) {
    const r = await reasonDialog({ title: t('members.dialog.warnTitle', { name: m.name }), text: t('members.dialog.warnText'), confirmLabel: t('members.dialog.warnConfirm'), required: true });
    if (!r) return;
    const res = await post('/api/mod/warn', { userId: m.id, reason: r.reason });
    toast(res.outcome ? t('members.dialog.warnSentAuto', { count: res.count, outcome: res.outcome }) : t('members.dialog.warnSent', { count: res.count }));
  }

  async function timeoutDialog(m) {
    const select = h('select', { class: 'input', 'aria-label': t('members.dialog.duration') }, DURATIONS.map((v) => h('option', { value: v, text: t(`members.duration.${v}`) })));
    const r = await reasonDialog({
      title: t('members.dialog.timeoutTitle', { name: m.name }),
      confirmLabel: t('members.dialog.timeoutConfirm'),
      extra: { node: h('label', { class: 'field' }, h('span', { class: 'field-label', text: t('members.dialog.duration') }), select), read: () => ({ minutes: Number(select.value) }) },
    });
    if (!r) return;
    await post('/api/mod/timeout', { userId: m.id, minutes: r.minutes, reason: r.reason || undefined });
    toast(t('members.dialog.timedOut'));
  }

  async function kickDialog(m) {
    const r = await reasonDialog({ title: t('members.dialog.kickTitle', { name: m.name }), text: t('members.dialog.kickText'), confirmLabel: t('members.dialog.kickConfirm'), danger: true });
    if (!r) return;
    await post('/api/mod/kick', { userId: m.id, reason: r.reason || undefined });
    toast(t('members.dialog.kicked'));
  }

  async function banDialog(m) {
    const days = h('select', { class: 'input', 'aria-label': t('members.dialog.deleteAria') }, [
      [0, 'members.dialog.delete0'],
      [1, 'members.dialog.delete1'],
      [7, 'members.dialog.delete7'],
    ].map(([v, key]) => h('option', { value: v, text: t(key) })));
    const r = await reasonDialog({
      title: t('members.dialog.banTitle', { name: m.name }),
      text: t('members.dialog.banText'),
      confirmLabel: t('members.dialog.banConfirm'),
      danger: true,
      extra: { node: h('label', { class: 'field' }, h('span', { class: 'field-label', text: t('members.dialog.deleteLabel') }), days), read: () => ({ deleteDays: Number(days.value) }) },
    });
    if (!r) return;
    await post('/api/mod/ban', { userId: m.id, reason: r.reason || undefined, deleteDays: r.deleteDays });
    toast(t('members.dialog.banned'));
  }

  async function unban(button) {
    const id = unbanId.value.trim();
    if (!/^\d{15,25}$/.test(id)) return toast(t('members.unban.badId'), 'error');
    if (!(await confirmDialog({ title: t('members.unban.confirmTitle'), body: t('members.unban.confirmBody', { id }), confirmLabel: t('members.unban.button') }))) return;
    await busy(button, t('members.busy'), async () => {
      try {
        await post('/api/mod/unban', { userId: id });
        toast(t('members.unban.done'));
        unbanId.value = '';
      } catch (e) {
        toast(e.message, 'error');
      }
    });
  }
}
