import { get, put as apiPut } from '../lib/api.js';
import { guildData } from '../lib/common.js';
import { busy, clear, h, icon, put, toast } from '../lib/ui.js';

const PRESET_LABELS = { profanity: 'קללות', sexual: 'תוכן מיני', slurs: 'הסתה ושנאה' };
const ACTION_LABELS = { timeout: 'השתקה (Timeout)', kick: 'הרחקה (Kick)', ban: 'חסימה (Ban)' };
const RAID_LABELS = { lockdown: 'נעילת השרת', kick: 'הרחקת המצטרפים החדשים', none: 'רק התראה לצוות' };
const AGE_LABELS = { none: 'לא לעשות כלום', timeout: 'להשתיק עד שהחשבון מספיק ישן', kick: 'להרחיק' };

const clone = (o) => JSON.parse(JSON.stringify(o));

export async function render(main, { me }) {
  const [{ settings: saved, stored, redis }, { roles }] = await Promise.all([get('/api/settings'), guildData()]);
  const isAdmin = me.level === 'admin';
  const canEdit = isAdmin && redis;
  let current = clone(saved);
  let baseline = JSON.stringify(saved);

  put(main, h('header', { class: 'page-head' }, h('h1', { class: 'page-title', text: 'אוטו-אדמין' }), h('p', { class: 'page-sub', text: 'מה השרת עושה לבד: מסנן ספאם, מילים והונאות, עוצר פשיטות ומסלים אזהרות. שינוי כאן מתעדכן ב-Discord מיד ובבוט תוך כדקה.' })));
  if (!redis) put(main, h('div', { class: 'banner', role: 'status' }, icon('alert'), h('p', { text: 'האחסון המשותף (Upstash Redis) לא מחובר, אז אי אפשר לשמור שינויים. מוצגות ברירות המחדל.' })));
  else if (!isAdmin) put(main, h('div', { class: 'banner', role: 'status' }, icon('alert'), h('p', { text: 'רק אדמינים יכולים לשנות את ההגדרות. אפשר לראות אותן.' })));
  else if (!stored) put(main, h('div', { class: 'banner banner-good', id: 'first-save-banner', role: 'status' }, icon('check'), h('p', { text: 'עוד לא שמרת הגדרות, אז אלה ברירות המחדל המומלצות. לחץ "שמור והחל" כדי להפעיל אותן ב-Discord.' })));

  const result = h('div', {});
  const root = h('div', { class: 'stack' });
  put(main, root, result);

  // ---- tiny form builders bound to `current` -------------------------------------------------------
  const path = (obj, keys) => keys.reduce((o, k) => o[k], obj);
  const setPath = (keys, value) => {
    path(current, keys.slice(0, -1))[keys.at(-1)] = value;
    markDirty();
  };

  const toggle = (title, hint, keys) =>
    h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: path(current, keys), disabled: !canEdit, onChange: (e) => setPath(keys, e.target.checked) }), h('span', { class: 'switch-text' }, h('span', { class: 'switch-title', text: title }), hint ? h('span', { class: 'field-hint', text: hint }) : null));

  const number = (label, keys, { min, max, unit } = {}) =>
    h('label', { class: 'field' }, h('span', { class: 'field-label', text: label }), h('div', { class: 'row' }, h('input', { class: 'input input-sm', type: 'number', inputmode: 'numeric', min, max, value: path(current, keys), disabled: !canEdit, dir: 'ltr', onInput: (e) => setPath(keys, e.target.value === '' ? '' : Number(e.target.value)) }), unit ? h('span', { class: 'muted', text: unit }) : null));

  const select = (label, keys, options) =>
    h('label', { class: 'field' }, h('span', { class: 'field-label', text: label }), h('select', { class: 'input', disabled: !canEdit, onChange: (e) => setPath(keys, e.target.value) }, Object.entries(options).map(([value, text]) => h('option', { value, text, selected: path(current, keys) === value }))));

  function chipsEditor(label, keys, { placeholder, lower = true, suggestions } = {}) {
    const host = h('div', { class: 'stack' });
    const list = () => path(current, keys);
    const draw = () => {
      const input = h('input', { class: 'input', dir: 'auto', placeholder, 'aria-label': label, disabled: !canEdit, list: suggestions ? `dl-${keys.join('-')}` : undefined });
      const add = () => {
        const raw = input.value.trim();
        const value = lower ? raw.toLowerCase() : raw;
        if (!value || list().includes(value)) return (input.value = '');
        setPath(keys, [...list(), value]);
        draw();
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          add();
        }
      });
      put(clear(host), 
        h('span', { class: 'field-label', text: label }),
        h('div', { class: 'chips' }, list().length ? list().map((v) => h('span', { class: 'chip' }, h('bdi', { text: v }), canEdit ? h('button', { type: 'button', 'aria-label': `הסר ${v}`, onClick: () => (setPath(keys, list().filter((x) => x !== v)), draw()) }, icon('x', { size: 14 })) : null)) : h('span', { class: 'muted small', text: 'ריק' })),
        canEdit ? h('div', { class: 'row' }, input, h('button', { class: 'btn btn-secondary', type: 'button', onClick: add }, icon('plus', { size: 16 }), 'הוסף')) : null,
        suggestions ? h('datalist', { id: `dl-${keys.join('-')}` }, suggestions.map((s) => h('option', { value: s }))) : null,
      );
    };
    draw();
    return host;
  }

  const card = (title, sub, ...children) => h('section', { class: 'card' }, h('h2', { class: 'card-title', text: title }), sub ? h('p', { class: 'card-sub', text: sub }) : null, h('div', { class: 'stack' }, children));

  // ---- sections ------------------------------------------------------------------------------------
  const presets = h(
    'div',
    { class: 'field' },
    h('span', { class: 'field-label', text: 'מה לחסום' }),
    h('div', { class: 'row-wrap' }, Object.entries(PRESET_LABELS).map(([id, label]) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: current.automod.badWords.presets.includes(id), disabled: !canEdit, onChange: (e) => setPath(['automod', 'badWords', 'presets'], e.target.checked ? [...current.automod.badWords.presets, id] : current.automod.badWords.presets.filter((x) => x !== id)) }), label))),
  );

  const escalationHost = h('div', { class: 'stack' });
  function drawEscalation() {
    const steps = current.automod.warns.escalation;
    put(clear(escalationHost), 
      steps.length ? null : h('p', { class: 'muted', text: 'אין הסלמה אוטומטית: אזהרות רק נרשמות.' }),
      steps.map((s, i) =>
        h(
          'div',
          { class: 'row-wrap card', role: 'group', 'aria-label': `שלב ${i + 1}` },
          h('span', {}, 'אחרי'),
          h('input', { class: 'input input-sm', type: 'number', min: 1, max: 50, value: s.at, dir: 'ltr', disabled: !canEdit, 'aria-label': 'מספר אזהרות', onInput: (e) => ((s.at = Number(e.target.value)), markDirty()) }),
          h('span', {}, 'אזהרות:'),
          h('select', { class: 'input', style: undefined, disabled: !canEdit, 'aria-label': 'פעולה', onChange: (e) => ((s.action = e.target.value), s.action === 'timeout' ? (s.minutes ??= 60) : delete s.minutes, markDirty(), drawEscalation()) }, Object.entries(ACTION_LABELS).map(([v, t]) => h('option', { value: v, text: t, selected: s.action === v }))),
          s.action === 'timeout' ? h('span', { class: 'row' }, h('input', { class: 'input input-sm', type: 'number', min: 1, max: 40320, value: s.minutes ?? 60, dir: 'ltr', disabled: !canEdit, 'aria-label': 'דקות', onInput: (e) => ((s.minutes = Number(e.target.value)), markDirty()) }), h('span', { class: 'muted', text: 'דקות' })) : null,
          canEdit ? h('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'aria-label': 'הסר שלב', onClick: () => (steps.splice(i, 1), markDirty(), drawEscalation()) }, icon('trash', { size: 16 })) : null,
        ),
      ),
      canEdit && steps.length < 6 ? h('button', { class: 'btn btn-secondary btn-sm', type: 'button', onClick: () => (steps.push({ at: (steps.at(-1)?.at ?? 0) + 2, action: 'timeout', minutes: 60 }), markDirty(), drawEscalation()) }, icon('plus', { size: 16 }), 'הוסף שלב') : null,
    );
  }
  drawEscalation();

  const roleNames = roles.filter((r) => !r.managed).map((r) => r.name);

  put(root, 
    card('מתג ראשי', null, toggle('אוטו-אדמין פעיל', 'כשהוא כבוי, הבוט מוריד את כל הכללים שהוא יצר ב-Discord ולא מפעיל הגנות.', ['automod', 'enabled'])),
    card(
      'המסננים של Discord',
      'רצים אצל Discord עצמו, גם כשהבוט כבוי.',
      toggle('ספאם', 'Discord מזהה הודעות ספאם לבד.', ['automod', 'spam']),
      toggle('קישורי הזמנה לשרתים אחרים', 'חוסם discord.gg וכדומה. הצוות פטור.', ['automod', 'invites', 'block']),
      toggle('הונאות', 'חוסם "Robux בחינם", "Nitro בחינם", מקצרי קישורים וכדומה.', ['automod', 'scams', 'block']),
      toggle('תיוגים מרובים', 'חוסם הודעה עם יותר מדי תיוגים, ומשתיק את השולח.', ['automod', 'mentions', 'enabled']),
      h('div', { class: 'fields-2' }, number('מקסימום תיוגים בהודעה', ['automod', 'mentions', 'limit'], { min: 2, max: 50 }), number('משך ההשתקה', ['automod', 'mentions', 'timeoutMinutes'], { min: 0, max: 40320, unit: 'דקות (0 = בלי השתקה)' })),
      toggle('מילים אסורות (רשימות של Discord)', null, ['automod', 'badWords', 'enabled']),
      presets,
      toggle('מילים משלי', null, ['automod', 'customWords', 'enabled']),
      chipsEditor('המילים (אפשר * בהתחלה או בסוף, למשל scam*)', ['automod', 'customWords', 'words'], { placeholder: 'כתוב מילה ולחץ Enter' }),
      chipsEditor('מילים שמותר להשתמש בהן למרות הרשימות', ['automod', 'badWords', 'allow'], { placeholder: 'כתוב מילה ולחץ Enter' }),
    ),
    card(
      'ההגנות של הבוט',
      'דורשות שהבוט פועל. כמה מהן קוראות את תוכן ההודעות ולכן צריכות את ההרשאה Message Content בפורטל המפתחים.',
      toggle('הצפה', 'הרבה הודעות בזמן קצר: מוחק אותן ומשתיק.', ['automod', 'flood', 'enabled']),
      h('div', { class: 'fields-2' }, number('הודעות', ['automod', 'flood', 'messages'], { min: 3, max: 30 }), number('תוך', ['automod', 'flood', 'seconds'], { min: 2, max: 60, unit: 'שניות' }), number('השתקה', ['automod', 'flood', 'timeoutMinutes'], { min: 1, max: 1440, unit: 'דקות' })),
      toggle('הודעות חוזרות', 'אותה הודעה שוב ושוב.', ['automod', 'duplicates', 'enabled']),
      h('div', { class: 'fields-2' }, number('פעמים', ['automod', 'duplicates', 'count'], { min: 2, max: 10 }), number('תוך', ['automod', 'duplicates', 'seconds'], { min: 5, max: 300, unit: 'שניות' })),
      toggle('צעקות באותיות גדולות', 'באנגלית בלבד.', ['automod', 'caps', 'enabled']),
      h('div', { class: 'fields-2' }, number('אורך מינימלי', ['automod', 'caps', 'minLength'], { min: 5, max: 200, unit: 'אותיות' }), number('אחוז אותיות גדולות', ['automod', 'caps', 'percent'], { min: 30, max: 100, unit: '%' })),
      select('קישורים', ['automod', 'links', 'mode'], { off: 'מותרים בכל מקום', allowlist: 'רק מאתרים ברשימה' }),
      chipsEditor('אתרים מותרים', ['automod', 'links', 'allow'], { placeholder: 'למשל roblox.com' }),
      h('p', { class: 'field-hint', text: 'שלוש הפרות בתוך 10 דקות הופכות לאזהרה אחת.' }),
    ),
    card('הסלמת אזהרות', 'מה קורה כשחבר מגיע למספר מסוים של אזהרות (מהצוות או מההגנות).', escalationHost),
    card(
      'הגנה מפני פשיטות',
      'פשיטה היא הצטרפות של הרבה חשבונות בבת אחת כדי להציף את השרת.',
      toggle('הגנה פעילה', null, ['raid', 'enabled']),
      h('div', { class: 'fields-2' }, number('מספר מצטרפים', ['raid', 'joins'], { min: 3, max: 100 }), number('תוך', ['raid', 'seconds'], { min: 5, max: 300, unit: 'שניות' })),
      select('מה לעשות כשזה קורה', ['raid', 'action'], RAID_LABELS),
      number('משך הנעילה האוטומטית', ['raid', 'lockdownMinutes'], { min: 1, max: 1440, unit: 'דקות' }),
      h('div', { class: 'fields-2' }, number('גיל חשבון מינימלי', ['raid', 'minAccountAgeDays'], { min: 0, max: 365, unit: 'ימים' }), select('חשבון חדש מדי', ['raid', 'accountAgeAction'], AGE_LABELS)),
      h('p', { class: 'field-hint', text: 'בשרת של משחק יש הרבה ילדים עם חשבונות חדשים. אם מפעילים סינון לפי גיל, עדיף השתקה מהרחקה.' }),
      toggle('שער אימות', 'חברים חדשים רואים רק את ערוצי המידע עד שהם לוחצים "אימות" ב-welcome. מי שכבר בשרת מקבל Member אוטומטית לפני ההפעלה.', ['raid', 'gate']),
    ),
    card('פטורים', 'הרולים האלה לא מושפעים מההגנות. אדמינים ומי שיכול לנהל הודעות תמיד פטורים.', chipsEditor('רולים פטורים', ['automod', 'exemptRoles'], { placeholder: 'שם של רול', lower: false, suggestions: roleNames })),
    card(
      'יומן אוטומטי',
      'מה הבוט רושם בערוץ mod-log.',
      h('div', { class: 'fields-2' }, [['joins', 'הצטרפות'], ['leaves', 'עזיבה'], ['messages', 'הודעות שנמחקו או נערכו'], ['bans', 'חסימות והשתקות'], ['channels', 'ערוצים'], ['roles', 'רולים'], ['voice', 'כניסה ויציאה מערוצי קול']].map(([k, label]) => toggle(label, null, ['logs', k]))),
    ),
  );

  // ---- save bar --------------------------------------------------------------------------------------
  const status = h('span', { class: 'muted' }, 'אין שינויים.');
  const saveBtn = h('button', { class: 'btn btn-primary', type: 'button', disabled: true, onClick: (e) => save(e.currentTarget) }, icon('check'), 'שמור והחל');
  const discardBtn = h('button', { class: 'btn btn-ghost', type: 'button', disabled: true, onClick: () => (current = clone(JSON.parse(baseline)), clear(root), clear(main), render(main, { me })) }, 'בטל שינויים');
  const bar = h('div', { class: 'savebar' }, status, h('span', { class: 'spacer' }), discardBtn, saveBtn);
  if (canEdit) put(main, bar);

  function markDirty() {
    const dirty = JSON.stringify(current) !== baseline;
    bar.classList.toggle('dirty', dirty);
    saveBtn.disabled = !dirty;
    discardBtn.disabled = !dirty;
    status.textContent = dirty ? 'יש שינויים שלא נשמרו.' : 'אין שינויים.';
  }

  async function save(button) {
    await busy(button, 'שומר...', async () => {
      try {
        const r = await apiPut('/api/settings', { settings: current });
        document.getElementById('first-save-banner')?.remove();
        current = clone(r.settings);
        baseline = JSON.stringify(r.settings);
        markDirty();
        const problems = r.sync?.errors ?? [];
        put(clear(result), 
          problems.length
            ? h('div', { class: 'banner banner-bad', role: 'alert' }, icon('alert'), h('div', {}, h('p', { class: 'item-title', text: 'ההגדרות נשמרו, אבל Discord לא קיבל את כל הכללים' }), problems.map((p) => h('p', { dir: 'auto', text: p })), h('p', { text: 'הבוט ינסה שוב לבד בהפעלה הבאה או בשמירה הבאה.' })))
            : h('div', { class: 'banner banner-good', role: 'status' }, icon('check'), h('p', { text: `נשמר והוחל ב-Discord (${r.sync.created.length} חדשים, ${r.sync.updated.length} עודכנו, ${r.sync.removed.length} הוסרו). ההגנות של הבוט מתעדכנות תוך כדקה.` })),
        );
        toast(problems.length ? 'נשמר, עם בעיות. ראה מתחת.' : 'ההגדרות נשמרו.', problems.length ? 'error' : 'ok');
      } catch (e) {
        toast(e.message, 'error');
      }
    });
  }
}
