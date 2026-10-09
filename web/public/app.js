import { get, post, setUnauthorizedHandler } from './lib/api.js';
import { clear, h, icon, put, skeleton, toast } from './lib/ui.js';

const app = document.getElementById('app');

/** Pages. `admin` pages are shown to everyone but can only be saved by admins; the server enforces it either way. */
const PAGES = [
  { id: 'home', label: 'סקירה', icon: 'home', load: () => import('./views/overview.js') },
  { id: 'announce', label: 'הכרזות והודעות', icon: 'megaphone', load: () => import('./views/announce.js') },
  { id: 'automod', label: 'אוטו-אדמין', icon: 'shield', load: () => import('./views/automod.js') },
  { id: 'members', label: 'חברים', icon: 'users', load: () => import('./views/members.js') },
  { id: 'build', label: 'ערוצים ורולים', icon: 'layers', load: () => import('./views/build.js') },
  { id: 'ranks', label: 'דרגות', icon: 'trophy', load: () => import('./views/ranks.js') },
  { id: 'log', label: 'יומן פעילות', icon: 'list', load: () => import('./views/log.js') },
];

const LOGIN_ERRORS = {
  'not-staff': 'החשבון הזה לא מוגדר כצוות בשרת. אם זו טעות, בקש מאדמין לתת לך את הרול Moderator.',
  denied: 'ביטלת את ההתחברות ב-Discord.',
  state: 'ההתחברות פגה או נפסקה באמצע. נסה שוב.',
  token: 'Discord לא אישר את ההתחברות. בדוק שה-Redirect URL מוגדר נכון בפורטל המפתחים.',
  user: 'לא הצלחנו לקרוא את פרטי החשבון מ-Discord. נסה שוב.',
};

export const state = { me: null, guild: null };

function renderLogin() {
  const error = new URLSearchParams(location.search).get('error');
  put(clear(app), 
    h(
      'main',
      { class: 'login', id: 'main' },
      h(
        'div',
        { class: 'card login-card' },
        h('img', { src: '/favicon.svg', alt: '' }),
        h('div', { class: 'stack' }, h('h1', { text: 'חדר הבקרה' }), h('p', { class: 'muted' }, 'הכניסה לצוות של ', h('bdi', { text: 'Steal an Alien' }), ' בלבד.')),
        error ? h('div', { class: 'banner banner-bad', role: 'alert' }, icon('alert'), h('p', { text: LOGIN_ERRORS[error] ?? 'ההתחברות נכשלה. נסה שוב.' })) : null,
        h('a', { class: 'btn btn-primary', href: '/api/auth/login' }, 'התחבר עם Discord'),
        h('p', { class: 'muted small' }, 'נבדק שיש לך רול צוות בשרת. ההרשאות מתעדכנות כל כמה דקות.'),
      ),
    ),
  );
  history.replaceState(null, '', location.pathname);
}

function currentPage() {
  const id = location.hash.replace(/^#\/?/, '') || 'home';
  return PAGES.find((p) => p.id === id) ?? PAGES[0];
}

function toggleTheme() {
  const dark = document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
  const next = dark ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem('saa-theme', next);
  } catch {
    /* storage blocked: the choice just lasts for this visit */
  }
}

async function logout() {
  try {
    await post('/api/auth/logout');
  } catch {
    /* even if the call fails, show the login screen */
  }
  state.me = null;
  renderLogin();
}

function renderShell() {
  const { me } = state;
  const nav = h(
    'nav',
    { class: 'nav', 'aria-label': 'ניווט ראשי' },
    PAGES.map((p) => h('a', { href: `#/${p.id}`, dataset: { page: p.id } }, icon(p.icon), h('span', { text: p.label }))),
  );
  const sidebar = h(
    'aside',
    { class: 'sidebar' },
    h('a', { class: 'brand', href: '#/home' }, h('img', { src: '/favicon.svg', alt: '' }), h('div', {}, h('div', { class: 'brand-name', text: 'חדר הבקרה' }), h('div', { class: 'brand-sub' }, h('bdi', { text: me.guild?.name ?? 'Steal an Alien' })))),
    nav,
    h(
      'div',
      { class: 'sidebar-foot' },
      h('div', { class: 'who' }, me.user.avatar ? h('img', { src: me.user.avatar, alt: '' }) : h('span', { class: 'avatar' }), h('div', { style: undefined }, h('div', { class: 'who-name' }, h('bdi', { text: me.user.name })), h('span', { class: `badge ${me.level === 'admin' ? 'badge-accent' : ''}`, text: me.level === 'admin' ? 'אדמין' : 'צוות' }))),
      h(
        'div',
        { class: 'row' },
        h('button', { class: 'btn btn-ghost btn-icon', type: 'button', 'aria-label': 'החלף בין מצב בהיר לכהה', onClick: toggleTheme }, icon('moon')),
        h('button', { class: 'btn btn-ghost btn-icon', type: 'button', 'aria-label': 'התנתק', onClick: logout }, icon('logout')),
      ),
    ),
  );
  put(clear(app), h('div', { class: 'shell' }, sidebar, h('main', { class: 'main', id: 'main', tabindex: '-1' })));
}

let renderToken = 0;
async function renderPage() {
  const page = currentPage();
  for (const a of document.querySelectorAll('.nav a')) {
    if (a.dataset.page === page.id) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  document.title = `${page.label} · חדר הבקרה של Steal an Alien`;
  const main = document.getElementById('main');
  const token = ++renderToken;
  put(clear(main), skeleton(4));
  try {
    const view = await page.load();
    if (token !== renderToken) return; // the person already moved on
    clear(main);
    await view.render(main, state);
    if (token === renderToken && document.activeElement === document.body) main.focus({ preventScroll: true });
  } catch (e) {
    if (token !== renderToken) return;
    put(clear(main), 
      h('div', { class: 'card' }, h('h2', { class: 'card-title', text: 'משהו השתבש בטעינת העמוד' }), h('p', { class: 'muted', dir: 'auto', text: e.message }), h('button', { class: 'btn btn-secondary', type: 'button', onClick: renderPage }, 'נסה שוב')),
    );
  }
}

async function start() {
  setUnauthorizedHandler(() => {
    if (state.me) {
      state.me = null;
      toast('ההתחברות פגה. התחבר שוב כדי להמשיך.', 'error');
      renderLogin();
    }
  });
  try {
    state.me = await get('/api/me');
  } catch (e) {
    if (e.status === 401 || e.status === 0 || e.status === 503) {
      if (e.status === 503) {
        put(clear(app), h('main', { class: 'login', id: 'main' }, h('div', { class: 'card login-card' }, h('h1', { text: 'האתר עוד לא מוגדר' }), h('p', { class: 'muted', dir: 'auto', text: e.message }))));
        return;
      }
      renderLogin();
      return;
    }
    throw e;
  }
  history.replaceState(null, '', location.pathname + location.hash);
  renderShell();
  window.addEventListener('hashchange', renderPage);
  await renderPage();
}

start().catch((e) => {
  put(clear(app), h('main', { class: 'login', id: 'main' }, h('div', { class: 'card login-card' }, h('h1', { text: 'משהו השתבש' }), h('p', { class: 'muted', dir: 'auto', text: e.message }))));
});
