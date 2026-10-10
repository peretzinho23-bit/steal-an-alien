import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChannelType, Collection, PermissionFlagsBits as P } from 'discord.js';
import { CATEGORIES, SEP, allChannels, channelKey } from '../src/blueprint.js';
import { buildOverwrites } from '../src/overwrites.js';
import { ensureMissingChannels } from '../src/setup.js';

const NEW_VOICE = {
  'game-night': `🎮${SEP}Game Night`,
  chill: `🎵${SEP}Chill`,
  trading: `🤝${SEP}Trading`,
  'testers-voice': `🧪${SEP}Testers Voice`,
  afk: `🔇${SEP}AFK`,
  'create-room': `➕${SEP}Create Room`,
};

const byKey = (key) => allChannels().find((c) => c.key === key);
const lower = (s) => s.toLowerCase();

test('the new voice channels exist in Voice Channels with the agreed names and access', () => {
  const voiceCategory = CATEGORIES.find((c) => c.name === 'Voice Channels');
  for (const [key, name] of Object.entries(NEW_VOICE)) {
    const spec = byKey(key);
    assert.ok(spec, `missing blueprint entry ${key}`);
    assert.equal(spec.name, name);
    assert.equal(spec.type, 'voice', `${key} must be a voice channel`);
    assert.ok(voiceCategory.channels.includes(spec), `${key} is not in Voice Channels`);
  }
  assert.equal(byKey('testers-voice').access, 'staff');
  assert.deepEqual(byKey('testers-voice').viewers, ['tester', 'dev']);
  for (const key of ['game-night', 'chill', 'trading', 'afk', 'create-room']) assert.equal(byKey(key).access, 'chat', key);
});

test('keys and names are unique per type and within Discord limits', () => {
  const voice = allChannels().filter((c) => c.type === 'voice');
  assert.equal(new Set(allChannels().map((c) => c.key)).size, allChannels().length, 'duplicate key');
  assert.equal(new Set(voice.map((c) => lower(c.name))).size, voice.length, 'duplicate voice name');
  for (const c of voice) assert.ok(c.name.length >= 1 && c.name.length <= 100, `bad name length: ${c.name}`);
});

test('the testers voice channel is hidden from everyone and shown to staff, testers and developers only', () => {
  const roleIds = { admin: 'A', mod: 'M', dev: 'D', tester: 'T', member: 'U' };
  const out = buildOverwrites(byKey('testers-voice'), { roleIds, everyoneId: 'E', botId: 'B' });
  assert.ok(out.find((o) => o.id === 'E').deny.includes(P.ViewChannel), 'everyone is denied');
  for (const id of ['A', 'M', 'T', 'D']) assert.ok(out.find((o) => o.id === id)?.allow.includes(P.ViewChannel), `role ${id} sees it`);
  assert.equal(out.find((o) => o.id === 'U'), undefined, 'plain members get no overwrite');
});

test('channelKey() of each new name resolves to its key', () => {
  for (const [key, name] of Object.entries(NEW_VOICE)) assert.equal(channelKey(name), key, name);
});

// ---- ensureMissingChannels with a fake guild --------------------------------------------------

function blueprintGuild() {
  const channels = new Collection();
  const created = [];
  let next = 5000;
  const roles = new Collection(
    ['Admin', 'Moderator', 'Developer', 'Tester', 'Member'].map((name, n) => [`r${n}`, { id: `r${n}`, name }]),
  );
  const guild = {
    id: '999',
    channels: {
      cache: channels,
      fetch: async () => channels,
      create: async (o) => {
        const id = String(next++);
        const c = {
          id,
          name: o.name,
          type: o.type,
          parentId: o.parent ?? null,
          topic: o.topic,
          overwrites: o.permissionOverwrites,
          members: new Collection(),
        };
        channels.set(id, c);
        created.push(c);
        return c;
      },
    },
    roles: { cache: roles, fetch: async () => roles },
    members: { fetchMe: async () => ({ id: 'bot' }) },
  };
  return { guild, channels, created };
}

test('ensureMissingChannels creates the new voice channels in Voice Channels, with the right overwrites', async () => {
  const { guild, channels } = blueprintGuild();
  const created = await ensureMissingChannels(guild);
  const category = [...channels.values()].find((c) => c.type === ChannelType.GuildCategory && c.name === 'Voice Channels');
  assert.ok(category, 'the Voice Channels category is created');

  for (const name of Object.values(NEW_VOICE)) {
    assert.ok(created.includes(name), `${name} was not created`);
    const c = [...channels.values()].find((x) => x.name === name);
    assert.equal(c.type, ChannelType.GuildVoice, name);
    assert.equal(c.parentId, category.id, `${name} is not in Voice Channels`);
  }

  const testers = [...channels.values()].find((x) => x.name === NEW_VOICE['testers-voice']);
  assert.ok(testers.overwrites.find((o) => o.id === '999').deny.includes(P.ViewChannel), 'testers voice hidden from everyone');
  assert.ok(testers.overwrites.find((o) => o.id === 'r3')?.allow.includes(P.ViewChannel), 'testers see it');
  assert.ok(testers.overwrites.find((o) => o.id === 'r2')?.allow.includes(P.ViewChannel), 'developers see it');
  const chill = [...channels.values()].find((x) => x.name === NEW_VOICE.chill);
  assert.equal(chill.overwrites.find((o) => o.id === '999'), undefined, 'chill has no deny for everyone');
});

test('a second ensureMissingChannels run creates nothing', async () => {
  const { guild, created } = blueprintGuild();
  await ensureMissingChannels(guild);
  const before = created.length;
  assert.deepEqual(await ensureMissingChannels(guild), []);
  assert.equal(created.length, before);
});
