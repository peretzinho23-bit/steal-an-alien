import assert from 'node:assert/strict';
import { test } from 'node:test';
import { botCommandsGuide } from '../src/content.js';
import { commandData, commands, describeCommands } from '../src/commands/index.js';
import { checkTarget } from '../src/commands/moderation.js';

const CATEGORIES = new Set(['General', 'Fun', 'Ranks', 'Moderation', 'Staff', 'Tickets']);

test('every command is well formed for Discord', () => {
  assert.ok(commandData.length > 0 && commandData.length <= 100);
  const names = commandData.map((c) => c.name);
  assert.equal(new Set(names).size, names.length, 'duplicate command name');
  for (const c of commands) {
    const json = c.data.toJSON();
    assert.match(json.name, /^[a-z0-9_-]{1,32}$/, json.name);
    assert.ok(json.description.length >= 1 && json.description.length <= 100, `${json.name} description length`);
    assert.equal(typeof c.run, 'function', `${json.name} has no run()`);
    assert.ok(CATEGORIES.has(c.category), `${json.name}: unknown category ${c.category}`);
    for (const o of json.options ?? []) assert.ok(o.description.length <= 100, `${json.name}.${o.name} description`);
  }
});

test('the commands the user asked for exist', () => {
  const names = new Set(commandData.map((c) => c.name));
  for (const wanted of ['help', 'ping', 'rank', 'leaderboard', 'ranks', 'xp', 'ticket', 'announce', 'poll', 'clear', 'timeout', 'kick', 'ban', 'unban', 'serverinfo', 'userinfo']) {
    assert.ok(names.has(wanted), `missing /${wanted}`);
  }
});

test('staff and moderation commands are hidden from regular members by default', () => {
  for (const c of commands.filter((x) => ['Moderation', 'Staff', 'Tickets'].includes(x.category))) {
    assert.ok(c.data.toJSON().default_member_permissions, `/${c.data.name} would be visible to everyone`);
  }
});

test('member-facing commands have no permission requirement', () => {
  for (const c of commands.filter((x) => ['General', 'Fun', 'Ranks'].includes(x.category) && x.data.name !== 'xp')) {
    assert.equal(c.data.toJSON().default_member_permissions ?? null, null, `/${c.data.name}`);
  }
});

test('the generated guide lists every command and fits in one embed', () => {
  const payload = botCommandsGuide(describeCommands());
  const embed = payload.embeds[0].toJSON();
  const text = embed.fields.map((f) => f.value).join('\n');
  for (const c of commandData) assert.ok(text.includes(`\`/${c.name}\``), `/${c.name} missing in the guide`);
  for (const f of embed.fields) assert.ok(f.value.length <= 1024, `field "${f.name}" too long`);
  assert.ok(embed.fields.length <= 25);
  const total = embed.title.length + embed.description.length + embed.fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
  assert.ok(total <= 6000, `embed is ${total} characters`);
});

// ---- moderation rules ------------------------------------------------------------------------

const member = (id, position) => ({ id, roles: { highest: { comparePositionTo: (other) => position - other.position, position } } });
const ctx = (moderator, target) => ({ moderator, target, botId: 'bot', ownerId: 'owner' });

test('checkTarget: allows a lower-ranked member', () => {
  assert.equal(checkTarget(ctx(member('mod', 5), member('x', 2)), 'kick'), null);
});

test('checkTarget: blocks self, the bot, the owner, missing members and equal/higher roles', () => {
  assert.match(checkTarget(ctx(member('mod', 5), member('mod', 5)), 'kick'), /yourself/);
  assert.match(checkTarget(ctx(member('mod', 5), member('bot', 1)), 'kick'), /myself/);
  assert.match(checkTarget(ctx(member('mod', 5), member('owner', 1)), 'ban'), /owner/);
  assert.match(checkTarget(ctx(member('mod', 5), null), 'ban'), /not in this server/);
  assert.match(checkTarget(ctx(member('mod', 5), member('peer', 5)), 'kick'), /same or a higher/);
  assert.match(checkTarget(ctx(member('mod', 5), member('boss', 9)), 'kick'), /same or a higher/);
});

test('checkTarget: the server owner may act on anyone but themselves', () => {
  assert.equal(checkTarget(ctx(member('owner', 1), member('boss', 9)), 'kick'), null);
  assert.match(checkTarget(ctx(member('owner', 1), member('owner', 1)), 'kick'), /yourself/);
});
