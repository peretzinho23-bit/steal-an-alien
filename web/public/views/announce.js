import { get, post } from '../lib/api.js';
import { channelOptions, guildData } from '../lib/common.js';
import { buildPreview } from '../lib/preview.js';
import { busy, clear, confirmDialog, debounce, h, icon, modal, put, toast } from '../lib/ui.js';

const COLORS = [
  ['ירוק חייזר', '#2fbf71'],
  ['סגול', '#5b3df5'],
  ['אדום', '#e5484d'],
  ['זהב', '#f5b83d'],
  ['כחול', '#3b82f6'],
  ['לבן', '#f2f0f7'],
];
const DRAFT_KEY = 'saa-draft-v1';
const MAX_FIELDS = 6;

const blank = (channelId = '') => ({ channelId, text: '', useEmbed: true, title: '', description: '', color: '#2fbf71', image: '', thumbnail: '', footer: '', timestamp: false, fields: [], pingRoleIds: [], pingEveryone: false });

function loadDraft() {
  try {
    const raw = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? 'null');
    return raw && typeof raw === 'object' ? { ...blank(), ...raw } : null;
  } catch {
    return null;
  }
}
function saveDraft(state) {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(state));
  } catch {
    /* storage blocked: the draft just is not remembered */
  }
}
const clearDraft = () => {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* ignore */
  }
};

const hexOf = (n) => (typeof n === 'number' ? `#${n.toString(16).padStart(6, '0')}` : '#5b3df5');

