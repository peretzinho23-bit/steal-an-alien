import { get, post } from '../lib/api.js';
import { watchJob } from '../lib/common.js';
import { ago, busy, confirmDialog, emptyState, fullTime, h, icon, modal, put, toast } from '../lib/ui.js';

const SOURCE_LABEL = { web: 'האתר', bot: 'הבוט' };

/** The log stores English action names (shared by the bot and the site); the screen shows Hebrew. */
const ACTION_HE = {
  'Message sent': 'נשלחה הודעה',
  'Message edited': 'הודעה נערכה',
  'Message deleted': 'הודעה נמחקה',
  'Reaction added': 'נוספה ריאקציה',
  'Settings saved': 'ההגדרות נשמרו',
  'Channel created': 'נוצר ערוץ',
  'Channel edited': 'ערוץ נערך',
  'Channel deleted': 'ערוץ נמחק',
  'Role created': 'נוצר רול',
  'Role deleted': 'רול נמחק',
  'Member roles changed': 'רולים של חבר שונו',
  'Lockdown requested': 'התבקשה נעילת חירום',
  'Lockdown end requested': 'התבקש סיום נעילה',
  'Lockdown ON': 'נעילת חירום הופעלה',
  'Lockdown OFF': 'נעילת חירום הסתיימה',
  'Panel refresh requested': 'התבקש רענון הודעה קבועה',
  Timeout: 'השתקה',
  'Timeout removed': 'השתקה הוסרה',
  Untimeout: 'השתקה הוסרה',
  Kick: 'הרחקה',
  Ban: 'חסימה',
  Unban: 'הסרת חסימה',
  Tempban: 'חסימה זמנית',
  Unwarn: 'אזהרה הוסרה',
  'Warning removed': 'אזהרה הוסרה',
  'Warnings cleared': 'אזהרות נוקו',
  'Clear warnings': 'אזהרות נוקו',
  Clear: 'מחיקת הודעות',
  Announcement: 'הכרזה',
  'Account age check': 'בדיקת גיל חשבון',
};
export function actionLabel(action) {
  if (ACTION_HE[action]) return ACTION_HE[action];
  const warn = /^Warn #(\d+)$/.exec(action);
  if (warn) return `אזהרה מספר ${warn[1]}`;
  const auto = /^AutoMod: (.+)$/.exec(action);
  if (auto) return `הגנה אוטומטית: ${{ flood: 'הצפה', duplicates: 'הודעות חוזרות', caps: 'אותיות גדולות', links: 'קישור אסור' }[auto[1]] ?? auto[1]}`;
  return action;
}

export async function render(main, { me }) {
  const [status, activity] = await Promise.all([get('/api/status'), get('/api/activity?limit=8')]);

  put(main, 
    h('header', { class: 'page-head' }, h('h1', { class: 'page-title', text: 'סקירה' }), h('p', { class: 'page-sub' }, h('bdi', { text: me.guild?.name ?? '' }), me.guild?.members ? ` · ${me.guild.members.toLocaleString('he-IL')} חברים` : '')),
  );

  if (!status.redis) {
    put(main, 
      h(
        'div',
        { class: 'banner', role: 'status' },
        icon('alert'),
        h('div', {}, h('p', { class: 'item-title', text: 'האחסון המשותף לא מחובר' }), h('p', { text: 'בלי Upstash Redis אי אפשר לשמור הגדרות אוטו-אדמין, אזהרות ויומן פעילות, ואי אפשר לשלוח לבוט פקודות כמו נעילת חירום. הכרזות, הודעות וניהול ערוצים עובדים כרגיל. ההוראות במדריך ההתקנה.' })),
      ),
    );
  } else if (!status.bot.online) {
    put(main, 
      h('div', { class: 'banner banner-bad', role: 'status' }, icon('alert'), h('div', {}, h('p', { class: 'item-title', text: 'הבוט לא שולח סימן חיים' }), h('p', { text: status.bot.at ? `הסימן האחרון היה ${ago(status.bot.at)}. בדוק שהבוט רץ באירוח.` : 'עוד לא התקבל סימן חיים. בדוק שהבוט רץ ושהוא מחובר לאותו Redis.' }))),
    );
  }

  const botCard = h(
    'section',
    { class: 'card' },
    h('h2', { class: 'card-title', text: 'הבוט' }),
    h(
      'div',
      { class: 'stack' },
      h('div', { class: 'stat' }, h('span', { class: 'stat-label', text: 'מצב' }), h('span', { class: `stat-value ${status.bot.online ? '' : 'muted'}` }, h('span', { class: `badge ${status.bot.online ? 'badge-good' : 'badge-bad'}` }, h('span', { class: 'dot' }), status.bot.online ? 'מחובר' : status.redis ? 'לא מגיב' : 'לא ידוע'))),
      status.bot.at ? h('div', { class: 'stat' }, h('span', { class: 'stat-label', text: 'סימן חיים אחרון' }), h('span', { text: ago(status.bot.at), title: fullTime(status.bot.at) })) : null,
      status.bot.ping !== null ? h('div', { class: 'stat' }, h('span', { class: 'stat-label', text: 'השהיה מול Discord' }), h('span', { dir: 'ltr', class: 'mono', text: `${status.bot.ping}ms` })) : null,
    ),
  );

  const lockedUntil = status.lockdown?.until;
  const lockCard = h('section', { class: 'card' }, h('h2', { class: 'card-title', text: 'נעילת חירום' }));
  if (lockedUntil && lockedUntil > Date.now()) {
    put(lockCard, 
      h('p', { class: 'card-sub' }, `השרת נעול. יפתח שוב ${ago(lockedUntil)}${status.lockdown.by ? `, הופעל על ידי ${status.lockdown.by}` : ''}.`),
      h('button', { class: 'btn btn-primary', type: 'button', disabled: !status.redis, onClick: (e) => setLockdown(e.currentTarget, false) }, icon('unlock'), 'סיים את הנעילה'),
    );
  } else {
    put(lockCard, 
      h('p', { class: 'card-sub', text: 'במקרה של פשיטה: חוסם כתיבה בערוצי הצ׳אט הציבוריים ומשהה הזמנות. הצוות והאדמינים ממשיכים לכתוב.' }),
      h('button', { class: 'btn btn-danger', type: 'button', disabled: !status.redis, onClick: (e) => startLockdown(e.currentTarget) }, icon('lock'), 'הפעל נעילה'),
    );
  }

  const quick = h(
    'section',
    { class: 'card' },
    h('h2', { class: 'card-title', text: 'קיצורים' }),
    h('div', { class: 'stack' }, h('a', { class: 'btn btn-primary', href: '#/announce' }, icon('megaphone'), 'כתוב הכרזה'), h('a', { class: 'btn btn-secondary', href: '#/members' }, icon('search'), 'חפש חבר'), h('a', { class: 'btn btn-secondary', href: '#/automod' }, icon('shield'), 'הגדרות אוטו-אדמין')),
  );

  put(main, h('div', { class: 'grid-2' }, botCard, lockCard, quick));

  const entries = activity.entries ?? [];
  put(main, 
    h(
      'section',
      { class: 'card' },
      h('h2', { class: 'card-title', text: 'פעילות אחרונה' }),
      entries.length
        ? h('ul', { class: 'list' }, entries.map(activityItem))
        : emptyState('עוד אין פעילות', status.redis ? 'כשמישהו מהצוות יעשה פעולה, היא תופיע כאן.' : 'היומן צריך את האחסון המשותף כדי לעבוד.'),
      entries.length ? h('a', { href: '#/log', class: 'small', text: 'כל היומן' }) : null,
    ),
  );
}

