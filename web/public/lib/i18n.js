// Two languages for the dashboard: Hebrew (default, right-to-left) and English (left-to-right).
// Texts live in public/i18n/<namespace>.js, each calling register('<namespace>', { he, en }).
// Use t('namespace.key') or t('namespace.key', { name: 'x' }) for "{name}" placeholders.

const dicts = { he: {}, en: {} };
const listeners = new Set();
let lang = 'he';

export const getLang = () => lang;
export const dirOf = (l) => (l === 'he' ? 'rtl' : 'ltr');
export const locale = () => (lang === 'he' ? 'he-IL' : 'en-US');

/** Adds the texts of one screen. Keys become "<ns>.<key>". */
export function register(ns, { he = {}, en = {} }) {
  for (const [k, v] of Object.entries(he)) dicts.he[`${ns}.${k}`] = v;
  for (const [k, v] of Object.entries(en)) dicts.en[`${ns}.${k}`] = v;
}

export function t(key, params) {
  let text = dicts[lang][key] ?? dicts.he[key] ?? dicts.en[key] ?? key;
  if (params) text = text.replace(/\{(\w+)\}/g, (match, name) => (params[name] ?? match));
  return text;
}

/** For tests: the raw dictionaries. */
export const allDictionaries = () => dicts;

function apply() {
  document.documentElement.lang = lang;
  document.documentElement.dir = dirOf(lang);
}

export function initLang() {
  let saved = null;
  try {
    saved = localStorage.getItem('saa-lang');
  } catch {
    /* storage blocked: use the browser language */
  }
  lang = saved === 'he' || saved === 'en' ? saved : navigator.language?.toLowerCase().startsWith('he') ? 'he' : 'en';
  apply();
}

export function setLang(next) {
  if (next !== 'he' && next !== 'en') return;
  lang = next;
  try {
    localStorage.setItem('saa-lang', next);
  } catch {
    /* storage blocked: the choice lasts for this visit */
  }
  apply();
  for (const fn of listeners) fn(next);
}

export function onLangChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
