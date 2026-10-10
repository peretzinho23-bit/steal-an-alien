import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = fileURLToPath(new URL('../public/i18n/', import.meta.url));
const { allDictionaries, t } = await import('../public/lib/i18n.js');
for (const f of readdirSync(dir).filter((n) => n.endsWith('.js'))) await import(pathToFileURL(dir + f).href);

const { he, en } = allDictionaries();
const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

test('Hebrew and English have exactly the same keys', () => {
  const onlyHe = Object.keys(he).filter((k) => !(k in en));
  const onlyEn = Object.keys(en).filter((k) => !(k in he));
  assert.deepEqual(onlyHe, [], `missing in English: ${onlyHe.slice(0, 10).join(', ')}`);
  assert.deepEqual(onlyEn, [], `missing in Hebrew: ${onlyEn.slice(0, 10).join(', ')}`);
});

test('every text is a non-empty string and both languages use the same {placeholders}', () => {
  for (const key of Object.keys(he)) {
    assert.ok(typeof he[key] === 'string' && he[key].trim(), `empty Hebrew text: ${key}`);
    assert.ok(typeof en[key] === 'string' && en[key].trim(), `empty English text: ${key}`);
    assert.equal(placeholders(he[key]), placeholders(en[key]), `placeholders differ in ${key}`);
  }
});

test('English texts contain no Hebrew letters (except each language name in its own language)', () => {
  const OWN_LANGUAGE_NAME = new Set(['app.language', 'app.language.label']);
  for (const [key, text] of Object.entries(en)) {
    if (!OWN_LANGUAGE_NAME.has(key)) assert.doesNotMatch(text, /[\u0590-\u05ff]/, `Hebrew letters in English text: ${key}`);
  }
});

test('Hebrew texts that are word for word the English ones are only allowed for names and technical terms', () => {
  const allowed = /^(Discord|Redis|Upstash|Embed|XP|AutoMod|Timeout|Kick|Ban|https:\/\/|@everyone|mod-log|[\W\d]*)$/i;
  const same = Object.keys(he).filter((k) => he[k] === en[k] && !allowed.test(he[k].trim()));
  assert.deepEqual(same, [], `untranslated Hebrew texts: ${same.slice(0, 8).join(', ')}`);
});
test('t() fills placeholders and falls back to the key itself for unknown texts', () => {
  assert.equal(t('does.not.exist'), 'does.not.exist');
  const withParam = Object.keys(en).find((k) => /\{(\w+)\}/.test(en[k]));
  if (withParam) assert.doesNotMatch(t(withParam, Object.fromEntries([...en[withParam].matchAll(/\{(\w+)\}/g)].map((m) => [m[1], 'X']))), /\{\w+\}/);
});
