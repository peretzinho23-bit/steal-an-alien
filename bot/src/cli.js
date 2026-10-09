import './env.js'; // fills process.env from bot/.env (no --env-file flag, works on any Node version)
import { createInterface } from 'node:readline/promises';
import { Client, GatewayIntentBits } from 'discord.js';
import { describeGuild, printGuild } from './inspect.js';
import { cleanupRoles, runSetup } from './setup.js';

const [command, ...flags] = process.argv.slice(2);
const { DISCORD_TOKEN, GUILD_ID } = process.env;

if (!DISCORD_TOKEN || !GUILD_ID) {
  console.error('Missing DISCORD_TOKEN or GUILD_ID. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

/** Destructive step: the person must type the exact server name (or pass --yes). */
async function confirmWipe(guild) {
  if (flags.includes('--yes')) return true;
  if (!process.stdin.isTTY) {
    console.error('Not an interactive terminal. Re-run with --yes to confirm the wipe.');
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log(`\nThis DELETES every channel and every role (except Owner) in "${guild.name}" and rebuilds the server.`);
  const answer = await rl.question(`Type the server name to confirm: `);
  rl.close();
  return answer.trim() === guild.name;
}

async function main() {
  const ready = new Promise((resolve) => client.once('clientReady', resolve));
  await client.login(DISCORD_TOKEN);
  await ready;
  const guild = await client.guilds.fetch(GUILD_ID);

  if (command === 'inspect') {
    printGuild(await describeGuild(guild));
    return;
  }

  if (command === 'setup') {
    const dryRun = flags.includes('--dry-run');
    if (!dryRun && !(await confirmWipe(guild))) {
      console.log('Cancelled. Nothing was changed.');
      return;
    }
    const result = await runSetup(guild, { dryRun });
    if (dryRun) return console.log('\nDry run only. Nothing was changed.');
    if (result.problems.length) {
      console.log(`\nDone with ${result.problems.length} problem(s):`);
      for (const p of result.problems) console.log(`  - ${p}`);
      process.exitCode = 2;
    } else {
      console.log('\nDone. Server rebuilt with no problems.');
    }
    return;
  }

  if (command === 'cleanup-roles') {
    const dryRun = flags.includes('--dry-run');
    const { leftovers, problems } = await cleanupRoles(guild, { dryRun });
    console.log(`\n${leftovers.length} leftover role(s): ${leftovers.join(', ') || '-'}`);
    for (const p of problems) console.log(`  - ${p}`);
    if (problems.length) process.exitCode = 2;
    return;
  }

  console.error(`Unknown command "${command}". Use: inspect | setup [--dry-run] [--yes] | cleanup-roles [--dry-run]`);
  process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error('FAILED:', err.message);
    process.exitCode = 1;
  })
  .finally(() => client.destroy());
