import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { checkSync } from '../../scripts/sync-shared.js';
import { LIMITS, RULE_PREFIX, SCAM_PATTERNS, INVITE_PATTERNS, buildRules, cleanKeyword, diffRules, syncAutoModRules } from '../../shared/automodRules.js';
import { FileKv, KEYS, UpstashKv, kvFromEnv } from '../../shared/kv.js';
import { computeLevel, hasLevel } from '../../shared/permissions.js';
import { DEFAULT_SETTINGS, normalizeSettings } from '../../shared/settings.js';

const dirs = [];
const tempFile = () => {
  const dir = mkdtempSync(join(tmpdir(), 'saa-kv-'));
  dirs.push(dir);
  return join(dir, 'kv.json');
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

test('shared copies in bot/ and web/ are identical to /shared', () => {
  assert.deepEqual(checkSync(), []);
});

// ---- KV ---------------------------------------------------------------------------------------

test('FileKv: get/set/del/push/list with cap and newest-first order', async () => {
  const kv = new FileKv(tempFile());
  assert.equal(await kv.get('missing'), null);
  await kv.set('a', { x: 1 });
  const got = await kv.get('a');
  got.x = 99;
  assert.deepEqual(await kv.get('a'), { x: 1 }, 'returns copies, not references');
  await kv.del('a');
  assert.equal(await kv.get('a'), null);
  for (let i = 1; i <= 5; i++) await kv.push('log', { i }, 3);
  assert.deepEqual((await kv.list('log', 10)).map((e) => e.i), [5, 4, 3]);
  assert.deepEqual((await kv.list('log', 2)).map((e) => e.i), [5, 4]);
  assert.deepEqual(await kv.list('nothing'), []);
});

test('FileKv: survives a restart and moves a corrupt file aside', async () => {
  const file = tempFile();
  const first = new FileKv(file);
  await first.set('k', [1, 2]);
  first.flush();
  assert.deepEqual(await new FileKv(file).get('k'), [1, 2]);
  writeFileSync(file, '{broken', 'utf8');
  const second = new FileKv(file);
  assert.equal(await second.get('k'), null);
});

function fakeUpstash(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, auth: init.headers.Authorization, body });
    const { status = 200, json } = handler(url, body);
    return { ok: status < 400, status, json: async () => json };
  };
  return { kv: new UpstashKv('https://redis.example.com/', 'secret-token', fetchImpl), calls };
}

test('UpstashKv: sends the right commands and parses JSON values', async () => {
  const store = new Map();
  const { kv, calls } = fakeUpstash((url, body) => {
    if (url.endsWith('/pipeline')) return { json: body.map(() => ({ result: 1 })) };
    const [cmd, key, value] = body;
    if (cmd === 'SET') store.set(key, value);
    if (cmd === 'DEL') store.delete(key);
    if (cmd === 'GET') return { json: { result: store.get(key) ?? null } };
    if (cmd === 'LRANGE') return { json: { result: ['{"i":2}', '{"i":1}'] } };
    return { json: { result: 'OK' } };
  });
  await kv.set('k', { a: 1 });
  assert.deepEqual(await kv.get('k'), { a: 1 });
  assert.equal(await kv.get('absent'), null);
  await kv.push('l', { i: 3 }, 10);
  assert.deepEqual(await kv.list('l', 2), [{ i: 2 }, { i: 1 }]);
  await kv.del('k');

  assert.equal(calls[0].url, 'https://redis.example.com', 'trailing slash trimmed');
  assert.equal(calls[0].auth, 'Bearer secret-token');
  assert.deepEqual(calls[0].body, ['SET', 'k', '{"a":1}']);
  const push = calls.find((c) => c.url.endsWith('/pipeline'));
  assert.deepEqual(push.body, [['LPUSH', 'l', '{"i":3}'], ['LTRIM', 'l', 0, 9]]);
  assert.deepEqual(calls.find((c) => c.body[0] === 'LRANGE').body, ['LRANGE', 'l', 0, 1]);
});

