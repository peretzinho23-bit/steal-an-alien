import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { ChannelType, Collection, MessageFlags, PermissionFlagsBits as P } from 'discord.js';
import roomCommands from '../src/commands/rooms.js';
import { commands } from '../src/commands/index.js';
import {
  MAX_ROOMS,
  OWNER_ALLOW,
  OWNER_PERMS,
  canOwnRoom,
  cleanText,
  cleanupRooms,
  clip,
  deleteIfEmpty,
  ownedRoomId,
  ownerOfRoom,
  planJoin,
  pruneRooms,
  roomChannelName,
  roomName,
  roomSettings,
  sanitizeRooms,
  scheduleEmptyCheck,
  onVoiceStateUpdate,
} from '../src/rooms.js';
import { runtime } from '../src/runtime.js';
import { FileKv, KEYS } from '../src/shared/kv.js';

const ROOM = roomCommands[0];
const dirs = [];
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'saa-rooms-'));
  dirs.push(dir);
  runtime.kv = new FileKv(join(dir, 'kv.json'));
  runtime.tempRooms = new Set();
  roomSettings.emptyDelayMs = 0; // tests do not wait 5 seconds
});
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

// ---- fakes ------------------------------------------------------------------------------------

/** A guild with live channels. Channel ids are numeric strings so discord.js-style id ordering works. */
function makeGuild() {
  const channels = new Collection();
  const dms = [];
  let next = 1000;
  const guild = {
    id: '999',
    name: 'Test',
    channels: {
      cache: channels,
      fetch: async (id) => {
        if (id === undefined) return channels;
        const c = channels.get(id);
        if (!c) throw Object.assign(new Error('Unknown Channel'), { code: 10003 });
        return c;
      },
      create: async (o) => addChannel(o.name, o.type, { parentId: o.parent, overwrites: o.permissionOverwrites }),
    },
    dms,
  };

  function addChannel(name, type = ChannelType.GuildVoice, extra = {}) {
    const id = String(next++);
    const c = {
      id,
      name,
      type,
      parentId: extra.parentId ?? null,
      overwrites: extra.overwrites ?? [],
      edits: [],
      renames: [],
      limit: null,
      failDelete: false,
      members: new Collection(),
      permissionOverwrites: {
        edit: async (target, bits, opts) => c.edits.push({ target, bits, opts }),
      },
      setName: async (n) => {
        c.renames.push(n);
        c.name = n;
      },
      setUserLimit: async (n) => {
        c.limit = n;
      },
      delete: async () => {
        if (c.failDelete) throw new Error('Missing Permissions');
        channels.delete(id);
      },
    };
    channels.set(id, c);
    return c;
  }
  guild.addChannel = addChannel;
  return guild;
}

/** Puts the member into `to` (or out of voice when `to` is null), like Discord does. */
function moveMember(guild, member, to) {
  const from = member.voice.channelId ? guild.channels.cache.get(member.voice.channelId) : null;
  from?.members.delete(member.id);
  if (!to) {
    member.voice.channelId = null;
    return;
  }
  if (!guild.channels.cache.has(to.id)) throw Object.assign(new Error('Unknown Channel'), { code: 10003 });
  to.members.set(member.id, member);
  member.voice.channelId = to.id;
}

function makeMember(guild, id, displayName, { bot = false } = {}) {
  const tag = `${displayName}#0001`;
  const member = {
    id,
    displayName,
    user: {
      id,
      tag,
      bot,
      send: async (text) => guild.dms.push({ to: id, text }),
    },
    voice: {
      channelId: null,
      get channel() {
        return guild.channels.cache.get(this.channelId) ?? null;
      },
      setChannel: async (to) => moveMember(guild, member, to),
      disconnect: async () => moveMember(guild, member, null),
    },
  };
  return member;
}

