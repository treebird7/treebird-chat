// Tests for corrwait --ack <ref> mode (0.3.7 token-cost fast-follow).
// Strategy: spawn corrwait as a child process and verify stdout JSON, exit
// code, the appended receipt line, and that the cursor advanced (mark-as-read).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CORRWAIT = fileURLToPath(new URL('../bin/corrwait.mjs', import.meta.url));
const AGENT = 'testbot';

function fixture(content = '') {
  const dir = mkdtempSync(join(tmpdir(), 'corrwait-ack-'));
  const file = join(dir, 'chat.md');
  writeFileSync(file, content);
  writeFileSync(`${file}.access.json`, JSON.stringify({ owner: 'test', agents: { [AGENT]: { allowed: true } } }));
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function run(file, extraArgs = []) {
  const result = spawnSync(
    process.execPath,
    [CORRWAIT, file, '--as', AGENT, ...extraArgs],
    { encoding: 'utf8', env: { ...process.env, ENVOAK_AGENT_LABEL: AGENT } }
  );
  let json = null;
  try { json = JSON.parse(result.stdout.trim()); } catch { /* leave null */ }
  return { status: result.status, json, stderr: result.stderr };
}

test('--ack posts a receipt line, emits ACKED, and exits 0', () => {
  const { file, cleanup } = fixture('[10:00 alice] can you take the merge?\n');
  try {
    const { status, json } = run(file, ['--ack', 'merge']);
    assert.equal(status, 0);
    assert.equal(json.reason, 'ACKED');
    assert.equal(json.ref, 'merge');
    assert.equal(json.agent, AGENT);
    const body = readFileSync(file, 'utf8');
    assert.match(body, /\[\d{2}:\d{2} testbot\] ✓ ack merge\n$/, 'receipt line should be appended in flat format');
  } finally { cleanup(); }
});

test('--ack advances the cursor so the acked content does not re-surface', () => {
  const { file, cleanup } = fixture('[10:00 alice] please review\n');
  try {
    run(file, ['--ack', 'review']);
    // After acking, a --catchup should report nothing new (cursor advanced past
    // alice's line AND our own receipt).
    const res = spawnSync(
      process.execPath,
      [CORRWAIT, file, '--as', AGENT, '--catchup'],
      { encoding: 'utf8', env: { ...process.env, ENVOAK_AGENT_LABEL: AGENT } }
    );
    const json = JSON.parse(res.stdout.trim());
    assert.equal(json.reason, 'CATCHUP');
    assert.equal(json.woke, false, 'acked content must not re-surface on the next catchup');
  } finally { cleanup(); }
});

test('--ack with an empty ref errors (exit 4)', () => {
  const { file, cleanup } = fixture('');
  try {
    const { status } = run(file, ['--ack', '']);
    assert.equal(status, 4, 'empty --ref should be a usage error');
  } finally { cleanup(); }
});

test('--ack and --write are mutually exclusive (exit 4)', () => {
  const { file, cleanup } = fixture('');
  try {
    const { status, stderr } = run(file, ['--ack', 'x', '--write', 'y']);
    assert.equal(status, 4);
    assert.match(stderr, /mutually exclusive/);
  } finally { cleanup(); }
});

test('--ack receipt carries CR/LF-stripped ref (no line injection)', () => {
  const { file, cleanup } = fixture('');
  try {
    run(file, ['--ack', 'line1\nline2']);
    const body = readFileSync(file, 'utf8').trimEnd();
    assert.equal(body.split('\n').length, 1, 'a newline in the ref must not split into two lines');
    assert.match(body, /✓ ack line1 line2$/);
  } finally { cleanup(); }
});
