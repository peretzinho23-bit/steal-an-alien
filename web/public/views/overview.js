import '../i18n/overview.js';
import { get, post } from '../lib/api.js';
import { watchJob } from '../lib/common.js';
import { locale, t } from '../lib/i18n.js';
import { ago, busy, clear, confirmDialog, emptyState, fullTime, h, icon, modal, put, toast } from '../lib/ui.js';

const LOCK_MINUTES = [15, 30, 60, 180];

/** The log stores English action names (shared by the bot and the site); the screen shows the current language. */
const label = (key) => {
  const text = t(key);
  return text === key ? null : text;
};

export function actionLabel(action) {
  const known = label(`overview.action.${action}`);
  if (known) return known;
  const warn = /^Warn #(\d+)$/.exec(action);
  if (warn) return t('overview.warnNumber', { count: warn[1] });
  const auto = /^AutoMod: (.+)$/.exec(action);
  if (auto) return t('overview.autoAction', { kind: label(`overview.auto.${auto[1]}`) ?? auto[1] });
  return action;
}

export async function render(main, { me }) {
  const [status, activity] = await Promise.all([get('/api/status'), get('/api/activity?limit=8')]);

  put(
    main,
    h('header', { class: 'page-head' }, h('h1', { class: 'page-title', text: t('overview.title') }), h('p', { class: 'page-sub' }, h('bdi', { text: me.guild?.name ?? '' }), me.guild?.members ? t('overview.memberCount', { count: me.guild.members.toLocaleString(locale()) }) : '')),
  );

  if (!status.redis) {
    put(
      main,
      h(
        'div',
        { class: 'banner', role: 'status' },
        icon('alert'),
        h('div', {}, h('p', { class: 'item-title', text: t('overview.storage.title') }), h('p', { text: t('overview.storage.text') })),
      ),
    );
  } else if (!status.bot.online) {
    put(
      main,
      h('div', { class: 'banner banner-bad', role: 'status' }, icon('alert'), h('div', {}, h('p', { class: 'item-title', text: t('overview.botSilent.title') }), h('p', { text: status.bot.at ? t('overview.botSilent.last', { when: ago(status.bot.at) }) : t('overview.botSilent.none') }))),
    );
  }

  const botCard = h(
    'section',
    { class: 'card' },
    h('h2', { class: 'card-title', text: t('overview.bot') }),
    h(
      'div',
      { class: 'stack' },
      h('div', { class: 'stat' }, h('span', { class: 'stat-label', text: t('overview.state') }), h('span', { class: `stat-value ${status.bot.online ? '' : 'muted'}` }, h('span', { class: `badge ${status.bot.online ? 'badge-good' : 'badge-bad'}` }, h('span', { class: 'dot' }), status.bot.online ? t('overview.online') : status.redis ? t('overview.notResponding') : t('overview.unknown')))),
      status.bot.at ? h('div', { class: 'stat' }, h('span', { class: 'stat-label', text: t('overview.lastSeen') }), h('span', { text: ago(status.bot.at), title: fullTime(status.bot.at) })) : null,
      status.bot.ping !== null ? h('div', { class: 'stat' }, h('span', { class: 'stat-label', text: t('overview.ping') }), h('span', { dir: 'ltr', class: 'mono', text: `${status.bot.ping}ms` })) : null,
    ),
  );

  const lockedUntil = status.lockdown?.until;
  const lockCard = h('section', { class: 'card' }, h('h2', { class: 'card-title', text: t('overview.lockdown') }));
  if (lockedUntil && lockedUntil > Date.now()) {
    put(
      lockCard,
      h('p', { class: 'card-sub' }, status.lockdown.by ? t('overview.lockedBy', { when: ago(lockedUntil), by: status.lockdown.by }) : t('overview.locked', { when: ago(lockedUntil) })),
      h('button', { class: 'btn btn-primary', type: 'button', disabled: !status.redis, onClick: (e) => setLockdown(e.currentTarget, false) }, icon('unlock'), t('overview.endLock')),
    );
  } else {
    put(
      lockCard,
      h('p', { class: 'card-sub', text: t('overview.lockHelp') }),
      h('button', { class: 'btn btn-danger', type: 'button', disabled: !status.redis, onClick: (e) => startLockdown(e.currentTarget) }, icon('lock'), t('overview.startLock')),
    );
  }

  const quick = h(
    'section',
    { class: 'card' },
    h('h2', { class: 'card-title', text: t('overview.shortcuts') }),
    h('div', { class: 'stack' }, h('a', { class: 'btn btn-primary', href: '#/announce' }, icon('megaphone'), t('overview.shortcut.announce')), h('a', { class: 'btn btn-secondary', href: '#/members' }, icon('search'), t('overview.shortcut.members')), h('a', { class: 'btn btn-secondary', href: '#/automod' }, icon('shield'), t('overview.shortcut.automod'))),
  );

  put(main, h('div', { class: 'grid-2' }, botCard, lockCard, quick));

  const entries = activity.entries ?? [];
  put(
    main,
    h(
      'section',
      { class: 'card' },
      h('h2', { class: 'card-title', text: t('overview.recent') }),
      entries.length
        ? h('ul', { class: 'list' }, entries.map(activityItem))
        : emptyState(t('overview.noActivity'), status.redis ? t('overview.noActivityText') : t('overview.noActivityNoStorage')),
      entries.length ? h('a', { href: '#/log', class: 'small', text: t('overview.allLog') }) : null,
    ),
  );
}