/** A server with the Voice Channels category and the Create Room channel in it. */
function setupServer() {
  const guild = makeGuild();
  const category = guild.addChannel('Voice Channels', ChannelType.GuildCategory);
  const createRoom = guild.addChannel('➕｜Create Room', ChannelType.GuildVoice, { parentId: category.id });
  const general = guild.addChannel('General', ChannelType.GuildVoice, { parentId: category.id });
  return { guild, category, createRoom, general };
}

/** Simulates one VoiceStateUpdate: the member moves to `to`, then the bot's listener runs. */
async function move(guild, member, to) {
  const from = member.voice.channelId;
  moveMember(guild, member, to);
  return onVoiceStateUpdate(
    { guild, id: member.id, member, channelId: from },
    { guild, id: member.id, member, channelId: to?.id ?? null },
  );
}

const storeOf = async () => (await runtime.kv.get(KEYS.rooms)) ?? {};
const roomsOf = (guild) => [...guild.channels.cache.values()].filter((c) => c.name.startsWith('🔊｜'));

/** A /room interaction from `member` (who must be in voice for the command to find their room). */
function interaction(guild, member, sub, opts = {}) {
  const replies = [];
  return {
    replies,
    guild,
    member,
    user: member.user,
    options: {
      getSubcommand: () => sub,
      getString: (n) => opts[n] ?? null,
      getInteger: (n) => opts[n] ?? null,
      getMember: (n) => opts[n] ?? null,
    },
    reply: async (o) => replies.push(o),
    deferReply: async (o) => replies.push({ deferred: o }),
    editReply: async (content) => replies.push({ edited: content }),
  };
}

async function roomCmd(guild, member, sub, opts) {
  const i = interaction(guild, member, sub, opts);
  await ROOM.run(i);
  return i.replies;
}
const errorOf = (replies) => replies.find((r) => typeof r.content === 'string' && r.flags)?.content ?? null;

// ---- pure helpers -----------------------------------------------------------------------------

test('roomName: 🔊｜<name>\'s room, cleaned and never longer than 100 characters', () => {
  assert.equal(roomName('Dana'), "🔊｜Dana's room");
  assert.equal(roomName('  Dana\n\tK  '), "🔊｜Dana K's room", 'control characters and runs of spaces collapse');
  assert.equal(roomName(''), "🔊｜Member's room");
  for (const long of ['x'.repeat(300), '🎮'.repeat(200), 'שלום '.repeat(80)]) {
    const name = roomName(long);
    assert.ok(name.length <= 100, `${name.length} units`);
    assert.ok(name.endsWith("'s room"), 'the suffix always fits');
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(name), 'no emoji cut in half');
  }
});

test('roomChannelName: the owner label is cleaned and limited to 100 characters', () => {
  assert.equal(roomChannelName('Movie night'), '🔊｜Movie night');
  assert.equal(roomChannelName('   '), '🔊｜room');
  assert.ok(roomChannelName('a'.repeat(500)).length <= 100);
  assert.equal(cleanText('a\u0000b\r\nc'), 'a b c');
  assert.equal(clip('😀😀😀', 4), '😀😀', 'stops before a surrogate pair that does not fit');
});

test('sanitizeRooms keeps only string-to-string entries', () => {
  assert.deepEqual(sanitizeRooms({ '1': 'a', '2': 7, '3': '', '4': null }), { '1': 'a' });
  assert.deepEqual(sanitizeRooms(['x']), {});
  assert.deepEqual(sanitizeRooms(null), {});
});

