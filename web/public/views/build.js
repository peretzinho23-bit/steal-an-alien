import '../i18n/build.js';
import { api, post } from '../lib/api.js';
import { channelOptions, guildData, roleColor } from '../lib/common.js';
import { t } from '../lib/i18n.js';
import { busy, clear, confirmDialog, h, icon, modal, put, toast } from '../lib/ui.js';

// the labels are looked up with t() on each render, so they follow the language switch
const accessLabels = () => ({ chat: t('build.access.chat'), read: t('build.access.read'), staff: t('build.access.staff'), hidden: t('build.access.hidden') });
const panelLabels = () => ({ welcome: t('build.panel.welcome'), rules: t('build.panel.rules'), tickets: t('build.panel.tickets') });

export async function render(main, { me }) {
  const isAdmin = me.level === 'admin';
  put(main, h('header', { class: 'page-head' }, h('h1', { class: 'page-title', text: t('build.title') }), h('p', { class: 'page-sub', text: t('build.lead') })));
  if (!isAdmin) put(main, h('div', { class: 'banner', role: 'status' }, icon('alert'), h('p', { text: t('build.banner.notAdmin') })));

  const host = h('div', { class: 'stack' });
  put(main, host);
  await draw();

  async function draw(fresh = false) {
    const { channels, roles } = await guildData({ fresh });
    clear(host);

    // ---- create channel
    const name = h('input', { class: 'input', dir: 'auto', maxlength: '100', placeholder: t('build.channel.namePlaceholder'), 'aria-label': t('build.channel.nameAria') });
    const type = h('select', { class: 'input', 'aria-label': t('build.channel.typeAria') }, [
      ['text', t('build.type.text')],
      ['voice', t('build.type.voice')],
      ['category', t('build.type.category')],
    ].map(([v, label]) => h('option', { value: v, text: label })));
    const access = h('select', { class: 'input', 'aria-label': t('build.channel.accessAria') }, Object.entries(accessLabels()).map(([v, label]) => h('option', { value: v, text: label })));
    const parent = h('select', { class: 'input', 'aria-label': t('build.channel.categoryAria'), dir: 'ltr' }, h('option', { value: '', text: t('build.channel.noCategory') }), channelOptions(channels, { type: 'category' }));
    type.addEventListener('change', () => (parent.disabled = type.value === 'category'));

    put(
      host,
      h(
        'section',
        { class: 'card stack' },
        h('h2', { class: 'card-title', text: t('build.channel.title') }),
        h('div', { class: 'fields-2' }, h('label', { class: 'field' }, h('span', { class: 'field-label', text: t('build.channel.name') }), name), h('label', { class: 'field' }, h('span', { class: 'field-label', text: t('build.channel.type') }), type), h('label', { class: 'field' }, h('span', { class: 'field-label', text: t('build.channel.access') }), access), h('label', { class: 'field' }, h('span', { class: 'field-label', text: t('build.channel.category') }), parent)),
        h('div', {}, h('button', { class: 'btn btn-primary', type: 'button', disabled: !isAdmin, onClick: (e) => createChannel(e.currentTarget, { name, type, access, parent }) }, icon('plus', { size: 16 }), t('build.channel.create'))),
      ),
    );

    // ---- create role
    const roleName = h('input', { class: 'input', dir: 'auto', maxlength: '100', placeholder: t('build.role.namePlaceholder'), 'aria-label': t('build.role.nameAria') });
    const roleColorInput = h('input', { type: 'color', class: 'swatch', value: '#5b3df5', 'aria-label': t('build.role.colorAria') });
    const hoist = h('input', { type: 'checkbox' });
    const mentionable = h('input', { type: 'checkbox' });
    put(
      host,
      h(
        'section',
        { class: 'card stack' },
        h('h2', { class: 'card-title', text: t('build.role.title') }),
        h('div', { class: 'fields-2' }, h('label', { class: 'field' }, h('span', { class: 'field-label', text: t('build.role.name') }), roleName), h('div', { class: 'field' }, h('span', { class: 'field-label', text: t('build.role.color') }), roleColorInput)),
        h('div', { class: 'row-wrap' }, h('label', { class: 'check' }, hoist, t('build.role.hoist')), h('label', { class: 'check' }, mentionable, t('build.role.mentionable'))),
        h('div', {}, h('button', { class: 'btn btn-primary', type: 'button', disabled: !isAdmin, onClick: (e) => createRole(e.currentTarget, { roleName, roleColorInput, hoist, mentionable }) }, icon('plus', { size: 16 }), t('build.role.create'))),
      ),
    );

    // ---- channels
    const noCategory = t('build.channel.noCategory');
    const cats = channels.filter((c) => c.type === 4);
    const groups = [{ name: noCategory, items: channels.filter((c) => c.type !== 4 && !c.parentId) }, ...cats.map((c) => ({ name: c.name, id: c.id, items: channels.filter((x) => x.parentId === c.id) }))].filter((g) => g.items.length || g.id);
    put(
      host,
      h(
        'section',
        { class: 'card' },
        h('h2', { class: 'card-title', text: t('build.list.channelsTitle') }),
        groups.map((g) =>
          h(
            'div',
            { class: 'stack' },
            h('div', { class: 'row' }, icon('folder', { size: 16 }), h('strong', { dir: 'auto', text: g.name }), g.id && isAdmin ? h('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'aria-label': t('build.list.deleteCategory', { name: g.name }), onClick: () => removeChannel({ id: g.id, name: g.name }) }, icon('trash', { size: 16 })) : null),
            g.items.length ? h('ul', { class: 'list' }, g.items.map((c) => channelRow(c))) : h('p', { class: 'muted small', text: t('build.list.empty') }),
          ),
        ),
      ),
    );

    // ---- roles
    put(
      host,
      h(
        'section',
        { class: 'card' },
        h('h2', { class: 'card-title', text: t('build.list.rolesTitle') }),
        h('ul', { class: 'list' }, roles.map((r) => h('li', {}, h('span', { class: 'dot', style: undefined, 'aria-hidden': 'true', dataset: { c: roleColor(r) ?? '' } }), h('div', { class: 'item-main' }, h('div', { class: 'item-title', dir: 'auto', text: r.name }), h('div', { class: 'muted small', text: r.managed ? t('build.list.managed') : r.pingable ? t('build.list.pingable') : '' })), isAdmin && !r.managed ? h('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'aria-label': t('build.list.deleteRole', { name: r.name }), onClick: () => removeRole(r) }, icon('trash', { size: 16 })) : null))),
      ),
    );

    // ---- panels
    put(
      host,
      h(
        'section',
        { class: 'card stack' },
        h('h2', { class: 'card-title', text: t('build.panels.title') }),
        h('p', { class: 'card-sub', text: t('build.panels.sub') }),
        h('div', { class: 'row-wrap' }, Object.entries(panelLabels()).map(([id, label]) => h('button', { class: 'btn btn-secondary', type: 'button', disabled: !isAdmin, onClick: (e) => repost(e.currentTarget, id) }, icon('refresh', { size: 16 }), label))),
      ),
    );

    for (const dot of host.querySelectorAll('.dot[data-c]')) dot.style.color = dot.dataset.c || 'var(--line)';
  }

  function channelRow(c) {
    const kind = c.type === 2 || c.type === 13 ? 'volume' : 'hash';
    return h('li', {}, icon(kind, { size: 16 }), h('div', { class: 'item-main' }, h('div', { class: 'item-title', dir: 'auto', text: c.name })), isAdmin ? h('div', { class: 'row' }, h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: () => renameChannel(c) }, t('build.list.rename')), h('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'aria-label': t('build.list.deleteChannel', { name: c.name }), onClick: () => removeChannel(c) }, icon('trash', { size: 16 }))) : null);
  }

  async function createChannel(button, f) {
    if (!f.name.value.trim()) return toast(t('build.toast.nameChannel'), 'error');
    await busy(button, t('build.creating'), async () => {
      try {
        await post('/api/channels', { name: f.name.value.trim(), type: f.type.value, access: f.access.value, parentId: f.type.value === 'category' ? undefined : f.parent.value || undefined });
        toast(t('build.toast.channelCreated'));
        await draw(true);
      } catch (e) {
        toast(e.message, 'error');
      }
    });
  }

  async function createRole(button, f) {
    if (!f.roleName.value.trim()) return toast(t('build.toast.nameRole'), 'error');
    await busy(button, t('build.creating'), async () => {
      try {
        await post('/api/roles', { name: f.roleName.value.trim(), color: f.roleColorInput.value, hoist: f.hoist.checked, mentionable: f.mentionable.checked });
        toast(t('build.toast.roleCreated'));
        await draw(true);
      } catch (e) {
        toast(e.message, 'error');
      }
    });
  }

  async function renameChannel(c) {
    const value = await modal(
      (close) => {
        const input = h('input', { class: 'input', dir: 'auto', maxlength: '100', value: c.name, 'aria-label': t('build.rename.newAria') });
        return h(
          'div',
          { class: 'dlg-body' },
          h('h2', { class: 'dlg-title', text: t('build.rename.title') }),
          h('label', { class: 'field' }, h('span', { class: 'field-label', text: t('build.rename.new') }), input),
          h('div', { class: 'dlg-actions' }, h('button', { class: 'btn btn-primary', type: 'button', onClick: () => close(input.value.trim()) }, t('build.rename.save')), h('button', { class: 'btn btn-ghost', type: 'button', onClick: () => close(null) }, t('build.rename.cancel'))),
        );
      },
      { label: t('build.rename.title') },
    );
    if (!value || value === c.name) return;
    try {
      await api(`/api/channels/${c.id}`, { method: 'PATCH', body: { name: value } });
      toast(t('build.toast.renamed'));
      await draw(true);
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function removeChannel(c) {
    if (!(await confirmDialog({ title: t('build.deleteChannel.title', { name: c.name }), body: t('build.deleteChannel.body'), confirmLabel: t('build.delete.confirm'), danger: true, typeToConfirm: c.name }))) return;
    try {
      await api(`/api/channels/${c.id}`, { method: 'DELETE', body: { confirm: c.name } });
      toast(t('build.toast.channelDeleted'));
      await draw(true);
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function removeRole(r) {
    if (!(await confirmDialog({ title: t('build.deleteRole.title', { name: r.name }), body: t('build.deleteRole.body'), confirmLabel: t('build.delete.confirm'), danger: true, typeToConfirm: r.name }))) return;
    try {
      await api(`/api/roles/${r.id}`, { method: 'DELETE', body: { confirm: r.name } });
      toast(t('build.toast.roleDeleted'));
      await draw(true);
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function repost(button, panel) {
    await busy(button, t('build.sending'), async () => {
      try {
        const r = await post('/api/panels/repost', { panel });
        toast(r.botOnline ? t('build.toast.repostSent') : t('build.toast.repostOffline'), r.botOnline ? 'ok' : 'error');
      } catch (e) {
        toast(e.message, 'error');
      }
    });
  }
}