export function activityItem(e) {
  const source = e.source === 'web' ? t('overview.source.web') : e.source === 'bot' ? t('overview.source.bot') : e.source;
  const actor = e.actor?.name ?? e.moderator?.name;
  return h(
    'li',
    {},
    h('span', { class: `badge ${e.source === 'web' ? 'badge-accent' : ''}`, text: source }),
    h(
      'div',
      { class: 'item-main' },
      h('div', { class: 'item-title', dir: 'auto', text: actionLabel(e.action) }),
      h('div', { class: 'muted small', dir: 'auto' }, [actor ? t('overview.by', { name: actor }) : null, e.target?.name ?? (typeof e.target === 'string' ? e.target : null), e.details ?? e.reason].filter(Boolean).join(' · ')),
    ),
    h('time', { class: 'muted small', title: fullTime(e.at), datetime: new Date(e.at).toISOString(), text: ago(e.at) }),
  );
}

async function startLockdown(button) {
  const minutes = await modal(
    (close) => {
      const select = h('select', { class: 'input', 'aria-label': t('overview.lockDurationAria') }, LOCK_MINUTES.map((m) => h('option', { value: m, text: t(`overview.lock.${m}`) })));
      return h(
        'div',
        { class: 'dlg-body' },
        h('h2', { class: 'dlg-title', text: t('overview.lockTitle') }),
        h('p', { class: 'dlg-text', text: t('overview.lockText') }),
        h('label', { class: 'field' }, h('span', { class: 'field-label', text: t('overview.lockDuration') }), select),
        h('div', { class: 'dlg-actions' }, h('button', { class: 'btn btn-danger', type: 'button', onClick: () => close(Number(select.value)) }, t('overview.lockConfirm')), h('button', { class: 'btn btn-ghost', type: 'button', onClick: () => close(null) }, t('ui.cancel'))),
      );
    },
    { label: t('overview.lockdown') },
  );
  if (!minutes) return;
  await send(button, { on: true, minutes });
}

async function setLockdown(button, on) {
  if (!on && !(await confirmDialog({ title: t('overview.endTitle'), body: t('overview.endText'), confirmLabel: t('overview.endConfirm') }))) return;
  await send(button, { on });
}

async function send(button, body) {
  await busy(button, t('overview.sending'), async () => {
    try {
      const r = await post('/api/lockdown', body);
      toast(r.botOnline ? t('overview.queued') : t('overview.queuedOffline'), r.botOnline ? 'ok' : 'error');
      const done = await watchJob(r.id, body.on ? t('overview.lockDone') : t('overview.unlockDone'));
      if (done?.ok) location.reload();
    } catch (e) {
      toast(e.message, 'error');
    }
  });
}
