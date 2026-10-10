import { ChannelType, PermissionFlagsBits as P } from 'discord.js';
import { SEP } from './blueprint.js';
import { runtime } from './runtime.js';
import { KEYS } from './shared/kv.js';
import { findChannel } from './util.js';

/**
 * Temporary voice rooms ("join to create"). A member who joins ➕｜Create Room gets a room of their own in the same
 * category, owns it (see OWNER_ALLOW) and is moved in. Rooms are deleted once they stay empty.
 * The store is { channelId: ownerId } under KEYS.rooms (plain JSON). runtime.tempRooms mirrors its keys.
 */

const log = (...args) => console.log(new Date().toISOString(), ...args);

export const CREATE_ROOM_KEY = 'create-room';
export const MAX_ROOMS = 25;
export const ROOM_NAME_MAX = 100;
const ROOM_PREFIX = `🔊${SEP}`;
const ROOM_SUFFIX = "'s room";

/** Tests set emptyDelayMs to 0; in a real server a room is deleted only if it is still empty after 5 seconds. */
export const roomSettings = { emptyDelayMs: 5000 };

/** What an owner gets on their room. ManageChannels is deliberately missing: the bot does renames and limits. */
export const OWNER_PERMS = ['ViewChannel', 'Connect', 'Speak', 'Stream', 'UseVAD', 'MoveMembers', 'MuteMembers', 'DeafenMembers'];
export const OWNER_ALLOW = OWNER_PERMS.map((name) => P[name]);
const OWNER_ONLY = ['MoveMembers', 'MuteMembers', 'DeafenMembers'];

// ---- pure helpers -----------------------------------------------------------------------------

/** Takes at most `max` UTF-16 units without cutting an emoji or a surrogate pair in half. */
export function clip(text, max) {
  let out = '';
  for (const ch of String(text)) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out;
}

/** Removes control characters and collapses whitespace: Discord names must be one plain line. */
export const cleanText = (text) => String(text ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();

/** Channel name for a room whose label the owner chose (used by /room name). Always 1-100 characters. */
export function roomChannelName(text) {
  const label = clip(cleanText(text) || 'room', ROOM_NAME_MAX - ROOM_PREFIX.length).trim();
  return `${ROOM_PREFIX}${label || 'room'}`;
}

/** "🔊｜Dana's room" for a member called Dana. Long display names are cut so the suffix always fits. */
export function roomName(displayName) {
  const name = clip(cleanText(displayName) || 'Member', ROOM_NAME_MAX - ROOM_PREFIX.length - ROOM_SUFFIX.length).trim();
  return `${ROOM_PREFIX}${name || 'Member'}${ROOM_SUFFIX}`;
}

/** Plain-object store with string ids only. Anything else (a corrupt value) is dropped. */
export function sanitizeRooms(raw) {
  const out = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [channelId, ownerId] of Object.entries(raw)) {
      if (typeof ownerId === 'string' && ownerId && channelId) out[channelId] = ownerId;
    }
  }
  return out;
}

/** The room a member owns, or null. */
export function ownedRoomId(rooms, memberId) {
  return Object.keys(rooms).find((id) => rooms[id] === memberId) ?? null;
}

/**
 * Splits the store into rooms whose channel still exists and the ids to forget.
 * liveIds: Set of channel ids that exist.
 */
export function pruneRooms(rooms, liveIds) {
  const kept = {};
  const dropped = [];
  for (const [id, owner] of Object.entries(rooms)) {
    if (liveIds.has(id)) kept[id] = owner;
    else dropped.push(id);
  }
  return { kept, dropped };
}

/** Whether another room may be created (the cap counts every tracked room). */
export const canOwnRoom = (rooms, memberId) => ownedRoomId(rooms, memberId) !== null || Object.keys(rooms).length < MAX_ROOMS;

/**
 * What happens when a member joins Create Room, given rooms that are already pruned:
 *   move   -> they own a room already: put them back in it
 *   create -> make a new one
 *   full   -> the server already has MAX_ROOMS temporary rooms
 */
