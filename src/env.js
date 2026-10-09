import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Parses KEY=VALUE lines (comments, blank lines, quotes and a BOM are handled). */
export function parseEnv(text) {
  const out = {};
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = line.slice(eq + 1).trim();
    const quoted = (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
    if (quoted && value.length >= 2) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

/**
 * Loads the .env next to package.json into process.env without overriding variables that are already set,
 * so a host's real environment variables always win. Written by hand because process.loadEnvFile
 * does not exist on Node 18, which some bot hosts still run.
 */
export function loadEnv(file = fileURLToPath(new URL('../.env', import.meta.url))) {
  if (!existsSync(file)) return;
  for (const [key, value] of Object.entries(parseEnv(readFileSync(file, 'utf8')))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnv();