test('ownedRoomId, pruneRooms and planJoin', () => {
  const rooms = { r1: 'alice', r2: 'bob' };
  assert.equal(ownedRoomId(rooms, 'bob'), 'r2');
  assert.equal(ownedRoomId(rooms, 'carol'), null);
  assert.deepEqual(pruneRooms(rooms, new Set(['r2'])), { kept: { r2: 'bob' }, dropped: ['r1'] });

  assert.deepEqual(planJoin(rooms, 'alice'), { action: 'move', channelId: 'r1' }, 'one room per member');
  assert.deepEqual(planJoin(rooms, 'carol'), { action: 'create' });
  const full = Object.fromEntries(Array.from({ length: MAX_ROOMS }, (_, n) => [`r${n}`, `m${n}`]));
  assert.deepEqual(planJoin(full, 'new'), { action: 'full' });
  assert.deepEqual(planJoin(full, 'm3'), { action: 'move', channelId: 'r3' }, 'an owner of a room is never refused');
  assert.equal(canOwnRoom(full, 'new'), false);
  assert.equal(canOwnRoom(full, 'm3'), true);
  assert.equal(canOwnRoom({}, 'new'), true);
});

test('the owner permissions: the ones asked for, and never ManageChannels or administrator', () => {
  for (const name of ['ViewChannel', 'Connect', 'Speak', 'MoveMembers', 'MuteMembers']) assert.ok(OWNER_PERMS.includes(name), name);
  assert.ok(OWNER_ALLOW.includes(P.Connect) && OWNER_ALLOW.includes(P.MoveMembers));
  for (const bad of [P.ManageChannels, P.ManageRoles, P.Administrator]) assert.ok(!OWNER_ALLOW.includes(bad));
});

// ---- creating rooms ---------------------------------------------------------------------------

test('joining Create Room creates a room for the member in the same category and moves them in', async () => {
  const { guild, category, createRoom } = setupServer();
  const dana = makeMember(guild, 'dana', 'Dana');
  await move(guild, dana, createRoom);

  const rooms = roomsOf(guild);
  assert.equal(rooms.length, 1);
  const room = rooms[0];
  assert.equal(room.name, "🔊｜Dana's room");
  assert.equal(room.parentId, category.id, 'same category');
  assert.equal(room.type, ChannelType.GuildVoice);
  assert.equal(dana.voice.channelId, room.id, 'moved in');
  assert.deepEqual(await storeOf(), { [room.id]: 'dana' }, 'persisted as channelId -> ownerId');
  assert.ok(runtime.tempRooms.has(room.id), 'known to the logs filter');
});

test('the owner gets the owner permissions on the room, and the bot grants nothing more', async () => {
  const { guild, createRoom } = setupServer();
  const dana = makeMember(guild, 'dana', 'Dana');
  await move(guild, dana, createRoom);
  const room = roomsOf(guild)[0];
  const grant = room.overwrites.find((o) => o.id === 'dana');
  assert.ok(grant, 'owner has an overwrite');
  for (const bit of [P.ViewChannel, P.Connect, P.Speak, P.MoveMembers, P.MuteMembers]) assert.ok(grant.allow.includes(bit));
  assert.ok(!grant.allow.includes(P.ManageChannels), 'owners cannot manage the channel themselves');
  assert.equal(room.overwrites.length, 1, 'no other overwrites');
});

test('one room per member: rejoining Create Room while in their room puts them back, nothing new is created', async () => {
  const { guild, createRoom } = setupServer();
  const dana = makeMember(guild, 'dana', 'Dana');
  await move(guild, dana, createRoom);
  const room = roomsOf(guild)[0];

  // Dana clicks Create Room while sitting in her own room: she leaves the room and the listener runs
  await move(guild, dana, createRoom);
  assert.equal(roomsOf(guild).length, 1, 'still one room');
  assert.equal(dana.voice.channelId, room.id, 'moved back to her room');
  assert.deepEqual(await storeOf(), { [room.id]: 'dana' });
});

test('a bot joining Create Room gets nothing', async () => {
  const { guild, createRoom } = setupServer();
  const bot = makeMember(guild, 'bot1', 'Helper', { bot: true });
  await move(guild, bot, createRoom);
  assert.equal(roomsOf(guild).length, 0);
});