export function planJoin(rooms, memberId) {
  const owned = ownedRoomId(rooms, memberId);
  if (owned) return { action: 'move', channelId: owned };
  if (Object.keys(rooms).length >= MAX_ROOMS) return { action: 'full' };
  return { action: 'create' };
}

// ---- store and locking ------------------------------------------------------------------------

// Every read-modify-write of the store and every room deletion runs one at a time.
let queue = Promise.resolve();
const withLock = (fn) => {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
};

const syncTempRooms = (rooms) => {
  runtime.tempRooms ??= new Set();
  runtime.tempRooms.clear();
  for (const id of Object.keys(rooms)) runtime.tempRooms.add(id);
};

/** The stored rooms, as they were saved (no check that the channels still exist). */
export async function readRooms() {
  const rooms = sanitizeRooms(await runtime.kv.get(KEYS.rooms));
  syncTempRooms(rooms);
  return rooms;
}

async function saveRooms(rooms) {
  await runtime.kv.set(KEYS.rooms, rooms);
  syncTempRooms(rooms);
}

/** The channel if it exists in this guild, else null. Fetches it when the cache does not have it. */
async function liveChannel(guild, id) {
  const cached = guild.channels.cache.get(id);
  if (cached) return cached;
  try {
    return (await guild.channels.fetch(id)) ?? null;
  } catch {
    return null;
  }
}

/** Stored rooms minus the ones whose channel is gone (saved if anything changed). */
async function loadLiveRooms(guild) {
  const rooms = await readRooms();
  const liveIds = new Set();
  for (const id of Object.keys(rooms)) if (await liveChannel(guild, id)) liveIds.add(id);
  const { kept, dropped } = pruneRooms(rooms, liveIds);
  if (dropped.length) {
    log(`[${guild.name}] temp rooms: forgot ${dropped.length} room(s) whose channel no longer exists`);
    await saveRooms(kept);
  }
  return kept;
}

/** Who owns a tracked temporary room, or null when the channel is not one. */
export async function ownerOfRoom(channelId) {
  const rooms = await readRooms();
  return rooms[channelId] ?? null;
}

/** Records a new owner (used by /room transfer). The overwrites are changed by the caller. */
export function setRoomOwner(channelId, ownerId) {
  return withLock(async () => {
    const rooms = await readRooms();
    if (!rooms[channelId]) return false;
    rooms[channelId] = ownerId;
    await saveRooms(rooms);
    return true;
  });
}

/** Gives a member everything an owner has on this room. */
export async function grantOwner(channel, memberId, reason = 'Temporary room owner') {
  await channel.permissionOverwrites.edit(memberId, Object.fromEntries(OWNER_PERMS.map((name) => [name, true])), { reason });
}

/** Takes back the owner-only rights (moving, muting and deafening others). Keeps whatever else they were given. */
export async function revokeOwner(channel, memberId, reason = 'No longer the room owner') {
  await channel.permissionOverwrites.edit(memberId, Object.fromEntries(OWNER_ONLY.map((name) => [name, null])), { reason });
}

// ---- deletion ---------------------------------------------------------------------------------

/**
 * Deletes the room if it is tracked, still exists and is empty; forgets it otherwise when it is gone.
 * Returns 'deleted' | 'occupied' | 'gone' | 'untracked' | 'failed'. Never throws.
 */
export function deleteIfEmpty(guild, channelId) {
  return withLock(async () => {
    try {
      const rooms = await readRooms();
      if (!rooms[channelId]) return 'untracked';
      const channel = await liveChannel(guild, channelId);
      if (!channel) {
        delete rooms[channelId];
        await saveRooms(rooms);
        return 'gone';
      }
      if (channel.members.size > 0) return 'occupied';
      await channel.delete('Temporary room is empty');
      delete rooms[channelId];
      await saveRooms(rooms);
      log(`[${guild.name}] temp room "${channel.name}" deleted (it was empty)`);
      return 'deleted';
    } catch (e) {
      log(`[${guild.name}] could not delete temp room ${channelId}:`, e.message);
      return 'failed';
    }
  });
}

/** Waits `delay` ms, then runs deleteIfEmpty. The promise resolves with its result and never rejects. */
export function scheduleEmptyCheck(guild, channelId, delay = roomSettings.emptyDelayMs) {
  return new Promise((resolve) => setTimeout(() => resolve(deleteIfEmpty(guild, channelId)), delay));
}

