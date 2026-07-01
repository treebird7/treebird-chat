import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ALLOW_BIN = fileURLToPath(new URL('../bin/treebird-chat-allow.mjs', import.meta.url));
const DENY_BIN = fileURLToPath(new URL('../bin/treebird-chat-deny.mjs', import.meta.url));

function fixture(prefix = 'envoak-cli-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const file = join(dir, 'chat.md');
  writeFileSync(file, '');
  return { dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function envWithGateUnset(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.TREEBIRD_CHAT_REQUIRE_ENVOAK;
  return env;
}

function readAcl(file) {
  return JSON.parse(readFileSync(`${file}.access.json`, 'utf8'));
}

function installLockedFakeEnvoak(dir) {
  const fakeBinDir = join(dir, 'bin');
  mkdirSync(fakeBinDir);
  const fakeEnvoak = join(fakeBinDir, 'envoak');
  writeFileSync(fakeEnvoak, '#!/bin/sh\nprintf "%s\\n" "needs_reauth" >&2\nexit 1\n');
  chmodSync(fakeEnvoak, 0o755);
  return fakeBinDir;
}

test('treebird-chat-allow keeps existing behavior when envoak gate is off', () => {
  const { file, cleanup } = fixture('envoak-cli-allow-');
  try {
    const result = spawnSync(
      process.execPath,
      [ALLOW_BIN, file, 'testbot', '--owner', 'ownerbot'],
      { encoding: 'utf8', env: envWithGateUnset() },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /testbot allowed on/);
    assert.match(result.stdout, /acl:/);

    const acl = readAcl(file);
    assert.equal(acl.owner, 'ownerbot');
    assert.equal(acl.agents.testbot.allowed, true);
    assert.match(acl.agents.testbot.joined_at, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    cleanup();
  }
});

test('treebird-chat-deny keeps existing behavior when envoak gate is off', () => {
  const { file, cleanup } = fixture('envoak-cli-deny-');
  try {
    const result = spawnSync(
      process.execPath,
      [DENY_BIN, file, 'testbot'],
      { encoding: 'utf8', env: envWithGateUnset() },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /testbot denied on/);
    assert.match(result.stdout, /acl:/);

    const acl = readAcl(file);
    assert.equal(acl.agents.testbot.allowed, false);
  } finally {
    cleanup();
  }
});

test('treebird-chat-allow refuses before writing the ACL when the envoak gate is locked', () => {
  const { dir, file, cleanup } = fixture('envoak-cli-locked-');
  try {
    const fakeBinDir = installLockedFakeEnvoak(dir);

    const result = spawnSync(
      process.execPath,
      [ALLOW_BIN, file, 'testbot'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          TREEBIRD_CHAT_REQUIRE_ENVOAK: '1',
          PATH: `${fakeBinDir}:${process.env.PATH || ''}`,
        },
      },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /envoak vault unlock/);
    assert.equal(existsSync(`${file}.access.json`), false, 'locked gate must not write ACL sidecar');
  } finally {
    cleanup();
  }
});

test('treebird-chat-deny refuses before changing the ACL when the envoak gate is locked', () => {
  const { dir, file, cleanup } = fixture('envoak-cli-deny-locked-');
  try {
    writeFileSync(`${file}.access.json`, JSON.stringify({
      owner: 'ownerbot',
      agents: { testbot: { allowed: true, joined_at: '2026-01-01T00:00:00.000Z' } },
    }, null, 2));
    const before = readFileSync(`${file}.access.json`, 'utf8');
    const fakeBinDir = installLockedFakeEnvoak(dir);

    const result = spawnSync(
      process.execPath,
      [DENY_BIN, file, 'testbot'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          TREEBIRD_CHAT_REQUIRE_ENVOAK: 'true',
          PATH: `${fakeBinDir}:${process.env.PATH || ''}`,
        },
      },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /envoak vault unlock/);
    assert.equal(readFileSync(`${file}.access.json`, 'utf8'), before);
  } finally {
    cleanup();
  }
});
