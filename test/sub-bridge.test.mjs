import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { subChatId, spawnSubBridge } from '../lib/sub-bridge.mjs';

// ── subChatId — pure ──────────────────────────────────────────────────────────

test('subChatId composes parent + topic in the documented format', () => {
  assert.equal(subChatId('nightjar', 'run-3'), 'nightjar-sub-run-3');
});

test('subChatId sanitises topic to the smalltoak chat-id alphabet', () => {
  // Mirrors lib/wikilink.mjs resolveSub() and bin/treebird-chat-join.mjs:41.
  assert.equal(subChatId('nightjar', '../../etc/passwd'), 'nightjar-sub-------etc-passwd');
  assert.equal(subChatId('nightjar', 'a b c'), 'nightjar-sub-a-b-c');
  assert.equal(subChatId('nightjar', 'ALL_lowercase-AND-Digits-1234'), 'nightjar-sub-ALL_lowercase-AND-Digits-1234');
});

test('subChatId is deterministic across machines (same input → same id)', () => {
  const a = subChatId('x', 'topic');
  const b = subChatId('x', 'topic');
  assert.equal(a, b);
});

// ── spawnSubBridge — early-exit paths (no real spawn) ─────────────────────────
//
// We avoid actually spawning a bridge process; tests must not leave bridges
// running. We exercise the no-op paths instead: missing sub file, unregistered
// parent, missing token. Each returns { spawned: false, reason: <string> }.

test('spawnSubBridge returns false-reason when sub file does not exist', () => {
  const r = spawnSubBridge({
    parentFile: '/whatever',
    subFile: '/no/such/file.md',
    subTopic: 'topic',
    agent: 'tester',
  });
  assert.equal(r.spawned, false);
  assert.match(r.reason, /does not exist/);
});

test('spawnSubBridge returns false-reason when parent is unregistered', () => {
  // Make a sub file but never register the parent in sessions.json.
  const dir = mkdtempSync(join(tmpdir(), 'sub-bridge-test-'));
  try {
    const sub = join(dir, 'sub.md');
    writeFileSync(sub, '<!-- sub -->\n');
    // Use a parentFile path nothing knows about.
    const parent = join(dir, 'unregistered-parent.md');
    writeFileSync(parent, '');

    const r = spawnSubBridge({
      parentFile: parent, subFile: sub, subTopic: 'topic', agent: 'tester',
    });
    assert.equal(r.spawned, false);
    assert.match(r.reason, /no smalltoak session|local-only/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Note: the "registered parent + spawns bridge" happy path would touch the
// real ~/.treebird-chat/sessions.json and spawn an actual long-lived process.
// We cover that path with the manual smoke run in the PR body; an automated
// version would need mocking child_process.spawn, which is more harness than
// the test budget supports here.
