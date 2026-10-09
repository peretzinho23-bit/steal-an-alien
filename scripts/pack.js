// Builds dist/steal-an-alien-bot.zip: everything a host needs, nothing it should install itself.
// The zip contains .env (the bot token), so treat it like a password and never share or commit it.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist', 'steal-an-alien-bot.zip');
const files = ['src', 'package.json', 'package-lock.json', '.env'];

for (const f of files) {
  if (!existsSync(join(root, f))) {
    console.error(`Missing ${f}${f === '.env' ? ' (create it from .env.example first)' : ''}`);
    process.exit(1);
  }
}

mkdirSync(dirname(out), { recursive: true });
rmSync(out, { force: true });
// bsdtar (built into Windows 10+) writes forward-slash paths, which Linux hosts need;
// PowerShell 5's Compress-Archive writes backslashes that break there.
execFileSync('tar', ['-a', '-c', '-f', out, '-C', root, ...files], { stdio: 'inherit' });
console.log(`Created ${out}`);
