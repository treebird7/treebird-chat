import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { diffSinceBaseline } from '../lib/watcher.mjs';

function fixture(content) {
  const dir = mkdtempSync(join(tmpdir(), 'watcher-mention-'));
  const file = join(dir, 'chat.md');
  writeFileSync(file, content);
  return {
    file,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('diffSinceBaseline wakes on a freeform @mention when onMention is set', () => {
  const { file, cleanup } = fixture('[11:59 treebird] existing\n[12:00 bob] @alice hello\n');
  try {
    const baseline = { length: 0, lines: ['[11:59 treebird] existing'] };
    const diff = diffSinceBaseline(file, baseline, '/end', null, 'alice');

    assert.equal(diff.woke, true);
    assert.equal(diff.hasNewFreeform, true);
    assert.deepEqual(diff.wakeLines, ['[12:00 bob] @alice hello']);
  } finally {
    cleanup();
  }
});

test('diffSinceBaseline ignores non-mention freeform lines when onMention is set', () => {
  const { file, cleanup } = fixture('[11:59 treebird] existing\n[12:01 bob] general message\n');
  try {
    const baseline = { length: 0, lines: ['[11:59 treebird] existing'] };
    const diff = diffSinceBaseline(file, baseline, '/end', null, 'alice');

    assert.equal(diff.woke, false);
    assert.equal(diff.hasNewFreeform, false);
    assert.deepEqual(diff.wakeLines, []);
  } finally {
    cleanup();
  }
});

test('diffSinceBaseline still wakes on a new round while onMention is set', () => {
  const { file, cleanup } = fixture('[11:59 treebird] existing\n## Round 2 — bob → alice\n');
  try {
    const baseline = { length: 0, lines: ['[11:59 treebird] existing'] };
    const diff = diffSinceBaseline(file, baseline, '/end', null, 'alice');

    assert.equal(diff.woke, true);
    assert.equal(diff.hasNewRound, true);
    assert.deepEqual(diff.wakeLines, ['## Round 2 — bob → alice']);
  } finally {
    cleanup();
  }
});
