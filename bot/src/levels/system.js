import { RANKS } from '../blueprint.js';
import { findChannel } from '../util.js';
import { levelFromXp, randomXp, rankForLevel } from './math.js';

export const MESSAGE_COOLDOWN_MS = 60_000;
export const VOICE_TICK_MS = 60_000;
export const VOICE_XP = 10;

const log = (...args) => console.log(new Date().toISOString(), ...args);

/** Creates any rank role that is missing (highest tier first, so higher tiers end up higher). */
export async function ensureRankRoles(guild) {
  await guild.roles.fetch();
  const created = [];
  for (const rank of [...RANKS].reverse()) {
    if (guild.roles.cache.some((r) => r.name === rank.name)) continue;
    await guild.roles.create({ name: rank.name, colors: { primaryColor: rank.color }, mentionable: false, reason: 'Rank system' });
    created.push(rank.name);
  }
  return created;
}

export class LevelSystem {
  constructor(store) {
    this.store = store;
    this.cooldowns = new Map(); // "guildId:userId" -> timestamp of the last XP message
  }

  /** XP for chatting: once per cooldown, random 15-25. */
  async onMessage(message) {
    if (message.author.bot || !message.guild) return;
    const key = `${message.guild.id}:${message.author.id}`;
    const now = Date.now();
    if (now - (this.cooldowns.get(key) ?? 0) < MESSAGE_COOLDOWN_MS) return;
    this.cooldowns.set(key, now);

    const member = message.member ?? (await message.guild.members.fetch(message.author.id).catch(() => null));
    if (!member) return;
    await this.grant(member, randomXp(), message.channel, { message: true });
  }

  /** XP for sitting in voice with at least one other person (not deafened, not in the AFK channel). */
  async voiceTick(client) {
    for (const guild of client.guilds.cache.values()) {
      const general = findChannel(guild, 'general');
      for (const channel of guild.channels.cache.values()) {
        if (!channel.isVoiceBased() || channel.id === guild.afkChannelId) continue;
        const humans = [...channel.members.values()].filter((m) => !m.user.bot);
        if (humans.length < 2) continue;
        for (const member of humans) {
          if (member.voice.deaf) continue;
          await this.grant(member, VOICE_XP, general).catch((e) => log('voice xp:', e.message));
        }
      }
    }
  }

  start(client) {
    this.timer = setInterval(() => this.voiceTick(client).catch((e) => log('voice tick:', e.message)), VOICE_TICK_MS);
    this.timer.unref?.();
  }

  /** Adds XP, syncs the rank role when the level changed and announces a level-up. */
  async grant(member, amount, announceIn, { message = false } = {}) {
    const { guild, id } = member;
    const before = levelFromXp(this.store.get(guild.id, id).xp).level;
    const total = this.store.add(guild.id, id, amount, { message });
    const after = levelFromXp(total).level;
    if (after === before) return { before, after };

    await this.syncRank(member, after);
    if (after > before && announceIn?.send) {
      const rank = rankForLevel(after);
      const newTier = rank && rank.level === after;
      await announceIn
        .send({
          content: `🎉 ${member} reached **level ${after}**${newTier ? ` and is now a **${rank.name}**` : ''}!`,
          allowedMentions: { users: [id] },
        })
        .catch((e) => log('level-up message:', e.message));
    }
    return { before, after };
  }

  /** Gives the member exactly one rank role: the highest tier for their level. */
  async syncRank(member, level) {
    const rankRoles = RANKS.map((r) => member.guild.roles.cache.find((role) => role.name === r.name)).filter(Boolean);
    const wanted = rankForLevel(level);
    const wantedRole = wanted && rankRoles.find((r) => r.name === wanted.name);
    const toRemove = rankRoles.filter((r) => r !== wantedRole && member.roles.cache.has(r.id));
    try {
      if (toRemove.length) await member.roles.remove(toRemove, 'Rank update');
      if (wantedRole && !member.roles.cache.has(wantedRole.id)) await member.roles.add(wantedRole, 'Rank update');
    } catch (e) {
      log(`Could not update the rank role of ${member.user.tag}:`, e.message);
    }
  }
}