test('at the cap of 25 rooms a new member is told to wait and nothing is created', async () => {
  const { guild, createRoom } = setupServer();
  const rooms = {};
  for (let n = 0; n < MAX_ROOMS; n++) rooms[guild.addChannel(`🔊｜room ${n}`).id] = `owner${n}`;
  await runtime.kv.set(KEYS.rooms, rooms);
  const before = guild.channels.cache.size;

  const late = makeMember(guild, 'late', 'Late');
  await move(guild, late, createRoom);
  assert.equal(guild.channels.cache.size, before, 'no room created');
  assert.equal(late.voice.channelId, createRoom.id, 'stays in Create Room');
  assert.equal(guild.dms.length, 1);
  assert.match(guild.dms[0].text, /25/);
});

test('a room the owner already has, but whose channel was deleted by hand, is forgotten and a new one is made', async () => {
  const { guild, createRoom } = setupServer();
  await runtime.kv.set(KEYS.rooms, { 'ghost-id': 'dana' });
  const dana = makeMember(guild, 'dana', 'Dana');
  await move(guild, dana, createRoom);
  const room = roomsOf(guild)[0];
  assert.deepEqual(await storeOf(), { [room.id]: 'dana' });
});

// ---- deleting empty rooms ---------------------------------------------------------------------

test('a room is deleted and forgotten when its last member leaves', async () => {
  const { guild, createRoom, general } = setupServer();
  const dana = makeMember(guild, 'dana', 'Dana');
  await move(guild, dana, createRoom);
  const room = roomsOf(guild)[0];

  await move(guild, dana, general); // resolves after the empty check ran
  assert.equal(guild.channels.cache.get(room.id), undefined, 'room deleted');
  assert.deepEqual(await storeOf(), {});
  assert.equal(runtime.tempRooms.has(room.id), false);
});

test('a room with someone still in it is kept when the owner leaves', async () => {
  const { guild, createRoom, general } = setupServer();
  const dana = makeMember(guild, 'dana', 'Dana');
  const bo = makeMember(guild, 'bo', 'Bo');
  await move(guild, dana, createRoom);
  const room = roomsOf(guild)[0];
  moveMember(guild, bo, room);

  await move(guild, dana, general);
  assert.ok(guild.channels.cache.has(room.id), 'still there');
  assert.equal((await storeOf())[room.id], 'dana', 'still owned by Dana');
});

test('the empty check re-reads the room: someone who came back in time keeps it', async () => {
  const { guild, createRoom, general } = setupServer();
  const dana = makeMember(guild, 'dana', 'Dana');
  await move(guild, dana, createRoom);
  const room = roomsOf(guild)[0];
  const pending = scheduleEmptyCheck(guild, room.id, 30);
  moveMember(guild, dana, general);
  moveMember(guild, makeMember(guild, 'bo', 'Bo'), room); // Bo joins before the 30 ms are over
  assert.equal(await pending, 'occupied');
  assert.ok(guild.channels.cache.has(room.id));
});

test('deleteIfEmpty: untracked channels are never touched; a failing delete keeps the room tracked', async () => {
  const { guild, general, createRoom } = setupServer();
  assert.equal(await deleteIfEmpty(guild, general.id), 'untracked');
  assert.ok(guild.channels.cache.has(general.id));

  const dana = makeMember(guild, 'dana', 'Dana');
  await move(guild, dana, createRoom);
  const room = roomsOf(guild)[0];
  moveMember(guild, dana, general);
  room.failDelete = true;
  assert.equal(await deleteIfEmpty(guild, room.id), 'failed');
  assert.deepEqual(await storeOf(), { [room.id]: 'dana' }, 'kept for the next start');
});

test('a room is deleted when the owner disconnects from voice entirely', async () => {
  const { guild, createRoom, general } = setupServer();
  const dana = makeMember(guild, 'dana', 'Dana');
  await move(guild, dana, createRoom);
  const room = roomsOf(guild)[0];
  await move(guild, dana, null); // disconnected entirely
  assert.equal(guild.channels.cache.get(room.id), undefined);
  assert.equal(general.members.size, 0);
});

