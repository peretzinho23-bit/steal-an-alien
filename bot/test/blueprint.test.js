import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PermissionFlagsBits as P } from 'discord.js';
import { CATEGORIES, ORIGINAL_CHANNEL_NAMES, ROLES, STAFF, allChannels } from '../src/blueprint.js';
import { buildOverwrites, isOwnerRole } from '../src/setup.js';

test('the Owner role is recognised with or without an emoji, and nothing else is', () => {
  for (const name of ['Owner', '👑 Owner', 'owner', 'Server Owner']) assert.ok(isOwnerRole({ name }), name);
  for (const name of ['Co-founder', 'Designer', 'Ownership team?', 'Admin']) assert.ok(!isOwnerRole({ name }), name);
});

const roleIds = { admin: 'A', mod: 'M', dev: 'D', tester: 'T', member: 'U' };
const ctx = { roleIds, everyoneId: 'E', botId: 'B' };
const lower = (s) => s.toLowerCase();

test('every channel from the original server screenshot is in the blueprint', () => {
  const names = new Set(allChannels().map((c) => lower(c.name)));
  for (const original of ORIGINAL_CHANNEL_NAMES) assert.ok(names.has(lower(original)), `missing: ${original}`);
});

test('original categories are all present', () => {
  const names = CATEGORIES.map((c) => c.name);
  for (const wanted of ['Text Channels', 'Voice Channels', '📢 INFO', '🎮 GAME', '🎫 SUPPORT']) {
    assert.ok(names.includes(wanted), `missing category ${wanted}`);
  }
});

test('channel keys and names are unique and within Discord limits', () => {
  const channels = allChannels();
  assert.equal(new Set(channels.map((c) => c.key)).size, channels.length, 'duplicate key');
  // text "general" and voice "General" coexist in the original server, so uniqueness is per channel type
  assert.equal(new Set(channels.map((c) => `${c.type}:${lower(c.name)}`)).size, channels.length, 'duplicate name');
  for (const c of channels) {
    assert.ok(c.name.length >= 1 && c.name.length <= 100, `bad name length: ${c.name}`);
    assert.ok(!c.topic || c.topic.length <= 1024, `topic too long: ${c.name}`);
    assert.ok(['text', 'voice'].includes(c.type));
  }
});

test('every role referenced by a channel exists', () => {
  const keys = new Set(ROLES.map((r) => r.key));
  for (const c of allChannels()) for (const k of [...(c.viewers ?? []), ...(c.writers ?? [])]) assert.ok(keys.has(k), `${c.name} -> ${k}`);
  for (const k of STAFF) assert.ok(keys.has(k));
});

test('roles are unique and Admin is the only one with Administrator', () => {
  assert.equal(new Set(ROLES.map((r) => r.name)).size, ROLES.length);
  assert.deepEqual(ROLES.filter((r) => r.administrator).map((r) => r.key), ['admin']);
});

test('chat channels get no overwrite for everyone, only the bot', () => {
  const out = buildOverwrites({ access: 'chat' }, ctx);
  assert.deepEqual(out.map((o) => o.id), ['B']);
});

test('read-only channels deny sending for everyone and allow staff + writers', () => {
  const out = buildOverwrites({ access: 'read', writers: ['dev'] }, ctx);
  const everyone = out.find((o) => o.id === 'E');
  assert.ok(everyone.deny.includes(P.SendMessages));
  assert.ok(!everyone.deny.includes(P.ViewChannel), 'read-only must stay visible');
  for (const id of ['A', 'M', 'D']) assert.ok(out.find((o) => o.id === id)?.allow.includes(P.SendMessages), `role ${id}`);
  assert.equal(out.find((o) => o.id === 'U'), undefined);
});

test('staff channels hide from everyone and show to listed roles only', () => {
  const out = buildOverwrites({ access: 'staff', viewers: ['tester'] }, ctx);
  assert.ok(out.find((o) => o.id === 'E').deny.includes(P.ViewChannel));
  for (const id of ['A', 'M', 'T']) assert.ok(out.find((o) => o.id === id)?.allow.includes(P.ViewChannel), `role ${id}`);
  assert.equal(out.find((o) => o.id === 'D'), undefined, 'developer was not listed');
});

test('no duplicate overwrite ids (Discord rejects them)', () => {
  for (const spec of allChannels()) {
    const ids = buildOverwrites(spec, ctx).map((o) => o.id);
    assert.equal(new Set(ids).size, ids.length, spec.name);
  }
});