// ---- events -----------------------------------------------------------------------------------

/** Puts the member in their own room, or back in the room they already own. */
async function placeMember(guild, member, createRoom) {
  return withLock(async () => {
    const rooms = await loadLiveRooms(guild);
    const plan = planJoin(rooms, member.id);

    if (plan.action === 'full') {
      log(`[${guild.name}] temp rooms full (${MAX_ROOMS}): ${member.displayName} must wait`);
      await member.user?.send(`The server already has ${MAX_ROOMS} temporary rooms. Try again in a few minutes.`).catch(() => {});
      return null;
    }

    if (plan.action === 'move') {
      const room = await liveChannel(guild, plan.channelId);
      if (!room) return null;
      await member.voice.setChannel(room, 'Back to your temporary room').catch((e) => log(`[${guild.name}] could not move ${member.id} back to their room:`, e.message));
      return room.id;
    }

    const room = await guild.channels.create({
      name: roomName(member.displayName),
      type: ChannelType.GuildVoice,
      parent: createRoom.parentId ?? undefined,
      permissionOverwrites: [{ id: member.id, allow: OWNER_ALLOW }],
      reason: `Temporary room for ${member.user?.tag ?? member.id}`,
    });
    rooms[room.id] = member.id;
    await saveRooms(rooms);
    log(`[${guild.name}] temp room "${room.name}" created for ${member.user?.tag ?? member.id}`);
    try {
      await member.voice.setChannel(room, 'Your temporary room');
    } catch (e) {
      log(`[${guild.name}] could not move ${member.id} into the new room (they probably left):`, e.message);
      scheduleEmptyCheck(guild, room.id);
    }
    return room.id;
  });
}

/**
 * VoiceStateUpdate listener. Joining ➕｜Create Room creates or re-uses the member's room; leaving a temporary
 * room schedules a check that deletes it if it is still empty. Never throws. The returned promise settles
 * after any scheduled deletion (discord.js ignores it; tests await it).
 */
export async function onVoiceStateUpdate(oldState, newState) {
  let pending = null;
  try {
    const guild = newState.guild ?? oldState.guild;
    if (!guild) return null;

    const joined = Boolean(newState.channelId) && newState.channelId !== oldState.channelId;
    if (joined) {
      const createRoom = findChannel(guild, CREATE_ROOM_KEY, { voice: true });
      if (createRoom && newState.channelId === createRoom.id) {
        const member = newState.member ?? (await guild.members.fetch(newState.id));
        if (member && !member.user?.bot) await placeMember(guild, member, createRoom);
      }
    }

    const left = Boolean(oldState.channelId) && oldState.channelId !== newState.channelId;
    if (left && runtime.tempRooms?.has(oldState.channelId)) {
      pending = scheduleEmptyCheck(guild, oldState.channelId);
    }
  } catch (e) {
    log('Temp room error:', e.message);
  }
  return pending;
}

/**
 * Startup pass: deletes tracked rooms that are empty, forgets the ones whose channel is gone.
 * Rooms with people in them stay. Returns the counts for the startup log.
 * Note: the store is shared by every server the bot is in, so a room of another server is forgotten here
 * (not deleted). The bot runs in one server.
 */
export async function cleanupRooms(guild) {
  return withLock(async () => {
    await guild.channels.fetch();
    const rooms = await readRooms();
    const result = { deleted: 0, kept: 0, forgotten: 0 };
    for (const id of Object.keys(rooms)) {
      const channel = await liveChannel(guild, id);
      if (!channel) {
        delete rooms[id];
        result.forgotten++;
        continue;
      }
      if (channel.members.size > 0) {
        result.kept++;
        continue;
      }
      try {
        await channel.delete('Temporary room is empty (startup cleanup)');
        delete rooms[id];
        result.deleted++;
      } catch (e) {
        log(`[${guild.name}] could not delete temp room ${id}:`, e.message);
        result.kept++;
      }
    }
    await saveRooms(rooms);
    return result;
  });
}