export function activityItem(e) {
  return h(
    'li',
    {},
    h('span', { class: `badge ${e.source === 'web' ? 'badge-accent' : ''}`, text: SOURCE_LABEL[e.source] ?? e.source }),
    h(
      'div',
      { class: 'item-main' },
      h('div', { class: 'item-title', dir: 'auto', text: actionLabel(e.action) }),
      h('div', { class: 'muted small', dir: 'auto' }, [e.actor?.name ? `על ידי ${e.actor.name}` : e.moderator?.name ? `על ידי ${e.moderator.name}` : null, e.target?.name ?? (typeof e.target === 'string' ? e.target : null), e.details ?? e.reason].filter(Boolean).join(' · ')),
    ),
    h('time', { class: 'muted small', title: fullTime(e.at), datetime: new Date(e.at).toISOString(), text: ago(e.at) }),
  );
}

async function startLockdown(button) {
  const minutes = await modal(
    (close) => {
      const select = h('select', { class: 'input', 'aria-label': 'משך הנעילה' }, [15, 30, 60, 180].map((m) => h('option', { value: m, text: m < 60 ? `${m} דקות` : `${m / 60} ${m === 60 ? 'שעה' : 'שעות'}` })));
      return h(
        'div',
        { class: 'dlg-body' },
        h('h2', { class: 'dlg-title', text: 'להפעיל נעילת חירום?' }),
        h('p', { class: 'dlg-text', text: 'אף אחד חוץ מהצוות לא יוכל לכתוב בערוצי הצ׳אט, והזמנות לשרת יושהו. הבוט ישחרר את הנעילה אוטומטית בסוף הזמן.' }),
        h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'משך' }), select),
        h('div', { class: 'dlg-actions' }, h('button', { class: 'btn btn-danger', type: 'button', onClick: () => close(Number(select.value)) }, 'הפעל נעילה'), h('button', { class: 'btn btn-ghost', type: 'button', onClick: () => close(null) }, 'ביטול')),
      );
    },
    { label: 'נעילת חירום' },
  );
  if (!minutes) return;
  await send(button, { on: true, minutes });
}

async function setLockdown(button, on) {
  if (!on && !(await confirmDialog({ title: 'לסיים את הנעילה?', body: 'הצ׳אט ייפתח שוב לכולם וההזמנות יחזרו לעבוד.', confirmLabel: 'סיים נעילה' }))) return;
  await send(button, { on });
}

async function send(button, body) {
  await busy(button, 'שולח לבוט...', async () => {
    try {
      const r = await post('/api/lockdown', body);
      toast(r.botOnline ? 'נשלח לבוט. ממתין שיבצע...' : 'נשלח, אבל הבוט לא נראה מחובר. אם הוא לא יענה תוך 5 דקות, הבקשה תפוג.', r.botOnline ? 'ok' : 'error');
      const done = await watchJob(r.id, body.on ? 'הנעילה הופעלה' : 'הנעילה הסתיימה');
      if (done?.ok) location.reload();
    } catch (e) {
      toast(e.message, 'error');
    }
  });
}
