import { fileURLToPath } from 'node:url';
import { Client, Events, GatewayIntentBits, MessageFlags, Partials } from 'discord.js';
import { MEMBER_ROLE_KEY, ROLES } from './blueprint.js';
import { handleCommand, registerCommands } from './commands/index.js';
import { memberWelcome } from './content.js';
import { syncCommandGuide } from './guide.js';
import { LevelStore } from './levels/store.js';
import { ensureRankRoles, LevelSystem } from './levels/system.js';
import { handleTicketButton } from './tickets.js';
import { findChannel, findRole } from './util.js';

const { DISCORD_TOKEN, DATA_DIR } = process.env;
if (!DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const memberRoleName = ROLES.find((r) => r.key === MEMBER_ROLE_KEY).name;
const log = (...args) => console.log(new Date().toISOString(), ...args);

// XP lives in one JSON file. On a host, point DATA_DIR at a persistent volume so it survives restarts.
const dataDir = DATA_DIR ?? fileURLToPath(new URL('../data/', import.meta.url));
const store = new LevelStore(`${dataDir.replace(/[\\/]$/, '')}/levels.json`);
const levels = new LevelSystem(store);

async function prepareGuild(guild) {
  const steps = [
    ['commands', () => registerCommands(guild).then(() => 'registered')],
    ['rank roles', () => ensureRankRoles(guild).then((created) => (created.length ? `created ${created.join(', ')}` : 'ok'))],
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

function createClient({ withMembers }) {
  const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildVoiceStates];
  if (withMembers) intents.push(GatewayIntentBits.GuildMembers); // privileged: enable it in the Developer Portal
  const client = new Client({ intents, partials: [Partials.Channel] });
  client.levels = levels;

  client.once(Events.ClientReady, async (c) => {
    log(`Logged in as ${c.user.tag} in ${c.guilds.cache.size} server(s). Member events: ${withMembers ? 'ON' : 'OFF'}`);
    for (const guild of c.guilds.cache.values()) await prepareGuild(guild);
    levels.start(c);
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

  client.on(Events.Error, (e) => log('Client error:', e));
  return client;
}

async function main() {
  let client = createClient({ withMembers: true });
  try {
    await client.login(DISCORD_TOKEN);
  } catch (e) {
    if (!/disallowed intents/i.test(e.message)) throw e;
    log('Server Members Intent is OFF in the Developer Portal, so welcome messages are disabled.');
    log('Enable it at https://discord.com/developers/applications -> Bot -> Server Members Intent, then restart.');
    await client.destroy();
    client = createClient({ withMembers: false });
    await client.login(DISCORD_TOKEN);
  }
}

// Save the XP on the way out (Ctrl+C, window closed, host restart).
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    store.flush();
    process.exit(0);
  });
}
process.on('exit', () => store.flush());
process.on('unhandledRejection', (e) => log('Unhandled rejection:', e));
main().catch((e) => {
  log('Fatal:', e.message);
  process.exit(1);
});
