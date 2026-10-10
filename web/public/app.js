import './i18n/core.js';
import { get, post, setUnauthorizedHandler } from './lib/api.js';
import { getLang, initLang, onLangChange, setLang, t } from './lib/i18n.js';
import { clear, h, icon, put, skeleton, toast } from './lib/ui.js';

const app = document.getElementById('app');
initLang();

/**
 * Pages. Each view registers its own texts (public/i18n/<id>.js) when it is loaded.
 * `admin` pages are shown to everyone but can only be saved by admins; the server enforces it either way.
 */
const PAGES = [
  { id: 'home', icon: 'home', load: () => import('./views/overview.js') },
  { id: 'announce', icon: 'megaphone', load: () => import('./views/announce.js') },
  { id: 'automod', icon: 'shield', load: () => import('./views/automod.js') },
  { id: 'members', icon: 'users', load: () => import('./views/members.js') },
  { id: 'build', icon: 'layers', load: () => import('./views/build.js') },
  { id: 'ranks', icon: 'trophy', load: () => import('./views/ranks.js') },
  { id: 'log', icon: 'list', load: () => import('./views/log.js') },
];
const pageLabel = (id) => t(`app.nav.${id}`);

export const state = { me: null };

function renderLogin() {
  const error = new URLSearchParams(location.search).get('error');
  const errorText = error ? (t(`app.login.error.${error}`).startsWith('app.login.error.') ? t('app.login.error.default') : t(`app.login.error.${error}`)) : null;
  put(
    clear(app),
    h(
      'main',
      { class: 'login', id: 'main' },
      h(
        'div',
        { class: 'card login-card' },
        h('img', { src: '/favicon.svg', alt: '' }),
        h('div', { class: 'stack' }, h('h1', { text: t('app.login.title') }), h('p', { class: 'muted', dir: 'auto', text: t('app.login.lead', { name: 'Steal an Alien' }) })),
        errorText ? h('div', { class: 'banner banner-bad', role: 'alert' }, icon('alert'), h('p', { text: errorText })) : null,
        h('a', { class: 'btn btn-primary', href: '/api/auth/login' }, t('app.login.button')),
        h('p', { class: 'muted small', text: t('app.login.note') }),
        h('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'aria-label': t('app.language.label'), onClick: () => setLang(getLang() === 'he' ? 'en' : 'he') }, t('app.language')),
      ),
    ),
  );
  document.title = t('app.title');
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
  document.querySelector('.skip-link').textContent = t('app.skip');
  const nav = h(
    'nav',
    { class: 'nav', 'aria-label': t('app.nav.label') },
    PAGES.map((p) => h('a', { href: `#/${p.id}`, dataset: { page: p.id } }, icon(p.icon), h('span', { text: pageLabel(p.id) }))),
  );
  const sidebar = h(
    'aside',
    { class: 'sidebar' },
    h('a', { class: 'brand', href: '#/home' }, h('img', { src: '/favicon.svg', alt: '' }), h('div', {}, h('div', { class: 'brand-name', text: t('app.brand') }), h('div', { class: 'brand-sub' }, h('bdi', { text: me.guild?.name ?? 'Steal an Alien' })))),
    nav,
    h(
      'div',
      { class: 'sidebar-foot' },
      h('div', { class: 'who' }, me.user.avatar ? h('img', { src: me.user.avatar, alt: '' }) : h('span', { class: 'avatar' }), h('div', {}, h('div', { class: 'who-name' }, h('bdi', { text: me.user.name })), h('span', { class: `badge ${me.level === 'admin' ? 'badge-accent' : ''}`, text: t(`app.level.${me.level}`) }))),
      h(
        'div',
        { class: 'row' },
        h('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'aria-label': t('app.language.label'), onClick: () => setLang(getLang() === 'he' ? 'en' : 'he') }, t('app.language')),
        h('button', { class: 'btn btn-ghost btn-icon', type: 'button', 'aria-label': t('app.theme'), onClick: toggleTheme }, icon('moon')),
        h('button', { class: 'btn btn-ghost btn-icon', type: 'button', 'aria-label': t('app.logout'), onClick: logout }, icon('logout')),
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
  document.title = `${pageLabel(page.id)} · ${t('app.title')}`;
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
    put(
      clear(main),
      h('div', { class: 'card' }, h('h2', { class: 'card-title', text: t('app.page.failed') }), h('p', { class: 'muted', dir: 'auto', text: e.message }), h('button', { class: 'btn btn-secondary', type: 'button', onClick: renderPage }, t('app.retry'))),
    );
  }
}

async function start() {
  setUnauthorizedHandler(() => {
    if (state.me) {
      state.me = null;
      toast(t('app.expired'), 'error');
      renderLogin();
    }
  });
  // switching language redraws everything in place
  onLangChange(() => {
    if (state.me) {
      renderShell();
      renderPage();
    } else {
      renderLogin();
    }
  });
  try {
    state.me = await get('/api/me');
  } catch (e) {
    if (e.status === 503) {
      put(clear(app), h('main', { class: 'login', id: 'main' }, h('div', { class: 'card login-card' }, h('h1', { text: t('app.setup.title') }), h('p', { class: 'muted', dir: 'auto', text: e.message }))));
      return;
    }
    if (e.status === 401 || e.status === 0) {
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
  put(clear(app), h('main', { class: 'login', id: 'main' }, h('div', { class: 'card login-card' }, h('h1', { text: t('app.error.title') }), h('p', { class: 'muted', dir: 'auto', text: e.message }))));
});
