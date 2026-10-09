import { api, post } from '../lib/api.js';
import { channelOptions, guildData, roleColor } from '../lib/common.js';
import { busy, clear, confirmDialog, h, icon, modal, put, toast } from '../lib/ui.js';

const ACCESS = {
  chat: 'כולם כותבים',
  read: 'כולם קוראים, רק הצוות כותב',
  staff: 'צוות בלבד (Moderator ו-Admin)',
  hidden: 'אדמינים בלבד',
};
const PANELS = { welcome: 'ברוכים הבאים', rules: 'חוקים', tickets: 'כפתור הטיקטים' };

export async function render(main, { me }) {
  const isAdmin = me.level === 'admin';
  put(main, h('header', { class: 'page-head' }, h('h1', { class: 'page-title', text: 'ערוצים ורולים' }), h('p', { class: 'page-sub', text: 'יצירה ומחיקה של ערוצים ורולים בלי לפתוח את דיסקורד. הרולים החדשים נוצרים בלי הרשאות, את ההרשאות קובעים בדיסקורד עצמו.' })));
  if (!isAdmin) put(main, h('div', { class: 'banner', role: 'status' }, icon('alert'), h('p', { text: 'רק אדמינים יכולים ליצור ולמחוק. אפשר לראות את הרשימות.' })));

  const host = h('div', { class: 'stack' });
  put(main, host);
  await draw();

  async function draw(fresh = false) {
    const { channels, roles } = await guildData({ fresh });
    clear(host);

    // ---- create channel
    const name = h('input', { class: 'input', dir: 'auto', maxlength: '100', placeholder: 'שם הערוץ', 'aria-label': 'שם הערוץ' });
    const type = h('select', { class: 'input', 'aria-label': 'סוג' }, [['text', 'טקסט'], ['voice', 'קול'], ['category', 'קטגוריה']].map(([v, t]) => h('option', { value: v, text: t })));
    const access = h('select', { class: 'input', 'aria-label': 'מי יכול להשתמש' }, Object.entries(ACCESS).map(([v, t]) => h('option', { value: v, text: t })));
    const parent = h('select', { class: 'input', 'aria-label': 'קטגוריה', dir: 'ltr' }, h('option', { value: '', text: 'בלי קטגוריה' }), channelOptions(channels, { type: 'category' }));
    type.addEventListener('change', () => (parent.disabled = type.value === 'category'));

    put(host, 
      h(
        'section',
        { class: 'card stack' },
        h('h2', { class: 'card-title', text: 'ערוץ חדש' }),
        h('div', { class: 'fields-2' }, h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'שם' }), name), h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'סוג' }), type), h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'מי יכול להשתמש' }), access), h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'קטגוריה' }), parent)),
        h('div', {}, h('button', { class: 'btn btn-primary', type: 'button', disabled: !isAdmin, onClick: (e) => createChannel(e.currentTarget, { name, type, access, parent }) }, icon('plus', { size: 16 }), 'צור ערוץ')),
      ),
    );

    // ---- create role
    const roleName = h('input', { class: 'input', dir: 'auto', maxlength: '100', placeholder: 'שם הרול', 'aria-label': 'שם הרול' });
    const roleColorInput = h('input', { type: 'color', class: 'swatch', value: '#5b3df5', 'aria-label': 'צבע הרול' });
    const hoist = h('input', { type: 'checkbox' });
    const mentionable = h('input', { type: 'checkbox' });
    put(host, 
      h(
        'section',
        { class: 'card stack' },
        h('h2', { class: 'card-title', text: 'רול חדש' }),
        h('div', { class: 'fields-2' }, h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'שם' }), roleName), h('div', { class: 'field' }, h('span', { class: 'field-label', text: 'צבע' }), roleColorInput)),
        h('div', { class: 'row-wrap' }, h('label', { class: 'check' }, hoist, 'מוצג בנפרד ברשימת החברים'), h('label', { class: 'check' }, mentionable, 'כולם יכולים לתייג אותו')),
        h('div', {}, h('button', { class: 'btn btn-primary', type: 'button', disabled: !isAdmin, onClick: (e) => createRole(e.currentTarget, { roleName, roleColorInput, hoist, mentionable }) }, icon('plus', { size: 16 }), 'צור רול')),
      ),
    );

    // ---- channels
    const cats = channels.filter((c) => c.type === 4);
    const groups = [{ name: 'בלי קטגוריה', items: channels.filter((c) => c.type !== 4 && !c.parentId) }, ...cats.map((c) => ({ name: c.name, id: c.id, items: channels.filter((x) => x.parentId === c.id) }))].filter((g) => g.items.length || g.id);
    put(host, 
      h(
        'section',
        { class: 'card' },
        h('h2', { class: 'card-title', text: 'הערוצים בשרת' }),
        groups.map((g) =>
          h(
            'div',
            { class: 'stack' },
            h('div', { class: 'row' }, icon('folder', { size: 16 }), h('strong', { dir: 'auto', text: g.name }), g.id && isAdmin ? h('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'aria-label': `מחק את הקטגוריה ${g.name}`, onClick: () => removeChannel({ id: g.id, name: g.name }) }, icon('trash', { size: 16 })) : null),
            g.items.length ? h('ul', { class: 'list' }, g.items.map((c) => channelRow(c))) : h('p', { class: 'muted small', text: 'ריקה' }),
          ),
        ),
      ),
    );

    // ---- roles
    put(host, 
      h(
        'section',
        { class: 'card' },
        h('h2', { class: 'card-title', text: 'הרולים בשרת' }),
        h('ul', { class: 'list' }, roles.map((r) => h('li', {}, h('span', { class: 'dot', style: undefined, 'aria-hidden': 'true', dataset: { c: roleColor(r) ?? '' } }), h('div', { class: 'item-main' }, h('div', { class: 'item-title', dir: 'auto', text: r.name }), h('div', { class: 'muted small', text: r.managed ? 'מנוהל על ידי בוט' : r.pingable ? 'אפשר לתייג מהאתר' : '' })), isAdmin && !r.managed ? h('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'aria-label': `מחק את הרול ${r.name}`, onClick: () => removeRole(r) }, icon('trash', { size: 16 })) : null))),
      ),
    );

    // ---- panels
    put(host, 
      h(
        'section',
        { class: 'card stack' },
        h('h2', { class: 'card-title', text: 'רענון הודעות קבועות' }),
        h('p', { class: 'card-sub', text: 'הבוט מעדכן את ההודעות הקבועות (ברוכים הבאים, חוקים, כפתור הטיקטים) בכל הפעלה. כאן אפשר לבקש ממנו לעשות את זה עכשיו.' }),
        h('div', { class: 'row-wrap' }, Object.entries(PANELS).map(([id, label]) => h('button', { class: 'btn btn-secondary', type: 'button', disabled: !isAdmin, onClick: (e) => repost(e.currentTarget, id) }, icon('refresh', { size: 16 }), label))),
      ),
    );

    for (const dot of host.querySelectorAll('.dot[data-c]')) dot.style.color = dot.dataset.c || 'var(--line)';
  }

  function channelRow(c) {
    const kind = c.type === 2 || c.type === 13 ? 'volume' : 'hash';
    return h('li', {}, icon(kind, { size: 16 }), h('div', { class: 'item-main' }, h('div', { class: 'item-title', dir: 'auto', text: c.name })), isAdmin ? h('div', { class: 'row' }, h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: () => renameChannel(c) }, 'שנה שם'), h('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'aria-label': `מחק את ${c.name}`, onClick: () => removeChannel(c) }, icon('trash', { size: 16 }))) : null);
  }

  async function createChannel(button, f) {
    if (!f.name.value.trim()) return toast('כתוב שם לערוץ.', 'error');
    await busy(button, 'יוצר...', async () => {
      try {
        await post('/api/channels', { name: f.name.value.trim(), type: f.type.value, access: f.access.value, parentId: f.type.value === 'category' ? undefined : f.parent.value || undefined });
        toast('הערוץ נוצר.');
        await draw(true);
      } catch (e) {
        toast(e.message, 'error');
      }
    });
  }

  async function createRole(button, f) {
    if (!f.roleName.value.trim()) return toast('כתוב שם לרול.', 'error');
    await busy(button, 'יוצר...', async () => {
      try {
        await post('/api/roles', { name: f.roleName.value.trim(), color: f.roleColorInput.value, hoist: f.hoist.checked, mentionable: f.mentionable.checked });
        toast('הרול נוצר.');
        await draw(true);
      } catch (e) {
        toast(e.message, 'error');
      }
    });
  }

  async function renameChannel(c) {
    const value = await modal(
      (close) => {
        const input = h('input', { class: 'input', dir: 'auto', maxlength: '100', value: c.name, 'aria-label': 'שם חדש' });
        return h('div', { class: 'dlg-body' }, h('h2', { class: 'dlg-title', text: 'שינוי שם' }), h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'שם חדש' }), input), h('div', { class: 'dlg-actions' }, h('button', { class: 'btn btn-primary', type: 'button', onClick: () => close(input.value.trim()) }, 'שמור'), h('button', { class: 'btn btn-ghost', type: 'button', onClick: () => close(null) }, 'ביטול')));
      },
      { label: 'שינוי שם' },
    );
    if (!value || value === c.name) return;
    try {
      await api(`/api/channels/${c.id}`, { method: 'PATCH', body: { name: value } });
      toast('השם עודכן.');
      await draw(true);
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function removeChannel(c) {
    if (!(await confirmDialog({ title: `למחוק את ${c.name}?`, body: 'הערוץ וכל ההודעות בו יימחקו לצמיתות.', confirmLabel: 'מחק', danger: true, typeToConfirm: c.name }))) return;
    try {
      await api(`/api/channels/${c.id}`, { method: 'DELETE', body: { confirm: c.name } });
      toast('הערוץ נמחק.');
      await draw(true);
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function removeRole(r) {
    if (!(await confirmDialog({ title: `למחוק את הרול ${r.name}?`, body: 'מי שמחזיק בו מאבד אותו.', confirmLabel: 'מחק', danger: true, typeToConfirm: r.name }))) return;
    try {
      await api(`/api/roles/${r.id}`, { method: 'DELETE', body: { confirm: r.name } });
      toast('הרול נמחק.');
      await draw(true);
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function repost(button, panel) {
    await busy(button, 'שולח...', async () => {
      try {
        const r = await post('/api/panels/repost', { panel });
        toast(r.botOnline ? 'נשלח לבוט. ההודעה תתעדכן תוך חצי דקה.' : 'נשלח, אבל הבוט לא נראה מחובר.', r.botOnline ? 'ok' : 'error');
      } catch (e) {
        toast(e.message, 'error');
      }
    });
  }
}