export async function render(main, { me }) {
  const { channels, roles } = await guildData();
  const state = loadDraft() ?? blank();
  let edit = null; // { channelId, messageId, channelName, editable } while editing an existing message

  put(main, h('header', { class: 'page-head' }, h('h1', { class: 'page-title', text: 'הכרזות והודעות' }), h('p', { class: 'page-sub', text: 'כתוב הודעה בשם הבוט ותראה בצד איך היא תיראה בדיסקורד. אפשר גם לערוך הודעה שהבוט כבר שלח.' })));

  // ---- mode switch -------------------------------------------------------------------------------
  const modeHost = h('div', {});
  const tabs = h(
    'div',
    { class: 'tabs', role: 'tablist', 'aria-label': 'סוג פעולה' },
    h('button', { class: 'tab', role: 'tab', type: 'button', 'aria-selected': 'true', id: 'tab-new', onClick: () => setMode('new') }, 'הודעה חדשה'),
    h('button', { class: 'tab', role: 'tab', type: 'button', 'aria-selected': 'false', id: 'tab-edit', onClick: () => setMode('edit') }, 'עריכה או מחיקה של הודעה קיימת'),
  );

  // ---- preview -----------------------------------------------------------------------------------
  const previewHost = h('div', {});
  const refresh = () => {
    put(clear(previewHost), buildPreview(state, { botName: 'Steal An Alien', roles, channels }));
    saveDraftSoon();
  };
  const saveDraftSoon = debounce(() => {
    if (!edit) saveDraft(state);
  }, 400);

  // ---- form controls (built once, bound to state) --------------------------------------------------
  const bind = (key, el, transform = (v) => v) => {
    el.addEventListener('input', () => {
      state[key] = transform(el.type === 'checkbox' ? el.checked : el.value);
      refresh();
    });
    return el;
  };

  const channelSelect = h('select', { class: 'input', id: 'f-channel', dir: 'ltr' }, h('option', { value: '', text: 'בחר ערוץ...' }), channelOptions(channels, { selected: state.channelId }));
  channelSelect.value = state.channelId;
  channelSelect.addEventListener('change', () => {
    state.channelId = channelSelect.value;
    saveDraftSoon();
  });

  const textArea = bind('text', h('textarea', { class: 'input', id: 'f-text', dir: 'auto', placeholder: 'הטקסט שיופיע מעל ההכרזה (אופציונלי)', maxlength: '2000', value: state.text }));
  const useEmbed = bind('useEmbed', h('input', { type: 'checkbox', id: 'f-embed', checked: state.useEmbed }));
  const title = bind('title', h('input', { class: 'input', id: 'f-title', dir: 'auto', maxlength: '256', placeholder: 'כותרת', value: state.title }));
  const description = bind('description', h('textarea', { class: 'input', id: 'f-desc', dir: 'auto', maxlength: '4000', placeholder: 'הטקסט המלא. אפשר **מודגש**, *נטוי*, `קוד` וקישורים.', value: state.description }));
  const image = bind('image', h('input', { class: 'input', id: 'f-image', dir: 'ltr', placeholder: 'https://...', value: state.image, inputmode: 'url' }));
  const thumbnail = bind('thumbnail', h('input', { class: 'input', id: 'f-thumb', dir: 'ltr', placeholder: 'https://...', value: state.thumbnail, inputmode: 'url' }));
  const footer = bind('footer', h('input', { class: 'input', id: 'f-footer', dir: 'auto', maxlength: '2048', placeholder: 'שורה קטנה בתחתית', value: state.footer }));
  const timestamp = bind('timestamp', h('input', { type: 'checkbox', id: 'f-ts', checked: state.timestamp }));
  const embedBox = h('div', { class: 'fields' });
  useEmbed.addEventListener('change', () => (embedBox.hidden = !state.useEmbed));
  embedBox.hidden = !state.useEmbed;

  const swatchHost = h('div', { class: 'swatches', role: 'group', 'aria-label': 'צבע הפס של ההכרזה' });
  const customColor = h('input', { type: 'color', class: 'swatch', 'aria-label': 'צבע מותאם אישית', value: state.color });
  customColor.addEventListener('input', () => {
    state.color = customColor.value;
    drawSwatches();
    refresh();
  });
  function drawSwatches() {
    put(clear(swatchHost), 
      COLORS.map(([name, hex]) => {
        const b = h('button', { class: 'swatch', type: 'button', 'aria-label': name, 'aria-pressed': String(state.color.toLowerCase() === hex), title: name, onClick: () => ((state.color = hex), drawSwatches(), refresh()) });
        b.style.background = hex;
        return b;
      }),
      customColor,
    );
  }
  drawSwatches();

  const fieldsHost = h('div', { class: 'stack' });
  function drawFields() {
    put(clear(fieldsHost), 
      state.fields.map((f, i) =>
        h(
          'div',
          { class: 'card', role: 'group', 'aria-label': `שדה ${i + 1}` },
          h(
            'div',
            { class: 'fields' },
            h('input', { class: 'input', dir: 'auto', maxlength: '256', placeholder: 'שם השדה', 'aria-label': `שם שדה ${i + 1}`, value: f.name, onInput: (e) => ((f.name = e.target.value), refresh()) }),
            h('textarea', { class: 'input', dir: 'auto', maxlength: '1000', placeholder: 'ערך השדה', 'aria-label': `ערך שדה ${i + 1}`, value: f.value, onInput: (e) => ((f.value = e.target.value), refresh()) }),
            h(
              'div',
              { class: 'row' },
              h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: f.inline, onChange: (e) => ((f.inline = e.target.checked), refresh()) }), 'מוצג בשורה אחת עם שדות אחרים'),
              h('span', { class: 'spacer' }),
              h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: () => (state.fields.splice(i, 1), drawFields(), refresh()) }, icon('trash', { size: 16 }), 'הסר'),
            ),
          ),
        ),
      ),
      state.fields.length < MAX_FIELDS ? h('button', { class: 'btn btn-secondary btn-sm', type: 'button', onClick: () => (state.fields.push({ name: '', value: '', inline: false }), drawFields(), refresh()) }, icon('plus', { size: 16 }), 'הוסף שדה') : null,
    );
  }
  drawFields();

  put(embedBox, 
    h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'כותרת' }), title),
    h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'תוכן' }), description),
    h('div', { class: 'field' }, h('span', { class: 'field-label', text: 'צבע' }), swatchHost),
    h('div', { class: 'fields-2' }, h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'תמונה גדולה (קישור)' }), image), h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'תמונה קטנה בצד (קישור)' }), thumbnail)),
    h('p', { class: 'field-hint' }, 'קישורי תמונה חייבים להתחיל ב-', h('bdi', { dir: 'ltr', class: 'mono', text: 'https://' })),
    h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'שורת תחתית' }), footer),
    h('label', { class: 'check' }, timestamp, 'הצג תאריך ושעה'),
    h('div', { class: 'field' }, h('span', { class: 'field-label', text: 'שדות' }), fieldsHost),
  );

  // pings
  const pingable = roles.filter((r) => r.pingable);
  const pingHost = h(
    'div',
    { class: 'stack' },
    pingable.length
      ? h('div', { class: 'chips' }, pingable.map((r) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: state.pingRoleIds.includes(r.id), onChange: (e) => ((state.pingRoleIds = e.target.checked ? [...state.pingRoleIds, r.id] : state.pingRoleIds.filter((x) => x !== r.id)), refresh()) }), h('bdi', { text: r.name }))))
      : h('p', { class: 'muted small', text: 'אין רולי התראות. הבוט יוצר אותם בעצמו, או סמן רול כ-Mentionable בדיסקורד.' }),
    me.level === 'admin' ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: state.pingEveryone, onChange: (e) => ((state.pingEveryone = e.target.checked), refresh()) }), h('span', {}, 'תייג ', h('bdi', { class: 'mono', text: '@everyone' }), ' (מתריע לכולם, תשתמש בזהירות)')) : null,
  );

  const sendBtn = h('button', { class: 'btn btn-primary', type: 'button', onClick: (e) => submit(e.currentTarget) }, icon('send'), 'שלח');
  const clearBtn = h('button', { class: 'btn btn-ghost', type: 'button', onClick: reset }, 'נקה הכל');
  const editActions = h('div', { class: 'row-wrap' });

  const channelField = h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'ערוץ' }), channelSelect);
  const form = h(
    'div',
    { class: 'card stack' },
    channelField,
    h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'טקסט רגיל' }), textArea),
    h('label', { class: 'check' }, useEmbed, 'הוסף הכרזה מעוצבת (Embed)'),
    embedBox,
    h('div', { class: 'field', id: 'ping-field' }, h('span', { class: 'field-label', text: 'תיוגים' }), pingHost),
    h('div', { class: 'row-wrap' }, sendBtn, clearBtn, editActions),
  );

  put(main, tabs, modeHost, h('div', { class: 'split' }, form, h('div', { class: 'preview-sticky' }, h('p', { class: 'preview-label', text: 'תצוגה מקדימה' }), previewHost)));
  refresh();

  // ---- behaviour -----------------------------------------------------------------------------------
  function setMode(mode) {
    tabs.querySelector('#tab-new').setAttribute('aria-selected', String(mode === 'new'));
    tabs.querySelector('#tab-edit').setAttribute('aria-selected', String(mode === 'edit'));
    clear(modeHost);
    if (mode === 'new') {
      edit = null;
      channelField.hidden = false;
      pingHost.parentElement.hidden = false;
      sendBtn.replaceChildren(icon('send'), 'שלח');
      clear(editActions);
      Object.assign(state, loadDraft() ?? blank(state.channelId));
      syncInputs();
      return;
    }
    const link = h('input', { class: 'input', dir: 'ltr', placeholder: 'https://discord.com/channels/...', 'aria-label': 'קישור להודעה', inputmode: 'url' });
    const load = h('button', { class: 'btn btn-primary', type: 'button', onClick: (e) => loadMessage(e.currentTarget, link.value) }, icon('link'), 'טען');
    put(modeHost, h('div', { class: 'card stack', style: undefined }, h('p', { class: 'muted', text: 'בדיסקורד: קליק ימני על הודעה ← העתק קישור להודעה, והדבק כאן.' }), h('div', { class: 'row' }, link, load)));
  }

  function syncInputs() {
    channelSelect.value = state.channelId;
    textArea.value = state.text;
    useEmbed.checked = state.useEmbed;
    embedBox.hidden = !state.useEmbed;
    title.value = state.title;
    description.value = state.description;
    image.value = state.image;
    thumbnail.value = state.thumbnail;
    footer.value = state.footer;
    timestamp.checked = state.timestamp;
    customColor.value = /^#[0-9a-f]{6}$/i.test(state.color) ? state.color : '#2fbf71';
    drawSwatches();
    drawFields();
    for (const box of pingHost.querySelectorAll('input[type=checkbox]')) box.checked = false;
    refresh();
  }

  function reset() {
    Object.assign(state, blank(state.channelId));
    if (!edit) clearDraft();
    syncInputs();
  }

  function payload() {
    const embed = {};
    if (state.title.trim()) embed.title = state.title.trim();
    if (state.description.trim()) embed.description = state.description.trim();
    if (state.color) embed.color = state.color;
    if (state.image.trim()) embed.image = state.image.trim();
    if (state.thumbnail.trim()) embed.thumbnail = state.thumbnail.trim();
    if (state.footer.trim()) embed.footer = state.footer.trim();
    if (state.timestamp) embed.timestamp = true;
    const fields = state.fields.filter((f) => f.name.trim() && f.value.trim()).map((f) => ({ name: f.name.trim(), value: f.value.trim(), inline: f.inline }));
    if (fields.length) embed.fields = fields;
    const hasEmbed = state.useEmbed && (embed.title || embed.description || embed.image || embed.fields);
    return { content: state.text.trim() || undefined, embeds: hasEmbed ? [embed] : [], pingRoleIds: state.pingRoleIds, pingEveryone: state.pingEveryone };
  }

  async function submit(button) {
    const body = payload();
    if (!edit && !state.channelId) return toast('בחר קודם ערוץ.', 'error');
    if (!body.content && !body.embeds.length) return toast('כתוב טקסט או הוסף הכרזה לפני השליחה.', 'error');
    if (state.pingEveryone && !(await confirmDialog({ title: 'לתייג את כולם?', body: 'ההודעה תשלח התראה לכל חברי השרת. בטוח?', confirmLabel: 'כן, תייג את כולם', danger: true }))) return;
    await busy(button, edit ? 'מעדכן...' : 'שולח...', async () => {
      try {
        const result = edit ? await post('/api/messages/edit', { channelId: edit.channelId, messageId: edit.messageId, content: body.content, embeds: body.embeds }) : await post('/api/send', { channelId: state.channelId, ...body });
        toast(edit ? 'ההודעה עודכנה.' : 'ההודעה נשלחה.');
        const box = previewHost.querySelector('.discord');
        if (!edit) {
          box?.classList.add('beaming');
          await new Promise((r) => setTimeout(r, 950));
        }
        showLink(result.link);
        if (!edit) {
          const keep = state.channelId;
          Object.assign(state, blank(keep));
          clearDraft();
          syncInputs();
        }
      } catch (e) {
        toast(e.message, 'error');
        previewHost.querySelector('.discord')?.classList.remove('beaming');
      }
    });
  }

  function showLink(link) {
    if (!link) return;
    const old = document.getElementById('sent-banner');
    old?.remove();
    form.before(h('div', { class: 'banner banner-good', id: 'sent-banner', role: 'status' }, icon('check'), h('p', {}, 'נשלח. ', h('a', { href: link, target: '_blank', rel: 'noopener noreferrer' }, 'פתח בדיסקורד ', icon('external', { size: 14 })))));
  }

  async function loadMessage(button, link) {
    await busy(button, 'טוען...', async () => {
      try {
        const m = await get(`/api/messages/lookup?link=${encodeURIComponent(link.trim())}`);
        edit = { channelId: m.channelId, messageId: m.messageId, channelName: m.channelName, editable: m.editable };
        const first = m.embeds[0];
        Object.assign(state, blank(m.channelId), {
          text: m.content,
          useEmbed: Boolean(first),
          title: first?.title ?? '',
          description: first?.description ?? '',
          color: hexOf(first?.color),
          image: first?.image ?? '',
          thumbnail: first?.thumbnail ?? '',
          footer: first?.footer ?? '',
          fields: (first?.fields ?? []).map((f) => ({ name: f.name, value: f.value, inline: Boolean(f.inline) })),
        });
        syncInputs();
        channelField.hidden = true;
        pingHost.parentElement.hidden = true;
        sendBtn.replaceChildren(icon('check'), 'עדכן הודעה');
        sendBtn.disabled = !m.editable;
        put(clear(editActions), 
          h('button', { class: 'btn btn-secondary', type: 'button', onClick: addReaction }, 'הוסף ריאקציה'),
          h('button', { class: 'btn btn-danger', type: 'button', onClick: removeMessage }, icon('trash', { size: 16 }), 'מחק הודעה'),
        );
        toast(m.editable ? `נטענה הודעה מ-#${m.channelName}.` : 'ההודעה לא של הבוט, אז אי אפשר לערוך אותה. אפשר עדיין להוסיף ריאקציה או למחוק.', m.editable ? 'ok' : 'error');
      } catch (e) {
        toast(e.message, 'error');
      }
    });
  }

  async function removeMessage() {
    if (!edit || !(await confirmDialog({ title: 'למחוק את ההודעה?', body: 'אי אפשר לשחזר אותה. הפעולה תירשם ביומן.', confirmLabel: 'מחק', danger: true }))) return;
    try {
      await post('/api/messages/delete', { channelId: edit.channelId, messageId: edit.messageId });
      toast('ההודעה נמחקה.');
      setMode('edit');
      reset();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function addReaction() {
    const emoji = await modal(
      (close) => {
        const input = h('input', { class: 'input', placeholder: '👍', maxlength: '40', 'aria-label': 'אימוג׳י', dir: 'ltr' });
        return h('div', { class: 'dlg-body' }, h('h2', { class: 'dlg-title', text: 'הוספת ריאקציה' }), h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'אימוג׳י (או שם:מזהה לאימוג׳י של השרת)' }), input), h('div', { class: 'dlg-actions' }, h('button', { class: 'btn btn-primary', type: 'button', onClick: () => close(input.value.trim()) }, 'הוסף'), h('button', { class: 'btn btn-ghost', type: 'button', onClick: () => close(null) }, 'ביטול')));
      },
      { label: 'הוספת ריאקציה' },
    );
    if (!emoji) return;
    try {
      await post('/api/messages/react', { channelId: edit.channelId, messageId: edit.messageId, emoji });
      toast('הריאקציה נוספה.');
    } catch (e) {
      toast(e.message, 'error');
    }
  }
}