// ---- startup cleanup and persistence ----------------------------------------------------------

test('cleanupRooms at startup deletes empty rooms, keeps occupied ones and forgets missing ones', async () => {
  const { guild } = setupServer();
  const empty = guild.addChannel('🔊｜old empty');
  const busy = guild.addChannel('🔊｜old busy');
  moveMember(guild, makeMember(guild, 'bo', 'Bo'), busy);
  await runtime.kv.set(KEYS.rooms, { [empty.id]: 'a', [busy.id]: 'b', 'missing-id': 'c', bad: 42 });

  const result = await cleanupRooms(guild);
  assert.deepEqual(result, { deleted: 1, kept: 1, forgotten: 1 });
  assert.equal(guild.channels.cache.get(empty.id), undefined);
  assert.ok(guild.channels.cache.has(busy.id));
  assert.deepEqual(await storeOf(), { [busy.id]: 'b' });
  assert.deepEqual([...runtime.tempRooms], [busy.id], 'the logs filter knows the kept room again');
});

test('the store is plain JSON and survives a restart', async () => {
  const { guild, createRoom } = setupServer();
  const dana = makeMember(guild, 'dana', 'Dana');
  await move(guild, dana, createRoom);
  const room = roomsOf(guild)[0];
  const stored = await runtime.kv.get(KEYS.rooms);
  assert.deepEqual(JSON.parse(JSON.stringify(stored)), stored, 'plain JSON only');

  // a new process: nothing in memory, only the store
  runtime.tempRooms = new Set();
  assert.equal(await ownerOfRoom(room.id), 'dana');
  assert.deepEqual(await cleanupRooms(guild), { deleted: 0, kept: 1, forgotten: 0 }, 'Dana is still in the room, so it stays');
});

test('onVoiceStateUpdate swallows errors instead of throwing into discord.js', async () => {
  const { guild, createRoom } = setupServer();
  const dana = makeMember(guild, 'dana', 'Dana');
  guild.channels.create = async () => {
    throw new Error('Missing Permissions');
  };
  moveMember(guild, dana, createRoom);
  await assert.doesNotReject(onVoiceStateUpdate({ guild, id: 'dana', channelId: null }, { guild, id: 'dana', member: dana, channelId: createRoom.id }));
});

// ---- /room command ----------------------------------------------------------------------------

function ownerSetup() {
  const s = setupServer();
  const dana = makeMember(s.guild, 'dana', 'Dana');
  return { ...s, dana };
}

test('the owner of the room can rename it, set a limit, lock, hide and show it', async () => {
  const { guild, createRoom, dana } = ownerSetup();
  await move(guild, dana, createRoom);
  const room = roomsOf(guild)[0];

  let replies = await roomCmd(guild, dana, 'name', { name: 'Movie night' });
  assert.equal(room.name, '🔊｜Movie night');
  assert.match(replies.at(-1).edited, /renamed/);

  await roomCmd(guild, dana, 'limit', { users: 5 });
  assert.equal(room.limit, 5);

  await roomCmd(guild, dana, 'lock');
  assert.deepEqual(room.edits.at(-1).bits, { Connect: false });
  assert.equal(room.edits.at(-1).target, guild.id, 'the @everyone role');

  await roomCmd(guild, dana, 'unlock');
  assert.deepEqual(room.edits.at(-1).bits, { Connect: null });

  await roomCmd(guild, dana, 'hide');
  assert.deepEqual(room.edits.at(-1).bits, { ViewChannel: false });
  await roomCmd(guild, dana, 'show');
  assert.deepEqual(room.edits.at(-1).bits, { ViewChannel: null });
});

test('invite gives a member view and connect rights on the room', async () => {
  const { guild, createRoom, dana } = ownerSetup();
  const bo = makeMember(guild, 'bo', 'Bo');
  await move(guild, dana, createRoom);
  const room = roomsOf(guild)[0];
  const replies = await roomCmd(guild, dana, 'invite', { user: bo });
  assert.deepEqual(room.edits.at(-1).bits, { ViewChannel: true, Connect: true });
  assert.equal(room.edits.at(-1).target, 'bo');
  assert.match(replies.at(-1).edited, /can see and join/);
});

