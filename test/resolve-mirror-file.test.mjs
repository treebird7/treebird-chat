import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMirrorFile } from '../lib/config.mjs';

// resolveMirrorFile is the join-side guard against the issue #6 nightjar bug:
// a wizard-registered canopy file silently ignored because join hardcoded /tmp.

test('returns registered filePath when chat-id is in sessions.json', () => {
  const sessions = {
    nightjar: {
      filePath: '/Users/x/Dev/treebird/canopy/CONSORTIUM_nightjar.md',
      smalltoakUrl: 'http://192.168.100.1:3000',
    },
  };
  const r = resolveMirrorFile('nightjar', { sessions });
  assert.equal(r.mirrorFile, '/Users/x/Dev/treebird/canopy/CONSORTIUM_nightjar.md');
  assert.equal(r.source, 'registered');
  assert.equal(r.warning, null);
});

test('falls back to /tmp when chat-id is not registered', () => {
  const r = resolveMirrorFile('ad-hoc-room', { sessions: {} });
  assert.equal(r.mirrorFile, '/tmp/ad-hoc-room.md');
  assert.equal(r.source, 'tmp');
  assert.ok(r.warning, 'tmp fallback must emit a warning so the orphan is visible');
  assert.match(r.warning, /not registered/);
  assert.match(r.warning, /ad-hoc-room/);
});

test('falls back to /tmp when sessions has the chat-id but no filePath', () => {
  // Could happen if the wizard partially-wrote the entry or a hand-edit dropped
  // the field. Treat it as unregistered (the join can't do anything useful with
  // a chat-id whose canonical path is missing).
  const sessions = { partial: { smalltoakUrl: 'http://h:3000' /* no filePath */ } };
  const r = resolveMirrorFile('partial', { sessions });
  assert.equal(r.source, 'tmp');
  assert.equal(r.mirrorFile, '/tmp/partial.md');
});

test('respects injected tmpDir (test isolation, no real /tmp writes)', () => {
  const r = resolveMirrorFile('unreg', { sessions: {}, tmpDir: '/var/folders/test' });
  assert.equal(r.mirrorFile, '/var/folders/test/unreg.md');
  assert.equal(r.source, 'tmp');
});

test('registered entry wins over a same-name file in /tmp', () => {
  // Regression: the original bug was "join uses /tmp even though sessions.json
  // had a different filePath". Verify registered takes priority unconditionally.
  const sessions = {
    nightjar: { filePath: '/canonical/path.md' },
  };
  const r = resolveMirrorFile('nightjar', { sessions });
  assert.equal(r.mirrorFile, '/canonical/path.md');
  assert.notEqual(r.mirrorFile, '/tmp/nightjar.md');
});

test('warning text names the fix path (treebird-chat-wizard)', () => {
  // The warning is operator-facing; it must point at the fix, not just complain.
  const r = resolveMirrorFile('x', { sessions: {} });
  assert.match(r.warning, /treebird-chat-wizard/);
});
