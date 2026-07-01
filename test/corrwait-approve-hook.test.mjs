// Tests for corrwait's SPEC_identity-verification §3 approve-hook gate.
// Strategy: spawn corrwait as a child process (same pattern as
// corrwait-ack.test.mjs) and drive TREEBIRD_CHAT_APPROVE_HOOK via a small
// shell script fixture rather than mocking — this exercises the real
// spawn path end to end.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CORRWAIT = fileURLToPath(new URL('../bin/corrwait.mjs', import.meta.url));
const AGENT = 'cc2'; // unverified: identity comes from --as, not envoak

function fixture(content = '') {
  const dir = mkdtempSync(join(tmpdir(), 'corrwait-approve-'));
  const file = join(dir, 'chat.md');
  writeFileSync(file, content);
  writeFileSync(`${file}.access.json`, JSON.stringify({ owner: 'test', agents: { [AGENT]: { allowed: true } } }));
  return { dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function scriptFixture(dir, name, exitCode) {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\ncat > /dev/null\nexit ${exitCode}\n`);
  chmodSync(p, 0o755);
  return p;
}

function run(file, extraArgs, extraEnv = {}) {
  const result = spawnSync(
    process.execPath,
    [CORRWAIT, file, '--as', AGENT, ...extraArgs],
    { encoding: 'utf8', env: { ...process.env, ...extraEnv } }
  );
  let json = null;
  try { json = JSON.parse(result.stdout.trim()); } catch { /* leave null */ }
  return { status: result.status, json, stderr: result.stderr };
}

function envWithoutHook(extra = {}) {
  const env = { ...extra };
  delete env.TREEBIRD_CHAT_APPROVE_HOOK;
  return env;
}

test('no hook configured: --write proceeds and marks the name approved (default allow)', () => {
  const { file, cleanup } = fixture('');
  try {
    const { status, json } = run(file, ['--write', 'hi'], envWithoutHook());
    assert.equal(status, 0);
    assert.equal(json.reason, 'WROTE');
    const acl = JSON.parse(readFileSync(`${file}.access.json`, 'utf8'));
    assert.equal(acl.agents[AGENT].approved_unverified, true, 'default-allow persists the marker');
  } finally { cleanup(); }
});

test('hook configured to approve (exit 0): --write proceeds', () => {
  const { dir, file, cleanup } = fixture('');
  try {
    const hook = scriptFixture(dir, 'approve.sh', 0);
    const { status, json } = run(file, ['--write', 'hi'], { TREEBIRD_CHAT_APPROVE_HOOK: hook });
    assert.equal(status, 0);
    assert.equal(json.reason, 'WROTE');
    const body = readFileSync(file, 'utf8');
    assert.match(body, /hi/);
  } finally { cleanup(); }
});

test('hook configured to refuse (non-zero exit): --write is blocked, nothing lands in the file', () => {
  const { dir, file, cleanup } = fixture('');
  try {
    const hook = scriptFixture(dir, 'deny.sh', 1);
    const { status, json } = run(file, ['--write', 'hi'], { TREEBIRD_CHAT_APPROVE_HOOK: hook });
    assert.equal(status, 3, 'refused approval exits REVOKED (3)');
    assert.equal(json.reason, 'UNAPPROVED');
    const body = readFileSync(file, 'utf8');
    assert.equal(body, '', 'refused write must not land in the chat file');
    const acl = JSON.parse(readFileSync(`${file}.access.json`, 'utf8'));
    assert.notEqual(acl.agents[AGENT].approved_unverified, true, 'refusal does not mark approved');
  } finally { cleanup(); }
});

test('once approved, a second invocation does not re-run the hook (once-per-name)', () => {
  const { dir, file, cleanup } = fixture('');
  try {
    // First call: hook approves and the approval should persist.
    const approveHook = scriptFixture(dir, 'approve.sh', 0);
    run(file, ['--write', 'first'], { TREEBIRD_CHAT_APPROVE_HOOK: approveHook });

    // Second call: swap in a hook that would refuse if invoked — if the
    // approval is properly cached, this hook must never run.
    const denyHook = scriptFixture(dir, 'deny.sh', 1);
    const { status, json } = run(file, ['--write', 'second'], { TREEBIRD_CHAT_APPROVE_HOOK: denyHook });
    assert.equal(status, 0, 'a cached approval must not re-trigger the hook');
    assert.equal(json.reason, 'WROTE');
  } finally { cleanup(); }
});