test('kick disconnects a member who is in the room and refuses anyone else', async () => {
  const { guild, createRoom, general, dana } = ownerSetup();
  const bo = makeMember(guild, 'bo', 'Bo');
  await move(guild, dana, createRoom);
  const room = roomsOf(guild)[0];
  moveMember(guild, bo, room);

  const outsider = makeMember(guild, 'cy', 'Cy');
  moveMember(guild, outsider, general);
  assert.match(errorOf(await roomCmd(guild, dana, 'kick', { user: outsider })), /not in your room/);
  assert.equal(outsider.voice.channelId, general.id, 'untouched');

  await roomCmd(guild, dana, 'kick', { user: bo });
  assert.equal(bo.voice.channelId, null);
});

test('transfer hands the room to a member who is in it and takes the owner rights back', async () => {
  const { guild, createRoom, dana } = ownerSetup();
  const bo = makeMember(guild, 'bo', 'Bo');
  await move(guild, dana, createRoom);
  const room = roomsOf(guild)[0];
  moveMember(guild, bo, room);

  await roomCmd(guild, dana, 'transfer', { user: bo });
  assert.equal((await storeOf())[room.id], 'bo');
  assert.ok(room.edits.some((e) => e.target === 'bo' && e.bits.MoveMembers === true), 'new owner gets the rights');
  assert.ok(room.edits.some((e) => e.target === 'dana' && e.bits.MoveMembers === null), 'old owner loses MoveMembers');

  assert.match(errorOf(await roomCmd(guild, dana, 'lock')), /Only the owner/);
  await roomCmd(guild, bo, 'lock');
  assert.deepEqual(room.edits.at(-1).bits, { Connect: false });
});

test('non-owners get a clear ephemeral error and nothing changes', async () => {
  const { guild, createRoom, dana } = ownerSetup();
  const bo = makeMember(guild, 'bo', 'Bo');
  await move(guild, dana, createRoom);
  const room = roomsOf(guild)[0];
  moveMember(guild, bo, room);
  const editsBefore = room.edits.length;

  for (const [sub, opts] of [['lock', {}], ['name', { name: 'x' }], ['limit', { users: 3 }], ['show', {}]]) {
    const replies = await roomCmd(guild, bo, sub, opts);
    assert.equal(errorOf(replies), 'Only the owner of this room can change it.', sub);
    assert.equal(replies[0].flags, MessageFlags.Ephemeral, `${sub} error is ephemeral`);
  }
  assert.equal(room.edits.length, editsBefore);
  assert.equal(room.name, '🔊｜Dana\'s room');
  assert.equal(room.limit, null);
});

test('not in voice, or in a voice channel that is not a temporary room: a clear ephemeral error', async () => {
  const { guild, general, dana } = ownerSetup();
  let replies = await roomCmd(guild, dana, 'lock');
  assert.match(errorOf(replies), /Join your temporary room first/);
  assert.equal(replies[0].flags, MessageFlags.Ephemeral);

  moveMember(guild, dana, general);
  replies = await roomCmd(guild, dana, 'lock');
  assert.match(errorOf(replies), /not in a temporary room/);
  assert.equal(replies[0].flags, MessageFlags.Ephemeral);
});

test('the /room command is registered with the subcommands the owner asked for', () => {
  const json = ROOM.data.toJSON();
  assert.equal(json.name, 'room');
  assert.deepEqual(json.options.map((o) => o.name), ['name', 'limit', 'lock', 'unlock', 'hide', 'show', 'invite', 'kick', 'transfer']);
  assert.equal(ROOM.category, 'Rooms');
  assert.ok(commands.some((c) => c.data.name === 'room'), 'registered in commands/index.js');
});
