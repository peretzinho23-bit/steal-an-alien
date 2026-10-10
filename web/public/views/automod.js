import '../i18n/automod.js';
import { get, put as apiPut } from '../lib/api.js';
import { guildData } from '../lib/common.js';
import { t } from '../lib/i18n.js';
import { busy, clear, h, icon, put, toast } from '../lib/ui.js';

// the labels are looked up with t() on each render, so they follow the language switch
const presetLabels = () => ({ profanity: t('automod.preset.profanity'), sexual: t('automod.preset.sexual'), slurs: t('automod.preset.slurs') });
const actionLabels = () => ({ timeout: t('automod.action.timeout'), kick: t('automod.action.kick'), ban: t('automod.action.ban') });
const raidLabels = () => ({ lockdown: t('automod.raid.lockdown'), kick: t('automod.raid.kick'), none: t('automod.raid.none') });
const ageLabels = () => ({ none: t('automod.age.none'), timeout: t('automod.age.timeout'), kick: t('automod.age.kick') });

const clone = (o) => JSON.parse(JSON.stringify(o));

export async function render(main, { me }) {
  const [{ settings: saved, stored, redis }, { roles }] = await Promise.all([get('/api/settings'), guildData()]);
  const isAdmin = me.level === 'admin';
  const canEdit = isAdmin && redis;
  let current = clone(saved);
  let baseline = JSON.stringify(saved);

  put(main, h('header', { class: 'page-head' }, h('h1', { class: 'page-title', text: t('automod.title') }), h('p', { class: 'page-sub', text: t('automod.lead') })));
  if (!redis) put(main, h('div', { class: 'banner', role: 'status' }, icon('alert'), h('p', { text: t('automod.banner.noRedis') })));
  else if (!isAdmin) put(main, h('div', { class: 'banner', role: 'status' }, icon('alert'), h('p', { text: t('automod.banner.notAdmin') })));
  else if (!stored) put(main, h('div', { class: 'banner banner-good', id: 'first-save-banner', role: 'status' }, icon('check'), h('p', { text: t('automod.banner.firstSave') })));

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
      put(
        clear(host),
        h('span', { class: 'field-label', text: label }),
        h('div', { class: 'chips' }, list().length ? list().map((v) => h('span', { class: 'chip' }, h('bdi', { text: v }), canEdit ? h('button', { type: 'button', 'aria-label': t('automod.chips.remove', { value: v }), onClick: () => (setPath(keys, list().filter((x) => x !== v)), draw()) }, icon('x', { size: 14 })) : null)) : h('span', { class: 'muted small', text: t('automod.chips.empty') })),
        canEdit ? h('div', { class: 'row' }, input, h('button', { class: 'btn btn-secondary', type: 'button', onClick: add }, icon('plus', { size: 16 }), t('automod.chips.add'))) : null,
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
    h('span', { class: 'field-label', text: t('automod.discord.presetsLabel') }),
    h('div', { class: 'row-wrap' }, Object.entries(presetLabels()).map(([id, label]) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: current.automod.badWords.presets.includes(id), disabled: !canEdit, onChange: (e) => setPath(['automod', 'badWords', 'presets'], e.target.checked ? [...current.automod.badWords.presets, id] : current.automod.badWords.presets.filter((x) => x !== id)) }), label))),
  );

  const escalationHost = h('div', { class: 'stack' });
  function drawEscalation() {
    const steps = current.automod.warns.escalation;
    put(
      clear(escalationHost),
      steps.length ? null : h('p', { class: 'muted', text: t('automod.escalation.none') }),
      steps.map((s, i) =>
        h(
          'div',
          { class: 'row-wrap card', role: 'group', 'aria-label': t('automod.escalation.step', { n: i + 1 }) },
          h('span', {}, t('automod.escalation.after')),
          h('input', { class: 'input input-sm', type: 'number', min: 1, max: 50, value: s.at, dir: 'ltr', disabled: !canEdit, 'aria-label': t('automod.escalation.count'), onInput: (e) => ((s.at = Number(e.target.value)), markDirty()) }),
          h('span', {}, t('automod.escalation.warnings')),
          h('select', { class: 'input', style: undefined, disabled: !canEdit, 'aria-label': t('automod.escalation.action'), onChange: (e) => ((s.action = e.target.value), s.action === 'timeout' ? (s.minutes ??= 60) : delete s.minutes, markDirty(), drawEscalation()) }, Object.entries(actionLabels()).map(([v, label]) => h('option', { value: v, text: label, selected: s.action === v }))),
          s.action === 'timeout' ? h('span', { class: 'row' }, h('input', { class: 'input input-sm', type: 'number', min: 1, max: 40320, value: s.minutes ?? 60, dir: 'ltr', disabled: !canEdit, 'aria-label': t('automod.escalation.minutesAria'), onInput: (e) => ((s.minutes = Number(e.target.value)), markDirty()) }), h('span', { class: 'muted', text: t('automod.escalation.minutes') })) : null,
          canEdit ? h('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'aria-label': t('automod.escalation.removeStep'), onClick: () => (steps.splice(i, 1), markDirty(), drawEscalation()) }, icon('trash', { size: 16 })) : null,
        ),
      ),
      canEdit && steps.length < 6 ? h('button', { class: 'btn btn-secondary btn-sm', type: 'button', onClick: () => (steps.push({ at: (steps.at(-1)?.at ?? 0) + 2, action: 'timeout', minutes: 60 }), markDirty(), drawEscalation()) }, icon('plus', { size: 16 }), t('automod.escalation.addStep')) : null,
    );
  }
  drawEscalation();

  const roleNames = roles.filter((r) => !r.managed).map((r) => r.name);

  put(
    root,
    card(t('automod.main.title'), null, toggle(t('automod.main.enabled'), t('automod.main.enabledHint'), ['automod', 'enabled'])),
    card(
      t('automod.discord.title'),
      t('automod.discord.sub'),
      toggle(t('automod.discord.spam'), t('automod.discord.spamHint'), ['automod', 'spam']),
      toggle(t('automod.discord.invites'), t('automod.discord.invitesHint'), ['automod', 'invites', 'block']),
      toggle(t('automod.discord.scams'), t('automod.discord.scamsHint'), ['automod', 'scams', 'block']),
      toggle(t('automod.discord.mentions'), t('automod.discord.mentionsHint'), ['automod', 'mentions', 'enabled']),
      h('div', { class: 'fields-2' }, number(t('automod.discord.mentionsLimit'), ['automod', 'mentions', 'limit'], { min: 2, max: 50 }), number(t('automod.discord.mentionsTimeout'), ['automod', 'mentions', 'timeoutMinutes'], { min: 0, max: 40320, unit: t('automod.discord.mentionsTimeoutUnit') })),
      toggle(t('automod.discord.badWords'), null, ['automod', 'badWords', 'enabled']),
      presets,
      toggle(t('automod.discord.customWords'), null, ['automod', 'customWords', 'enabled']),
      chipsEditor(t('automod.words.label'), ['automod', 'customWords', 'words'], { placeholder: t('automod.words.placeholder') }),
      chipsEditor(t('automod.words.allow'), ['automod', 'badWords', 'allow'], { placeholder: t('automod.words.placeholder') }),
    ),
    card(
      t('automod.defenses.title'),
      t('automod.defenses.sub'),
      toggle(t('automod.flood.title'), t('automod.flood.hint'), ['automod', 'flood', 'enabled']),
      h('div', { class: 'fields-2' }, number(t('automod.flood.messages'), ['automod', 'flood', 'messages'], { min: 3, max: 30 }), number(t('automod.flood.within'), ['automod', 'flood', 'seconds'], { min: 2, max: 60, unit: t('automod.flood.seconds') }), number(t('automod.flood.timeout'), ['automod', 'flood', 'timeoutMinutes'], { min: 1, max: 1440, unit: t('automod.flood.minutes') })),
      toggle(t('automod.duplicates.title'), t('automod.duplicates.hint'), ['automod', 'duplicates', 'enabled']),
      h('div', { class: 'fields-2' }, number(t('automod.duplicates.times'), ['automod', 'duplicates', 'count'], { min: 2, max: 10 }), number(t('automod.flood.within'), ['automod', 'duplicates', 'seconds'], { min: 5, max: 300, unit: t('automod.flood.seconds') })),
      toggle(t('automod.caps.title'), t('automod.caps.hint'), ['automod', 'caps', 'enabled']),
      h('div', { class: 'fields-2' }, number(t('automod.caps.minLength'), ['automod', 'caps', 'minLength'], { min: 5, max: 200, unit: t('automod.caps.letters') }), number(t('automod.caps.percent'), ['automod', 'caps', 'percent'], { min: 30, max: 100, unit: '%' })),
      select(t('automod.links.label'), ['automod', 'links', 'mode'], { off: t('automod.links.off'), allowlist: t('automod.links.allowlist') }),
      chipsEditor(t('automod.links.allowed'), ['automod', 'links', 'allow'], { placeholder: t('automod.links.placeholder') }),
      h('p', { class: 'field-hint', text: t('automod.defenses.threeHint') }),
    ),
    card(t('automod.escalation.title'), t('automod.escalation.sub'), escalationHost),
    card(
      t('automod.raid.title'),
      t('automod.raid.sub'),
      toggle(t('automod.raid.enabled'), null, ['raid', 'enabled']),
      h('div', { class: 'fields-2' }, number(t('automod.raid.joins'), ['raid', 'joins'], { min: 3, max: 100 }), number(t('automod.raid.within'), ['raid', 'seconds'], { min: 5, max: 300, unit: t('automod.raid.seconds') })),
      select(t('automod.raid.action'), ['raid', 'action'], raidLabels()),
      number(t('automod.raid.lockdownMinutes'), ['raid', 'lockdownMinutes'], { min: 1, max: 1440, unit: t('automod.raid.minutes') }),
      h('div', { class: 'fields-2' }, number(t('automod.raid.minAge'), ['raid', 'minAccountAgeDays'], { min: 0, max: 365, unit: t('automod.raid.days') }), select(t('automod.raid.newAccount'), ['raid', 'accountAgeAction'], ageLabels())),
      h('p', { class: 'field-hint', text: t('automod.raid.ageHint') }),
      toggle(t('automod.raid.gate'), t('automod.raid.gateHint'), ['raid', 'gate']),
    ),
    card(t('automod.exempt.title'), t('automod.exempt.sub'), chipsEditor(t('automod.exempt.roles'), ['automod', 'exemptRoles'], { placeholder: t('automod.exempt.placeholder'), lower: false, suggestions: roleNames })),
    card(
      t('automod.logs.title'),
      t('automod.logs.sub'),
      h(
        'div',
        { class: 'fields-2' },
        [
          ['joins', t('automod.logs.joins')],
          ['leaves', t('automod.logs.leaves')],
          ['messages', t('automod.logs.messages')],
          ['bans', t('automod.logs.bans')],
          ['channels', t('automod.logs.channels')],
          ['roles', t('automod.logs.roles')],
          ['voice', t('automod.logs.voice')],
        ].map(([k, label]) => toggle(label, null, ['logs', k])),
      ),
    ),
  );

  // ---- save bar --------------------------------------------------------------------------------------
  const status = h('span', { class: 'muted' }, t('automod.save.noChanges'));
  const saveBtn = h('button', { class: 'btn btn-primary', type: 'button', disabled: true, onClick: (e) => save(e.currentTarget) }, icon('check'), t('automod.save.button'));
  const discardBtn = h('button', { class: 'btn btn-ghost', type: 'button', disabled: true, onClick: () => (current = clone(JSON.parse(baseline)), clear(root), clear(main), render(main, { me })) }, t('automod.save.discard'));
  const bar = h('div', { class: 'savebar' }, status, h('span', { class: 'spacer' }), discardBtn, saveBtn);
  if (canEdit) put(main, bar);

  function markDirty() {
    const dirty = JSON.stringify(current) !== baseline;
    bar.classList.toggle('dirty', dirty);
    saveBtn.disabled = !dirty;
    discardBtn.disabled = !dirty;
    status.textContent = dirty ? t('automod.save.dirty') : t('automod.save.noChanges');
  }

  async function save(button) {
    await busy(button, t('automod.save.saving'), async () => {
      try {
        const r = await apiPut('/api/settings', { settings: current });
        document.getElementById('first-save-banner')?.remove();
        current = clone(r.settings);
        baseline = JSON.stringify(r.settings);
        markDirty();
        const problems = r.sync?.errors ?? [];
        put(
          clear(result),
          problems.length
            ? h('div', { class: 'banner banner-bad', role: 'alert' }, icon('alert'), h('div', {}, h('p', { class: 'item-title', text: t('automod.save.syncProblems') }), problems.map((p) => h('p', { dir: 'auto', text: p })), h('p', { text: t('automod.save.syncRetry') })))
            : h('div', { class: 'banner banner-good', role: 'status' }, icon('check'), h('p', { text: t('automod.save.synced', { created: r.sync.created.length, updated: r.sync.updated.length, removed: r.sync.removed.length }) })),
        );
        toast(problems.length ? t('automod.save.withProblems') : t('automod.save.ok'), problems.length ? 'error' : 'ok');
      } catch (e) {
        toast(e.message, 'error');
      }
    });
  }
}
