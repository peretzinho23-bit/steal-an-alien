import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadEnv, parseEnv } from '../src/env.js';

test('parseEnv: plain pairs, comments, blanks, quotes, export prefix, BOM, CRLF', () => {
  const text = '﻿# comment\r\nDISCORD_TOKEN=abc.def-ghi\r\n\r\nGUILD_ID = 123 \r\nQUOTED="a b"\nSINGLE=\'x\'\nexport EXPORTED=1\nEMPTY=\nNOEQUALS\n=nokey\n';
  assert.deepEqual(parseEnv(text), {
    DISCORD_TOKEN: 'abc.def-ghi',
    GUILD_ID: '123',
    QUOTED: 'a b',
    SINGLE: 'x',
    EXPORTED: '1',
    EMPTY: '',
  });
});

test('parseEnv: a value may contain = signs (tokens and URLs do)', () => {
  assert.equal(parseEnv('A=b=c==').A, 'b=c==');
});

test('loadEnv: fills missing variables, never overrides existing ones, tolerates a missing file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'saa-env-'));
  try {
    const file = join(dir, '.env');
    writeFileSync(file, 'SAA_TEST_NEW=from-file\nSAA_TEST_KEEP=from-file\n');
    process.env.SAA_TEST_KEEP = 'from-host';
    delete process.env.SAA_TEST_NEW;
    loadEnv(file);
    assert.equal(process.env.SAA_TEST_NEW, 'from-file');
    assert.equal(process.env.SAA_TEST_KEEP, 'from-host');
    assert.doesNotThrow(() => loadEnv(join(dir, 'missing.env')));
  } finally {
    delete process.env.SAA_TEST_NEW;
    delete process.env.SAA_TEST_KEEP;
    rmSync(dir, { recursive: true, force: true });
  }
});
