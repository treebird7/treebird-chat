import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMirrorFile } from '../lib/config.mjs';

// resolveMirrorFile is the join-side guard against the issue #6 nightjar bug
// (a wizard-registered canopy file silently ignored because join hardcoded /tmp)
// and tb-d21.1 (joiners get a deterministic mirror-store file, not a /tmp orphan).
// Pure fn: same (chatId, registry) → same path, no disk writes. storeDir injects.

const STORE = '/var/folders/test-store'; // isolated; never a real ~/.treebird-chat/rooms write

test('returns registered filePath when chat-id is in sessions.json', () => {
  const sessions = {
    nightjar: {
      filePath: '/Users/x/Dev/treebird/canopy/CONSORTIUM_nightjar.md',
      smalltoakUrl: 'http://192.168.100.1:3000',
    },
  };
  const r = resolveMirrorFile('nightjar', { sessions, storeDir: STORE });
  assert.equal(r.mirrorFile, '/Users/x/Dev/treebird/canopy/CONSORTIUM_nightjar.md');
  assert.equal(r.source, 'registered');
  assert.equal(r.note, null);
});

test('falls back to the mirror store when chat-id is not registered', () => {
  const r = resolveMirrorFile('ad-hoc-room', { sessions: {}, storeDir: STORE });
  assert.equal(r.mirrorFile, `${STORE}/ad-hoc-room.md`);
  assert.equal(r.source, 'local');
  assert.equal(r.note, 'mirror; not host canonical');
});

test('falls back to the store when sessions has the chat-id but no filePath', () => {
  // Could happen if the wizard partially-wrote the entry or a hand-edit dropped
  // the field. Treat it as a local joiner (the join can't do anything useful
  // with a chat-id whose canonical path is missing).
  const sessions = { partial: { smalltoakUrl: 'http://h:3000' /* no filePath */ } };
  const r = resolveMirrorFile('partial', { sessions, storeDir: STORE });
  assert.equal(r.source, 'local');
  assert.equal(r.mirrorFile, `${STORE}/partial.md`);
});

test('deterministic: same inputs → same path (pure fn, no writes)', () => {
  const a = resolveMirrorFile('repeatable', { sessions: {}, storeDir: STORE });
  const b = resolveMirrorFile('repeatable', { sessions: {}, storeDir: STORE });
  assert.deepEqual(a, b);
});

test('registered entry wins over a same-name file in the store', () => {
  // Regression: the original bug was "join uses the orphan even though
  // sessions.json had a different filePath". Registered takes priority.
  const sessions = { nightjar: { filePath: '/canonical/path.md' } };
  const r = resolveMirrorFile('nightjar', { sessions, storeDir: STORE });
  assert.equal(r.mirrorFile, '/canonical/path.md');
  assert.notEqual(r.mirrorFile, `${STORE}/nightjar.md`);
});

test('rejects an unsafe chatId before it reaches the filesystem', () => {
  // chatId is invite-sourced (crosses a machine boundary). Basic trust-boundary
  // guard; sherlock's tb-d21.2 adds the adversarial pass.
  for (const bad of ['../escape', 'a/b', '..', '.', 'has space', 'x\0y']) {
    assert.throws(
      () => resolveMirrorFile(bad, { sessions: {}, storeDir: STORE }),
      /unsafe chatId/,
      `should reject ${JSON.stringify(bad)}`,
    );
  }
});
