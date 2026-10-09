// Small DOM helpers. Text always goes in as text nodes (never as HTML), so names and messages written by
// other people can never inject markup into the dashboard.

const BOOL_PROPS = new Set(['checked', 'disabled', 'selected', 'hidden', 'readOnly', 'required', 'open', 'multiple']);

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (BOOL_PROPS.has(key)) el[key] = value;
    else if (key === 'value') el.value = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/**
 * Appends children to an element: arrays are flattened and null/undefined/false are skipped.
 * (The browser's own append() turns an array or null into the text "[object ...]" / "null".)
 */
export function put(el, ...children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}
export const clear = (el) => {
  el.replaceChildren();
  return el;
};

// ---- icons (24x24, stroke) ----------------------------------------------------------------------------

const ICONS = {
  home: 'M3 11l9-8 9 8M5 10v10h14V10M9 20v-6h6v6',
  megaphone: 'M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1zM15 9a4 4 0 0 1 0 6M18 6a8 8 0 0 1 0 12',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3zM9 12l2 2 4-4',
  users: 'M16 20v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 20v-2a4 4 0 0 0-3-3.9M16 2.1a4 4 0 0 1 0 7.8',
  layers: 'M12 2l10 5-10 5L2 7l10-5zM2 12l10 5 10-5M2 17l10 5 10-5',
  trophy: 'M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4zM17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  send: 'M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z',
  alert: 'M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  check: 'M20 6L9 17l-5-5',
  x: 'M18 6L6 18M6 6l12 12',
  plus: 'M12 5v14M5 12h14',
  trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  link: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
  unlock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 7.5-2',
  external: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3',
  refresh: 'M23 4v6h-6M1 20v-6h6M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15',
  hash: 'M4 9h16M4 15h16M10 3L8 21M16 3l-2 18',
  volume: 'M11 5L6 9H2v6h4l5 4V5zM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z',
};

export function icon(name, { size = 20, label } = {}) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.classList.add('icon');
  if (label) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
  } else {
    svg.setAttribute('aria-hidden', 'true');
  }
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name] ?? ICONS.alert);
  svg.append(path);
  return svg;
}

// ---- time ---------------------------------------------------------------------------------------------

const rtf = new Intl.RelativeTimeFormat('he', { numeric: 'auto' });
export function ago(ts, now = Date.now()) {
  const s = Math.round((ts - now) / 1000);
  const abs = Math.abs(s);
  if (abs < 45) return 'ממש עכשיו';
  if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(s / 86400), 'day');
  return new Date(ts).toLocaleDateString('he-IL');
}

export const fullTime = (ts) => new Date(ts).toLocaleString('he-IL', { dateStyle: 'medium', timeStyle: 'short' });

// ---- feedback -----------------------------------------------------------------------------------------

export function toast(message, kind = 'ok') {
  const host = document.getElementById('toasts');
  const el = h('div', { class: `toast toast-${kind}`, role: kind === 'error' ? 'alert' : undefined }, icon(kind === 'error' ? 'alert' : 'check', { size: 18 }), h('span', { dir: 'auto', text: message }));
  host.append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 8000 : 4500);
}

/** Opens a modal built from `render(close)` and resolves with whatever `close(value)` is called with. */
export function modal(render, { label }) {
  return new Promise((resolve) => {
    const dialog = h('dialog', { class: 'dlg', 'aria-label': label });
    const close = (value) => {
      dialog.close();
      dialog.remove();
      resolve(value);
    };
    dialog.append(render(close));
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      close(undefined);
    });
    document.body.append(dialog);
    dialog.showModal();
  });
}

/**
 * Confirmation dialog. With `typeToConfirm` the person must type that exact text first (for deletions).
 * @returns Promise<boolean>
 */
export function confirmDialog({ title, body, confirmLabel = 'אישור', danger = false, typeToConfirm = null }) {
  return modal(
    (close) => {
      const input = typeToConfirm ? h('input', { class: 'input', dir: 'auto', autocomplete: 'off', 'aria-label': 'הקלד לאישור' }) : null;
      const ok = h('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, type: 'button', disabled: Boolean(typeToConfirm), onClick: () => close(true) }, confirmLabel);
      if (input) input.addEventListener('input', () => (ok.disabled = input.value !== typeToConfirm));
      return h(
        'div',
        { class: 'dlg-body' },
        h('h2', { class: 'dlg-title', text: title }),
        body ? h('p', { class: 'dlg-text', dir: 'auto' }, body) : null,
        typeToConfirm ? h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'כדי לאשר, הקלד: ', h('bdi', { class: 'mono', text: typeToConfirm })), input) : null,
        h('div', { class: 'dlg-actions' }, ok, h('button', { class: 'btn btn-ghost', type: 'button', onClick: () => close(false) }, 'ביטול')),
      );
    },
    { label: title },
  ).then(Boolean);
}

/** Runs an async action on a button: disables it, shows a busy label, reports errors as a toast. */
export async function busy(button, label, fn) {
  const original = button.textContent;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  if (label) button.textContent = label;
  try {
    return await fn();
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.textContent = original;
  }
}

export const debounce = (fn, ms) => {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
};

export const skeleton = (lines = 3) => h('div', { class: 'skeleton-block', 'aria-hidden': 'true' }, Array.from({ length: lines }, () => h('div', { class: 'skeleton' })));

export const emptyState = (title, text, action) => h('div', { class: 'empty' }, h('p', { class: 'empty-title', text: title }), text ? h('p', { class: 'muted', text }) : null, action ?? null);
