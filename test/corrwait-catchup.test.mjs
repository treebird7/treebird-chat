// Tests for corrwait --catchup mode.
// Strategy: spawn corrwait as a child process and verify stdout JSON + exit code.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, writeFileSync as wf } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CORRWAIT = fileURLToPath(new URL('../bin/corrwait.mjs', import.meta.url));
const AGENT = 'testbot';

function fixture(content = '') {
  const dir = mkdtempSync(join(tmpdir(), 'corrwait-catchup-'));
  const file = join(dir, 'chat.md');
  writeFileSync(file, content);
  // minimal ACL so corrwait passes the isAllowed check
  writeFileSync(`${file}.access.json`, JSON.stringify({ owner: 'test', agents: { [AGENT]: { allowed: true } } }));
  return {
    file,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function run(file, extraArgs = []) {
  const result = spawnSync(
    process.execPath,
    [CORRWAIT, file, '--as', AGENT, '--catchup', ...extraArgs],
    { encoding: 'utf8', env: { ...process.env, ENVOAK_AGENT_LABEL: AGENT } }
  );
  let json = null;
  try { json = JSON.parse(result.stdout.trim()); } catch { /* leave null */ }
  return { status: result.status, json, stderr: result.stderr };
}

test('catchup on empty file emits CATCHUP with woke=false and exits 0', () => {
  const { file, cleanup } = fixture('');
  try {
    const { status, json } = run(file);
    assert.equal(status, 0);
    assert.equal(json.reason, 'CATCHUP');
    assert.equal(json.woke, false);
    assert.equal(json.newContent, undefined); // lean default: no newContent without --raw
    assert.deepEqual(json.wakeLines, []);
  } finally { cleanup(); }
});

test('catchup with new foreign content emits CATCHUP with woke=true', () => {
  const { file, cleanup } = fixture('[10:00 alice] hello\n');
  try {
    const { status, json } = run(file);
    assert.equal(status, 0);
    assert.equal(json.reason, 'CATCHUP');
    assert.equal(json.woke, true);
    assert.equal(json.newContent, undefined); // lean default: delta carried by wakeLines
    assert.ok(json.wakeLines.some((l) => l.includes('[10:00 alice] hello')));
  } finally { cleanup(); }
});

test('catchup with only self-authored content emits CATCHUP with woke=false', () => {
  // testbot's own line: cursor lands after it, so it's in baseline → newLines is empty
  const { file, cleanup } = fixture(`[10:00 ${AGENT}] my own message\n`);
  try {
    const { status, json } = run(file);
    assert.equal(status, 0);
    assert.equal(json.reason, 'CATCHUP');
    assert.equal(json.woke, false);
    assert.equal(json.newContent, undefined);
  } finally { cleanup(); }
});

test('catchup advances cursor so second catchup sees nothing new', () => {
  const { file, cleanup } = fixture('[10:00 alice] hello\n');
  try {
    // First catchup — sees alice's line
    const first = run(file);
    assert.equal(first.json.woke, true);

    // Second catchup on same file — cursor advanced, no new content
    const second = run(file);
    assert.equal(second.json.reason, 'CATCHUP');
    assert.equal(second.json.woke, false);
    assert.equal(second.json.newContent, undefined);
  } finally { cleanup(); }
});

test('newContent omitted by default; wakeLines carries the delta (lean payload)', () => {
  const { file, cleanup } = fixture('[10:00 alice] hello\n');
  try {
    const { json } = run(file);
    assert.equal(json.woke, true);
    assert.equal(json.newContent, undefined);
    assert.ok(json.wakeLines.some((l) => l.includes('[10:00 alice] hello')));
  } finally { cleanup(); }
});

test('--raw includes newContent alongside wakeLines', () => {
  const { file, cleanup } = fixture('[10:00 alice] hello\n');
  try {
    const { json } = run(file, ['--raw']);
    assert.equal(json.woke, true);
    assert.ok(json.newContent.includes('[10:00 alice] hello'));
    assert.ok(json.wakeLines.some((l) => l.includes('[10:00 alice] hello')));
  } finally { cleanup(); }
});

test('catchup respects --on-mention: only wakes on @mention lines', () => {
  const content = [
    '[10:00 alice] general comment',
    `[10:01 alice] hey @${AGENT} wake up`,
  ].join('\n') + '\n';
  const { file, cleanup } = fixture(content);
  try {
    const { json } = run(file, ['--on-mention']);
    assert.equal(json.woke, true);
    assert.equal(json.wakeLines.length, 1);
    assert.ok(json.wakeLines[0].includes(`@${AGENT}`));
  } finally { cleanup(); }
});

test('catchup and --write are mutually exclusive', () => {
  const { file, cleanup } = fixture('');
  try {
    const result = spawnSync(
      process.execPath,
      [CORRWAIT, file, '--as', AGENT, '--catchup', '--write', 'hello'],
      { encoding: 'utf8', env: { ...process.env, ENVOAK_AGENT_LABEL: AGENT } }
    );
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes('mutually exclusive'));
  } finally { cleanup(); }
});