test('UpstashKv: HTTP errors and {error} replies throw readable errors', async () => {
  const bad = fakeUpstash(() => ({ status: 401, json: { error: 'WRONGPASS invalid token' } })).kv;
  await assert.rejects(() => bad.get('k'), /401.*WRONGPASS/);
  const err = fakeUpstash(() => ({ json: { error: 'ERR something' } })).kv;
  await assert.rejects(() => err.set('k', 1), /ERR something/);
  const pipe = fakeUpstash(() => ({ json: [{ result: 1 }, { error: 'ERR trim' }] })).kv;
  await assert.rejects(() => pipe.push('l', 1), /ERR trim/);
});

test('kvFromEnv picks Upstash, Vercel KV names, the file fallback, or nothing', () => {
  assert.equal(kvFromEnv({ UPSTASH_REDIS_REST_URL: 'https://x', UPSTASH_REDIS_REST_TOKEN: 't' }).kind, 'upstash');
  assert.equal(kvFromEnv({ KV_REST_API_URL: 'https://x', KV_REST_API_TOKEN: 't' }).kind, 'upstash');
  assert.equal(kvFromEnv({}, { file: tempFile() }).kind, 'file');
  assert.equal(kvFromEnv({}), null);
  assert.equal(kvFromEnv({ UPSTASH_REDIS_REST_URL: 'https://x' }), null, 'url without token is not enough');
});

test('KEYS: per-user key is namespaced by guild and user', () => {
  assert.equal(KEYS.warns('g1', 'u1'), 'saa:warns:g1:u1');
  assert.notEqual(KEYS.warns('g1', 'u1'), KEYS.warns('g2', 'u1'));
});

// ---- settings ---------------------------------------------------------------------------------

test('normalizeSettings({}) equals the defaults and is idempotent', () => {
  const n = normalizeSettings({});
  assert.deepEqual(n, JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));
  assert.deepEqual(normalizeSettings(n), n);
});

test('normalizeSettings: garbage input falls back to defaults', () => {
  for (const bad of [null, undefined, 5, 'x', [], [1, 2], { automod: 'no', raid: [], logs: 7 }]) {
    assert.deepEqual(normalizeSettings(bad), normalizeSettings({}), JSON.stringify(bad));
  }
});

test('normalizeSettings: clamps numbers, filters lists and drops unknown keys', () => {
  const n = normalizeSettings({
    evil: '<script>',
    automod: {
      mentions: { limit: 9999, timeoutMinutes: -5 },
      flood: { messages: 1, seconds: 'abc' },
      customWords: { enabled: true, words: ['  Bad ', 'bad', '', 'x'.repeat(61), 42, 'ok'] },
      badWords: { presets: ['slurs', 'nonsense'] },
      blockMessage: 'y'.repeat(500),
      exemptRoles: ['Mod', 'Mod', ''],
    },
    raid: { joins: 0, action: 'explode', minAccountAgeDays: 9999 },
  });
  assert.equal(n.evil, undefined);
  assert.equal(n.automod.mentions.limit, 50);
  assert.equal(n.automod.mentions.timeoutMinutes, 0);
  assert.equal(n.automod.flood.messages, 3);
  assert.equal(n.automod.flood.seconds, DEFAULT_SETTINGS.automod.flood.seconds);
  assert.deepEqual(n.automod.customWords.words, ['bad', 'ok']);
  assert.deepEqual(n.automod.badWords.presets, ['slurs']);
  assert.equal(n.automod.blockMessage.length, 150);
  assert.deepEqual(n.automod.exemptRoles, ['Mod']);
  assert.equal(n.raid.joins, 3);
  assert.equal(n.raid.action, DEFAULT_SETTINGS.raid.action);
  assert.equal(n.raid.minAccountAgeDays, 365);
});

test('normalizeSettings: warn escalation is sorted, deduplicated and validated', () => {
  const n = normalizeSettings({
    automod: {
      warns: {
        escalation: [
          { at: 5, action: 'kick' },
          { at: 3, action: 'timeout', minutes: 99999 },
          { at: 3, action: 'ban' },
          { at: 0, action: 'ban' },
          { at: 4, action: 'nuke' },
          'garbage',
        ],
      },
    },
  });
  assert.deepEqual(n.automod.warns.escalation, [{ at: 3, action: 'timeout', minutes: 40320 }, { at: 5, action: 'kick' }]);
  assert.deepEqual(normalizeSettings({ automod: { warns: { escalation: [] } } }).automod.warns.escalation, [], 'empty list is allowed (escalation off)');
});

