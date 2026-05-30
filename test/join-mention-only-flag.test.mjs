// Regression tests for treebird-chat-join's --mention-only flag.
//
// Pre-PR: join always wired corrwait without --on-mention, so every
// freeform line in a chat woke every joined agent. These tests assert
// (a) the flag is documented in the usage line, (b) the source parses
// and forwards it, and (c) supervise() forwards extraArgs to BOTH the
// main runOnce and the catchup runOnce (regression for the bug where
// --catchup hardcoded its extraArgs and silently dropped the caller's
// filter on restart).

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const JOIN_BIN = join(__dir, '..', 'bin', 'treebird-chat-join.mjs');
const JOIN_SRC = readFileSync(JOIN_BIN, 'utf8');

test('--mention-only appears in the usage line emitted on missing chatId', () => {
  const res = spawnSync('node', [JOIN_BIN], { encoding: 'utf8' });
  assert.equal(res.status, 1, 'should exit 1 without a chatId');
  assert.match(res.stderr, /--mention-only/, 'usage line should advertise --mention-only');
});

test('source parses --mention-only and forwards --on-mention to corrwait supervise', () => {
  assert.match(JOIN_SRC, /argv\[i\] === '--mention-only'/, 'argv loop should recognise --mention-only');
  assert.match(
    JOIN_SRC,
    /extraArgs\.push\(\s*['"]--on-mention['"]\s*\)/,
    'when mentionOnly is set, --on-mention must be forwarded to the supervised corrwait'
  );
});

// Integration test: stub corrwaitBin that records its argv, then run
// supervise() with extraArgs and verify both main and catchup runs
// receive the flag. This catches the bug where supervisor hardcoded
// extraArgs:['--catchup'] and dropped the caller's filter.
test('supervise() forwards extraArgs to BOTH main and catchup runs', async () => {
  const { supervise } = await import('../lib/corrwait-supervisor.mjs');

  const dir = mkdtempSync(join(tmpdir(), 'sup-extraargs-'));
  const argvLog = join(dir, 'argv.log');
  const chatFile = join(dir, 'chat.md');
  writeFileSync(chatFile, '[12:00 alice] hello\n');
  writeFileSync(argvLog, '');

  // Stub corrwait: emits CATCHUP on --catchup, TIMEOUT otherwise (clean
  // idle exit so supervise stops). Records argv for assertion.
  const stubBin = join(dir, 'stub-corrwait.mjs');
  writeFileSync(stubBin, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(argvLog)}, argv.join(' ') + '\\n');
if (argv.includes('--catchup')) {
  process.stdout.write(JSON.stringify({ reason: 'CATCHUP', newContent: '', wakeLines: [] }) + '\\n');
} else {
  process.stdout.write(JSON.stringify({ reason: 'TIMEOUT' }) + '\\n');
}
process.exit(0);
`);
  chmodSync(stubBin, 0o755);

  await supervise({
    corrwaitBin: stubBin,
    filePath: chatFile,
    agent: 'alice',
    extraArgs: ['--on-mention'],
    timeoutSec: 1,
    catchup: true,
    onWake: () => {},
    stderrPassthrough: false,
  });

  const log = readFileSync(argvLog, 'utf8').trim().split('\n').filter(Boolean);
  assert.ok(log.length >= 2,
    `expected ≥2 corrwait invocations (catchup + main), got ${log.length}: ${log.join(' || ')}`);

  const catchupInvocation = log.find(line => line.includes('--catchup'));
  assert.ok(catchupInvocation, 'catchup invocation should have happened');
  assert.match(catchupInvocation, /--on-mention/,
    'REGRESSION: catchup pass dropped caller extraArgs — restarting mention-only agents would wake on backlog');

  const mainInvocation = log.find(line => !line.includes('--catchup'));
  assert.ok(mainInvocation, 'main invocation should have happened');
  assert.match(mainInvocation, /--on-mention/, 'main pass must forward extraArgs');
});
