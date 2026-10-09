import { get, post } from '../lib/api.js';
import { levelBadge } from '../lib/common.js';
import { ago, busy, clear, confirmDialog, debounce, emptyState, fullTime, h, icon, modal, put, skeleton, toast } from '../lib/ui.js';

const DURATIONS = [
  [10, '10 דקות'],
  [60, 'שעה'],
  [360, '6 שעות'],
  [1440, 'יום'],
  [10080, 'שבוע'],
];

export async function render(main, { me }) {
  put(main, h('header', { class: 'page-head' }, h('h1', { class: 'page-title', text: 'חברים' }), h('p', { class: 'page-sub', text: 'חפש חבר לפי שם, תראה את האזהרות שלו ותפעיל מודעות: אזהרה, השתקה, הרחקה או חסימה. כל פעולה נרשמת ביומן וב-mod-log.' })));

  const results = h('div', { class: 'stack' });
  const detail = h('div', {});
  const input = h('input', { class: 'input', type: 'search', dir: 'auto', placeholder: 'חפש לפי שם משתמש או כינוי', 'aria-label': 'חיפוש חבר', autocomplete: 'off' });
  const search = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 2) return put(clear(results), h('p', { class: 'muted small', text: 'הקלד לפחות שתי אותיות.' }));
    put(clear(results), skeleton(2));
    try {
      const { members } = await get(`/api/members/search?q=${encodeURIComponent(q)}`);
      put(clear(results), members.length ? h('ul', { class: 'list' }, members.map((m) => memberRow(m, () => open(m.id)))) : emptyState('לא נמצא אף אחד', 'נסה חלק אחר מהשם. החיפוש מחפש בתחילת השם.'));
    } catch (e) {
      put(clear(results), h('p', { class: 'muted', dir: 'auto', text: e.message }));
    }
  }, 350);
  input.addEventListener('input', search);

  const warnedHost = h('div', {});
  const unbanId = h('input', { class: 'input', dir: 'ltr', inputmode: 'numeric', placeholder: 'מזהה המשתמש', 'aria-label': 'מזהה משתמש להסרת חסימה' });

  put(main, 
    h(
      'div',
      { class: 'split' },
      h('div', { class: 'stack' }, h('div', { class: 'card stack' }, h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'חיפוש' }), input), results), h('section', { class: 'card' }, h('h2', { class: 'card-title', text: 'מוזהרים' }), warnedHost), h('section', { class: 'card stack' }, h('h2', { class: 'card-title', text: 'הסרת חסימה' }), h('p', { class: 'card-sub', text: 'חסומים כבר לא מופיעים בחיפוש. כדי להסיר חסימה צריך את המזהה שלהם (Developer Mode בדיסקורד ← קליק ימני ← העתק מזהה).' }), h('div', { class: 'row' }, unbanId, h('button', { class: 'btn btn-secondary', type: 'button', onClick: (e) => unban(e.currentTarget) }, 'הסר חסימה')))),
      h('div', { class: 'preview-sticky' }, detail),
    ),
  );
  showEmpty();
  loadWarned();

  function showEmpty() {
    put(clear(detail), h('div', { class: 'card' }, emptyState('בחר חבר', 'התוצאות יופיעו כאן עם האזהרות והפעולות.')));
  }

  async function loadWarned() {
    try {
      const { users } = await get('/api/members/warned');
      put(clear(warnedHost), users.length ? h('ul', { class: 'list' }, users.map((u) => h('li', {}, u.avatar ? h('img', { class: 'avatar', src: u.avatar, alt: '' }) : h('span', { class: 'avatar' }), h('div', { class: 'item-main' }, h('div', { class: 'item-title', dir: 'auto', text: u.name ?? `מזהה ${u.id}` }), h('div', { class: 'muted small', text: `${u.count} אזהרות${u.inServer ? '' : ' · עזב את השרת'}` })), u.inServer ? h('button', { class: 'btn btn-secondary btn-sm', type: 'button', onClick: () => open(u.id) }, 'פתח') : null))) : h('p', { class: 'muted', text: 'אין חברים עם אזהרות.' }));
    } catch (e) {
      put(clear(warnedHost), h('p', { class: 'muted', dir: 'auto', text: e.message }));
    }
  }

  async function open(id) {
    put(clear(detail), h('div', { class: 'card' }, skeleton(5)));
    try {
      const { member, warns } = await get(`/api/members/${id}`);
      drawDetail(member, warns);
    } catch (e) {
      put(clear(detail), h('div', { class: 'card' }, h('p', { class: 'muted', dir: 'auto', text: e.message })));
    }
  }

  function drawDetail(m, warns) {
    const locked = m.level === 'admin' || (m.level === 'staff' && me.level !== 'admin') || m.id === me.user.id || m.bot;
    const act = (fn) => async (e) => {
      try {
        await busy(e.currentTarget, 'רגע...', fn);
        await open(m.id);
        loadWarned();
      } catch (err) {
        toast(err.message, 'error');
      }
    };
    put(clear(detail), 
      h(
        'div',
        { class: 'card stack' },
        h('div', { class: 'row' }, m.avatar ? h('img', { class: 'avatar', src: m.avatar, alt: '' }) : h('span', { class: 'avatar' }), h('div', { class: 'item-main' }, h('div', { class: 'item-title' }, h('bdi', { text: m.name })), h('div', { class: 'muted small' }, h('bdi', { dir: 'ltr', text: `@${m.username}` }), m.bot ? ' · בוט' : '')), levelBadge(m.level)),
        h('div', { class: 'chips' }, m.roles.length ? m.roles.map((r) => h('span', { class: 'chip chip-static' }, h('bdi', { text: r.name }))) : h('span', { class: 'muted small', text: 'בלי רולים' })),
        h('p', { class: 'muted small' }, m.joinedAt ? `הצטרף ${ago(Date.parse(m.joinedAt))}` : '', m.timeoutUntil && Date.parse(m.timeoutUntil) > Date.now() ? ` · מושתק עד ${fullTime(Date.parse(m.timeoutUntil))}` : ''),
        locked ? h('div', { class: 'banner', role: 'status' }, icon('alert'), h('p', { text: m.id === me.user.id ? 'זה אתה.' : m.bot ? 'זה בוט.' : 'אי אפשר לפעול על אדמינים (או על צוות, אם אתה לא אדמין) מהאתר.' })) : null,
        h(
          'div',
          { class: 'row-wrap' },
          h('button', { class: 'btn btn-secondary', type: 'button', disabled: locked, onClick: act(() => warnDialog(m)) }, 'אזהרה'),
          h('button', { class: 'btn btn-secondary', type: 'button', disabled: locked, onClick: act(() => timeoutDialog(m)) }, 'השתקה'),
          m.timeoutUntil && Date.parse(m.timeoutUntil) > Date.now() ? h('button', { class: 'btn btn-secondary', type: 'button', disabled: locked, onClick: act(async () => (await post('/api/mod/untimeout', { userId: m.id }), toast('ההשתקה הוסרה.'))) }, 'הסר השתקה') : null,
          h('button', { class: 'btn btn-danger', type: 'button', disabled: locked, onClick: act(() => kickDialog(m)) }, 'הרחקה'),
          h('button', { class: 'btn btn-danger', type: 'button', disabled: locked, onClick: act(() => banDialog(m)) }, 'חסימה'),
        ),
      ),
      h(
        'div',
        { class: 'card' },
        h('h2', { class: 'card-title', text: `אזהרות (${warns.length})` }),
        warns.length
          ? h('ul', { class: 'list' }, warns.slice().reverse().map((w) => h('li', {}, h('div', { class: 'item-main' }, h('div', { dir: 'auto', text: w.reason }), h('div', { class: 'muted small' }, `${w.by?.name ?? 'לא ידוע'} · `, h('time', { title: fullTime(w.at), text: ago(w.at) }))), h('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'aria-label': 'הסר אזהרה', disabled: m.level === 'admin', onClick: act(async () => (await post('/api/mod/unwarn', { userId: m.id, warnId: w.id }), toast('האזהרה הוסרה.'))) }, icon('trash', { size: 16 })))))
          : h('p', { class: 'muted', text: 'אין אזהרות.' }),
      ),
    );
  }

  async function reasonDialog({ title, text, confirmLabel, danger, extra, required }) {
    return modal(
      (close) => {
        const reason = h('textarea', { class: 'input', dir: 'auto', maxlength: '400', 'aria-label': 'סיבה', placeholder: required ? 'סיבה (חובה)' : 'סיבה (אופציונלי, תופיע ביומן ובהודעה לחבר)' });
        const ok = h('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, type: 'button', disabled: Boolean(required), onClick: () => close({ reason: reason.value.trim(), ...(extra?.read?.() ?? {}) }) }, confirmLabel);
        if (required) reason.addEventListener('input', () => (ok.disabled = reason.value.trim().length < 3));
        return h('div', { class: 'dlg-body' }, h('h2', { class: 'dlg-title', text: title }), text ? h('p', { class: 'dlg-text', dir: 'auto', text }) : null, extra?.node ?? null, h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'סיבה' }), reason), h('div', { class: 'dlg-actions' }, ok, h('button', { class: 'btn btn-ghost', type: 'button', onClick: () => close(null) }, 'ביטול')));
      },
      { label: title },
    );
  }

  async function warnDialog(m) {
    const r = await reasonDialog({ title: `אזהרה ל-${m.name}`, text: 'החבר יקבל הודעה פרטית. ההסלמה האוטומטית לפי ההגדרות תופעל אם הוא מגיע לסף.', confirmLabel: 'שלח אזהרה', required: true });
    if (!r) return;
    const res = await post('/api/mod/warn', { userId: m.id, reason: r.reason });
    toast(`אזהרה מספר ${res.count} נשלחה.${res.outcome ? ` פעולה אוטומטית: ${res.outcome}.` : ''}`);
  }

  async function timeoutDialog(m) {
    const select = h('select', { class: 'input', 'aria-label': 'משך' }, DURATIONS.map(([v, t]) => h('option', { value: v, text: t })));
    const r = await reasonDialog({ title: `השתקת ${m.name}`, confirmLabel: 'השתק', extra: { node: h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'משך' }), select), read: () => ({ minutes: Number(select.value) }) } });
    if (!r) return;
    await post('/api/mod/timeout', { userId: m.id, minutes: r.minutes, reason: r.reason || undefined });
    toast('החבר הושתק.');
  }

  async function kickDialog(m) {
    const r = await reasonDialog({ title: `להרחיק את ${m.name}?`, text: 'הוא יוכל להצטרף שוב עם הזמנה חדשה.', confirmLabel: 'הרחק', danger: true });
    if (!r) return;
    await post('/api/mod/kick', { userId: m.id, reason: r.reason || undefined });
    toast('החבר הורחק.');
  }

  async function banDialog(m) {
    const days = h('select', { class: 'input', 'aria-label': 'מחיקת הודעות' }, [[0, 'בלי למחוק הודעות'], [1, 'מחק הודעות מיום אחרון'], [7, 'מחק הודעות מ-7 ימים']].map(([v, t]) => h('option', { value: v, text: t })));
    const r = await reasonDialog({ title: `לחסום את ${m.name}?`, text: 'חסימה קבועה עד שמישהו יסיר אותה.', confirmLabel: 'חסום', danger: true, extra: { node: h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'הודעות קודמות' }), days), read: () => ({ deleteDays: Number(days.value) }) } });
    if (!r) return;
    await post('/api/mod/ban', { userId: m.id, reason: r.reason || undefined, deleteDays: r.deleteDays });
    toast('החבר נחסם.');
  }

  async function unban(button) {
    const id = unbanId.value.trim();
    if (!/^\d{15,25}$/.test(id)) return toast('המזהה צריך להיות מספר ארוך (17 ספרות ומעלה).', 'error');
    if (!(await confirmDialog({ title: 'להסיר את החסימה?', body: `מזהה ${id}`, confirmLabel: 'הסר חסימה' }))) return;
    await busy(button, 'רגע...', async () => {
      try {
        await post('/api/mod/unban', { userId: id });
        toast('החסימה הוסרה.');
        unbanId.value = '';
      } catch (e) {
        toast(e.message, 'error');
      }
    });
  }
}

function memberRow(m, onOpen) {
  return h('li', {}, m.avatar ? h('img', { class: 'avatar', src: m.avatar, alt: '' }) : h('span', { class: 'avatar' }), h('div', { class: 'item-main' }, h('div', { class: 'item-title' }, h('bdi', { text: m.name })), h('div', { class: 'muted small' }, h('bdi', { dir: 'ltr', text: `@${m.username}` }))), levelBadge(m.level), h('button', { class: 'btn btn-secondary btn-sm', type: 'button', onClick: onOpen }, 'פתח'));
}
