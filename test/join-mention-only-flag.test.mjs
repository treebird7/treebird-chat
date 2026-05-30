// Regression test for treebird-chat-join's --mention-only flag.
// The flag was previously absent: join always wired corrwait without
// --on-mention, so every freeform line woke every joined agent. This
// test asserts (a) the flag is documented in the usage line, and
// (b) the source actually forwards --on-mention to supervise().

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
  // Arg parsing handles the flag
  assert.match(JOIN_SRC, /argv\[i\] === '--mention-only'/, 'argv loop should recognise --mention-only');
  // Forwarding wires --on-mention into the supervise extraArgs (corrwait flag name)
  assert.match(
    JOIN_SRC,
    /if \(mentionOnly\) extraArgs\.push\('--on-mention'\)/,
    'when mentionOnly is set, --on-mention must be forwarded to the supervised corrwait'
  );
});