test('normalizeSettings: fuzzed input always yields valid, idempotent settings', () => {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const pool = [null, undefined, true, false, 0, -1, 7, 1e9, NaN, 'a', '', 'timeout', [], {}, [1, 'x'], { at: 2, action: 'kick' }];
  const pick = () => pool[Math.floor(rnd() * pool.length)];
  const fuzz = (depth) => {
    if (depth === 0 || rnd() < 0.3) return pick();
    const obj = {};
    for (const k of ['automod', 'raid', 'logs', 'enabled', 'limit', 'messages', 'words', 'presets', 'escalation', 'mode', 'action', 'allow', 'warns', 'mentions', 'flood', 'at', 'minutes', 'gate']) {
      if (rnd() < 0.35) obj[k] = fuzz(depth - 1);
    }
    return obj;
  };
  for (let i = 0; i < 500; i++) {
    const n = normalizeSettings(fuzz(4));
    assert.deepEqual(normalizeSettings(n), n, `not idempotent for case ${i}`);
    assert.ok(n.automod.mentions.limit >= 2 && n.automod.mentions.limit <= 50);
    assert.ok(n.raid.joins >= 3 && n.raid.joins <= 100);
    assert.ok(n.automod.blockMessage.length >= 1 && n.automod.blockMessage.length <= 150);
    assert.ok(n.automod.warns.escalation.length <= 6);
  }
});

// ---- AutoMod rules ----------------------------------------------------------------------------

const ctx = { alertChannelId: 'chan1', exemptRoleIds: ['r1', 'r2'] };

test('buildRules: default settings give the expected set, all within Discord limits', () => {
  const rules = buildRules(normalizeSettings({}), ctx);
  assert.deepEqual(rules.map((r) => r.name), ['Spam', 'Mention spam', 'Bad words', 'Invites', 'Scams'].map((n) => RULE_PREFIX + n));
  assert.equal(rules.filter((r) => r.trigger_type === 1).length <= 6, true, 'max 6 keyword rules per guild');
  for (const kind of [3, 4, 5]) assert.ok(rules.filter((r) => r.trigger_type === kind).length <= 1, `max 1 of type ${kind}`);
  for (const r of rules) {
    assert.ok(r.name.length <= 100);
    assert.ok(r.exempt_roles.length <= 20);
    const m = r.trigger_metadata;
    assert.ok((m.regex_patterns ?? []).length <= 10);
    for (const p of m.regex_patterns ?? []) assert.ok(p.length <= 260, p);
    assert.ok((m.keyword_filter ?? []).length <= 1000);
    for (const a of r.actions) {
      if (a.type === 1) assert.ok(a.metadata.custom_message.length <= 150);
      if (a.type === 2) assert.equal(a.metadata.channel_id, 'chan1');
    }
  }
});

test('buildRules: timeout only on the mention rule; alert only with a channel; off means no rules', () => {
  const rules = buildRules(normalizeSettings({}), ctx);
  for (const r of rules) {
    const hasTimeout = r.actions.some((a) => a.type === 3);
    assert.equal(hasTimeout, r.trigger_type === 5, r.name);
  }
  const noAlert = buildRules(normalizeSettings({}), { exemptRoleIds: [] });
  assert.ok(noAlert.every((r) => r.actions.every((a) => a.type !== 2)));
  assert.deepEqual(buildRules(normalizeSettings({ automod: { enabled: false } }), ctx), []);
  const noTimeout = buildRules(normalizeSettings({ automod: { mentions: { timeoutMinutes: 0 } } }), ctx);
  assert.ok(noTimeout.every((r) => r.actions.every((a) => a.type !== 3)));
});

