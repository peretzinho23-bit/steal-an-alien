import './env.js'; // must stay first: fills process.env from .env before anything reads it
import { fileURLToPath } from 'node:url';
import { Client, Events, GatewayIntentBits, MessageFlags, Partials } from 'discord.js';
import { MEMBER_ROLE_KEY, ROLES } from './blueprint.js';
import { handleCommand, registerCommands } from './commands/index.js';
import { memberWelcome } from './content.js';
import { syncCommandGuide } from './guide.js';
import { LevelStore } from './levels/store.js';
import { ensureRankRoles, LevelSystem } from './levels/system.js';
import { registerLogs } from './logs.js';
import { initRuntime, refreshSettings, runtime } from './runtime.js';
import { startScheduler } from './scheduler.js';
import { ensureMissingChannels } from './setup.js';
import { handleTicketButton } from './tickets.js';
import { findChannel, findRole } from './util.js';

const { DISCORD_TOKEN, DATA_DIR } = process.env;
if (!DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const memberRoleName = ROLES.find((r) => r.key === MEMBER_ROLE_KEY).name;
const log = (...args) => console.log(new Date().toISOString(), ...args);

// XP and the local settings fallback live in files under DATA_DIR. On a host, point DATA_DIR at a persistent volume.
const dataDir = (DATA_DIR ?? fileURLToPath(new URL('../data/', import.meta.url))).replace(/[\\/]$/, '');
const store = new LevelStore(`${dataDir}/levels.json`);
const levels = new LevelSystem(store);
initRuntime(dataDir);

async function prepareGuild(guild) {
  const steps = [
    ['commands', () => registerCommands(guild).then(() => 'registered')],
    ['rank roles', () => ensureRankRoles(guild).then((created) => (created.length ? `created ${created.join(', ')}` : 'ok'))],
    ['channels', () => ensureMissingChannels(guild).then((created) => (created.length ? `created ${created.join(', ')}` : 'ok'))],
    ['command guide', () => syncCommandGuide(guild)],
  ];
  for (const [name, step] of steps) {
    try {
      log(`[${guild.name}] ${name}: ${await step()}`);
    } catch (e) {
      log(`[${guild.name}] ${name} FAILED:`, e.message);
    }
  }
}

/** Privileged intents must be switched on in the Developer Portal; without them those features are skipped, not fatal. */
const ATTEMPTS = [
  { members: true, content: true },
  { members: true, content: false },
  { members: false, content: false },
];

function createClient(features) {
  const intents = [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildModeration,
  ];
  if (features.members) intents.push(GatewayIntentBits.GuildMembers);
  if (features.content) intents.push(GatewayIntentBits.MessageContent);
  const client = new Client({ intents, partials: [Partials.Channel, Partials.Message] });
  client.levels = levels;

  client.once(Events.ClientReady, async (c) => {
    runtime.features = features;
    log(`Logged in as ${c.user.tag} in ${c.guilds.cache.size} server(s). Member events: ${features.members ? 'ON' : 'OFF'}, message content: ${features.content ? 'ON' : 'OFF'}`);
    await refreshSettings();
    for (const guild of c.guilds.cache.values()) await prepareGuild(guild);
    levels.start(c);
    startScheduler(c);
  });

  client.on(Events.GuildCreate, (guild) => prepareGuild(guild));

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) await handleCommand(interaction);
      else if (interaction.isButton()) await handleTicketButton(interaction);
    } catch (e) {
      log(`Interaction error (${interaction.commandName ?? interaction.customId}):`, e);
      const reply = { content: 'Something went wrong. Please try again or ask a staff member.', flags: MessageFlags.Ephemeral };
      if (interaction.deferred || interaction.replied) await interaction.followUp(reply).catch(() => {});
      else await interaction.reply(reply).catch(() => {});
    }
  });

  client.on(Events.GuildMemberAdd, async (member) => {
    if (member.user.bot) return;
    try {
      const role = findRole(member.guild, memberRoleName);
      if (role) await member.roles.add(role, 'New member').catch((e) => log('Could not give Member role:', e.message));
      const welcome = findChannel(member.guild, 'welcome');
      if (welcome) await welcome.send(memberWelcome(member));
    } catch (e) {
      log('Welcome error:', e);
    }
  });

  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot || !message.guild) return;
    await levels.onMessage(message).catch((e) => log('XP error:', e.message));

    // Suggestions: add the voting reactions to every new message.
    if (message.channelId !== findChannel(message.guild, 'suggestions')?.id) return;
    try {
      await message.react('👍');
      await message.react('👎');
    } catch (e) {
      log('Could not add suggestion reactions:', e.message);
    }
  });

  registerLogs(client);
  client.on(Events.Error, (e) => log('Client error:', e));
  return client;
}

async function main() {
  for (const features of ATTEMPTS) {
    const client = createClient(features);
    try {
      await client.login(DISCORD_TOKEN);
      return;
    } catch (e) {
      if (!/disallowed intents/i.test(e.message)) throw e;
      await client.destroy();
      log(`Discord refused the privileged intents (members: ${features.members}, message content: ${features.content}). Trying with fewer.`);
      log('Switch them on at https://discord.com/developers/applications -> Bot -> Privileged Gateway Intents (Server Members + Message Content).');
    }
  }
  throw new Error('Discord refused every intent combination');
}

// Save everything on the way out (Ctrl+C, window closed, host restart).
const flush = () => {
  store.flush();
  runtime.kv?.flush?.();
};
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    flush();
    process.exit(0);
  });
}
process.on('exit', flush);
process.on('unhandledRejection', (e) => log('Unhandled rejection:', e));
main().catch((e) => {
  log('Fatal:', e.message);
  process.exit(1);
});