test('buildRules: custom words and presets only produce a rule when there is something to match', () => {
  const none = buildRules(normalizeSettings({ automod: { customWords: { enabled: true, words: [] }, badWords: { presets: [] } } }), ctx);
  assert.ok(!none.some((r) => r.name.endsWith('Custom words') || r.name.endsWith('Bad words')));
  const some = buildRules(normalizeSettings({ automod: { customWords: { enabled: true, words: ['foo*'] } } }), ctx);
  assert.deepEqual(some.find((r) => r.name.endsWith('Custom words')).trigger_metadata.keyword_filter, ['foo*']);
});

// Discord uses a Rust regex engine: no lookaround, no backreferences. JS cannot parse inline (?i), so test with the flag.
const toJs = (p) => new RegExp(p.replace(/^\(\?i\)/, ''), 'i');

test('scam and invite patterns are valid Rust-flavoured regex within Discord limits', () => {
  for (const p of [...SCAM_PATTERNS, ...INVITE_PATTERNS]) {
    assert.doesNotMatch(p, /\(\?[=!<]|\\[1-9]/, `unsupported syntax in ${p}`);
    assert.doesNotThrow(() => toJs(p));
    assert.ok(p.length <= LIMITS.regexLength, `longer than 260 chars: ${p}`);
  }
  assert.ok(SCAM_PATTERNS.length <= LIMITS.regexPatterns && INVITE_PATTERNS.length <= LIMITS.regexPatterns);
});

// [text, should be flagged]. Scam texts are realistic Roblox/Discord scams; the harmless ones are kids' real sentences.
const SCAM_CASES = [
  ['FREE ROBUX HERE, click the link', true],
  ['free robux generator 2026 no survey', true],
  ['robux giveaway!! type claim in dms', true],
  ['get free robux now at my site', true],
  ['Claim your free limiteds before they are gone', true],
  ['claim your reward at roblox-rewards.xyz', true],
  ['steam gift for you: steamcommunity.com/gift/abc123', true],
  ['click bit.ly/3xYzA to get it', true],
  ['https://discord.gift/AbCdEf123 free nitro', true],
  ['Free discord nitro for everyone, hurry', true],
  ['roblox-free-robux.com is legit, login there', true],
  ['I got free robux from a game event', false],
  ['robux', false],
  ['I want to buy robux with my allowance', false],
  ['the alien was free to steal', false],
  ['claim your reward at the end of the quest', false],
  ['roblox.com/games/123 is my favorite game', false],
  ['nitro boost is cool, I want nitro someday', false],
  ['my bit.ly link is broken, sorry', false],
  ['https://discord.com/channels/1/2 is the channel link', false],
  ['what is the free robux glitch?', false],
];

test('scam patterns: realistic scams are flagged, kids\' harmless sentences are not', () => {
  const flags = (text) => SCAM_PATTERNS.some((p) => toJs(p).test(text));
  for (const [text, bad] of SCAM_CASES) assert.equal(flags(text), bad, `${bad ? 'should flag' : 'should not flag'}: ${text}`);
  assert.ok(SCAM_CASES.filter(([, bad]) => bad).length >= 5 && SCAM_CASES.filter(([, bad]) => !bad).length >= 5);
});

test('every scam pattern is exercised by at least one positive case (no dead patterns)', () => {
  const positives = SCAM_CASES.filter(([, bad]) => bad).map(([t]) => t);
  for (const p of SCAM_PATTERNS) assert.ok(positives.some((t) => toJs(p).test(t)), `no positive case matches ${p}`);
});

test('invite patterns: invites flagged, ordinary discord.com pages not', () => {
  const any = (patterns, text) => patterns.some((p) => toJs(p).test(text));
  for (const bad of ['join discord.gg/abcDEF', 'https://discord.com/invite/xyz', 'dsc.gg/thing', 'DISCORD.GG/ABC', 'come to discordapp.com/invite/k9']) {
    assert.ok(any(INVITE_PATTERNS, bad), bad);
  }
  for (const ok of ['https://discord.com/channels/1/2', 'discord is nice', 'support.discord.com/hc/en-us', 'discord.gg']) assert.ok(!any(INVITE_PATTERNS, ok), ok);
});

test('cleanKeyword: wildcards only at the edges; words that cannot be expressed are dropped', () => {
  assert.equal(cleanKeyword('*'), null, '"*" alone would block every message');
  assert.equal(cleanKeyword(' ** '), null);
  assert.equal(cleanKeyword('f*o'), null, 'a wildcard in the middle is not valid Discord syntax');
  assert.equal(cleanKeyword('*'.repeat(3) + 'x'.repeat(61)), null, 'too long');
  assert.equal(cleanKeyword(42), null);
  assert.equal(cleanKeyword('*cat*'), '*cat*');
  assert.equal(cleanKeyword('**cat**'), '*cat*', 'runs of wildcards collapse to one');
  assert.equal(cleanKeyword('  Bad Word  '), 'bad word', 'trimmed and lower-cased');
  assert.equal(cleanKeyword('cat*'), 'cat*');
});

test('buildRules never sends a keyword Discord would reject, even from unnormalised settings', () => {
  const raw = structuredClone(normalizeSettings({ automod: { customWords: { enabled: true } } }));
  raw.automod.customWords.words = ['*', 'f*o', 'ok', 'x'.repeat(61), '*bad*', 'ok'];
  const rule = buildRules(raw, ctx).find((r) => r.name.endsWith('Custom words'));
  assert.deepEqual(rule.trigger_metadata.keyword_filter, ['ok', '*bad*']);
  assert.deepEqual(normalizeSettings({ automod: { customWords: { enabled: true, words: ['*', 'mid*dle', '*ok*'] } } }).automod.customWords.words, ['*ok*']);
});

test('buildRules clamps every value to Discord limits, even when the settings are out of range', () => {
  const raw = structuredClone(normalizeSettings({}));
  raw.automod.badWords.allow = Array.from({ length: 150 }, (_, i) => `word${i}`);
  raw.automod.blockMessage = 'y'.repeat(400);
  raw.automod.mentions.timeoutMinutes = 999_999;
  raw.automod.mentions.limit = 999;
  const many = Array.from({ length: 30 }, (_, i) => `${i + 100}`);
  const rules = buildRules(raw, { alertChannelId: 'alert', exemptRoleIds: many, exemptChannelIds: [...many, ...many, ...Array.from({ length: 40 }, (_, i) => `c${i}`)] });
  for (const r of rules) {
    assert.ok(r.exempt_roles.length <= LIMITS.exemptRoles, r.name);
    assert.ok(r.exempt_channels.length <= LIMITS.exemptChannels, r.name);
    assert.equal(new Set(r.exempt_channels).size, r.exempt_channels.length, 'no duplicate channel ids');
    for (const a of r.actions) {
      if (a.type === 1) assert.ok(a.metadata.custom_message.length <= LIMITS.customMessage);
      if (a.type === 3) assert.equal(a.metadata.duration_seconds, LIMITS.timeoutSeconds, 'at most 4 weeks');
    }
  }
  const presetRule = rules.find((r) => r.trigger_type === 4);
  assert.equal(presetRule.trigger_metadata.allow_list.length, LIMITS.allowList);
  const mention = rules.find((r) => r.trigger_type === 5);
  assert.equal(mention.trigger_metadata.mention_total_limit, 50);
  assert.equal(buildRules({ ...raw, automod: { ...raw.automod, mentions: { ...raw.automod.mentions, limit: -4 } } }, ctx).find((r) => r.trigger_type === 5).trigger_metadata.mention_total_limit, 1);
});

test('buildRules: exempt channels are passed to every rule, de-duplicated and capped at 50', () => {
  const s = normalizeSettings({});
  const withStaff = buildRules(s, { alertChannelId: 'alert', exemptRoleIds: [], exemptChannelIds: ['mod', 'staff', 'mod'] });
  for (const r of withStaff) assert.deepEqual(r.exempt_channels, ['mod', 'staff'], r.name);
  assert.ok(buildRules(s, ctx).every((r) => r.exempt_channels.length === 0), 'no channels by default');
});

test('defaults never kick or ban: warnings only lead to timeouts unless the owner opts in', () => {
  assert.ok(DEFAULT_SETTINGS.automod.warns.escalation.length > 0);
  assert.ok(DEFAULT_SETTINGS.automod.warns.escalation.every((s) => s.action === 'timeout'));
  assert.equal(DEFAULT_SETTINGS.raid.accountAgeAction, 'none');
  assert.equal(DEFAULT_SETTINGS.raid.gate, false);
});

test('diffRules: creates missing, patches existing without trigger_type, removes stale, ignores foreign rules', () => {
  const desired = buildRules(normalizeSettings({}), ctx);
  const existing = [
    { id: '1', name: `${RULE_PREFIX}Spam` },
    { id: '2', name: `${RULE_PREFIX}Old rule we no longer want` },
    { id: '3', name: 'Carl-bot filter' },
  ];
  const { create, update, remove } = diffRules(existing, desired);
  assert.deepEqual(update.map((u) => u.id), ['1']);
  assert.equal('trigger_type' in update[0].patch, false);
  assert.deepEqual(remove, [{ id: '2', name: `${RULE_PREFIX}Old rule we no longer want` }]);
  assert.equal(create.length, desired.length - 1);
  assert.ok(![...create, ...update, ...remove].some((x) => x.id === '3' || x.name === 'Carl-bot filter'));
});

test('syncAutoModRules: applies the diff and reports a failing rule without stopping the rest', async () => {
  const calls = [];
  const rest = async (method, path, body) => {
    calls.push(`${method} ${path}`);
    if (method === 'GET') return [{ id: 'old', name: `${RULE_PREFIX}Gone` }];
    if (method === 'POST' && body.name.endsWith('Scams')) throw new Error('Maximum number of rules reached');
    return {};
  };
  const desired = buildRules(normalizeSettings({}), ctx);
  const summary = await syncAutoModRules(rest, 'G', desired);
  assert.equal(summary.errors.length, 1);
  assert.match(summary.errors[0], /Scams.*Maximum number/);
  assert.equal(summary.created.length, desired.length - 1);
  assert.deepEqual(summary.removed, [`${RULE_PREFIX}Gone`]);
  assert.ok(calls.includes('DELETE /guilds/G/auto-moderation/rules/old'));
  assert.equal(calls[0], 'GET /guilds/G/auto-moderation/rules');
});

// ---- permissions ------------------------------------------------------------------------------

const role = (id, name, permissions = '0') => ({ id, name, permissions });
const guildRoles = [
  role('G', '@everyone', '1024'),
  role('r-owner', '👑 Owner'),
  role('r-admin', 'Admin'),
  role('r-mod', 'Moderator'),
  role('r-dev', 'Developer'),
  role('r-perm-admin', 'Boss', '8'),
  role('r-perm-msg', 'Janitor', String(0x2000)),
  role('r-bad', 'Weird', 'not-a-number'),
];
const level = (userId, ...roleIds) => computeLevel({ guildId: 'G', ownerId: 'OWNER', userId, memberRoleIds: roleIds, guildRoles });

test('computeLevel: owner, Administrator permission and Admin/Owner roles are admin', () => {
  assert.equal(level('OWNER'), 'admin');
  assert.equal(level('u', 'r-owner'), 'admin');
  assert.equal(level('u', 'r-admin'), 'admin');
  assert.equal(level('u', 'r-perm-admin'), 'admin');
});

test('computeLevel: Moderator role or Manage Messages is staff; everyone else gets nothing', () => {
  assert.equal(level('u', 'r-mod'), 'staff');
  assert.equal(level('u', 'r-perm-msg'), 'staff');
  assert.equal(level('u'), null);
  assert.equal(level('u', 'r-dev'), null);
  assert.equal(level('u', 'r-bad'), null, 'malformed permission value is ignored');
  assert.equal(level('u', 'r-mod', 'r-admin'), 'admin', 'highest wins');
});

test('hasLevel orders admin above staff and rejects unknown levels', () => {
  assert.ok(hasLevel('admin', 'staff') && hasLevel('admin', 'admin') && hasLevel('staff', 'staff'));
  assert.ok(!hasLevel('staff', 'admin') && !hasLevel(null, 'staff') && !hasLevel('admin', 'nonsense'));
});
