import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { diffSinceBaseline, FLAT_RE, findCursorAfterLastSelfRound } from '../lib/watcher.mjs';

function fixture(content) {
  const dir = mkdtempSync(join(tmpdir(), 'watcher-test-'));
  const file = join(dir, 'chat.md');
  writeFileSync(file, content);
  return {
    file,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const emptyBaseline = { length: 0, lines: [] };

test('self flat line is filtered when agent is provided', () => {
  const { file, cleanup } = fixture('[12:00 yosef] my reply\n');
  try {
    const diff = diffSinceBaseline(file, emptyBaseline, '/end', 'yosef');
    assert.equal(diff.woke, false);
    assert.equal(diff.wakeLines.length, 0);
    assert.equal(diff.hasNewFreeform, false);
  } finally { cleanup(); }
});

test('self flat line still wakes when no agent is passed (back-compat)', () => {
  const { file, cleanup } = fixture('[12:00 yosef] my reply\n');
  try {
    const diff = diffSinceBaseline(file, emptyBaseline, '/end');
    assert.equal(diff.woke, true);
    assert.equal(diff.wakeLines.length, 1);
  } finally { cleanup(); }
});

test('foreign agent flat line is NOT filtered', () => {
  const { file, cleanup } = fixture('[12:00 watsan] reply from watsan\n');
  try {
    const diff = diffSinceBaseline(file, emptyBaseline, '/end', 'yosef');
    assert.equal(diff.woke, true);
    assert.deepEqual(diff.wakeLines, ['[12:00 watsan] reply from watsan']);
  } finally { cleanup(); }
});

test('self round header is filtered', () => {
  const { file, cleanup } = fixture('## Round 1 — yosef → treebird\n\nmy round body\n');
  try {
    const diff = diffSinceBaseline(file, emptyBaseline, '/end', 'yosef');
    // Round header filtered. Body lines may register as freeform — but filtering
    // self-rounds means hasNewRound is false.
    assert.equal(diff.hasNewRound, false);
    assert.ok(!diff.wakeLines.some((l) => l.startsWith('## Round 1 — yosef')));
  } finally { cleanup(); }
});

test('foreign round header is NOT filtered', () => {
  const { file, cleanup } = fixture('## Round 1 — watsan → treebird\n');
  try {
    const diff = diffSinceBaseline(file, emptyBaseline, '/end', 'yosef');
    assert.equal(diff.hasNewRound, true);
    assert.deepEqual(diff.wakeLines, ['## Round 1 — watsan → treebird']);
  } finally { cleanup(); }
});

test('human comment is NEVER filtered (always external)', () => {
  const { file, cleanup } = fixture('**💬 Human [12:00]:** hi yosef\n');
  try {
    const diff = diffSinceBaseline(file, emptyBaseline, '/end', 'yosef');
    assert.equal(diff.hasNewHuman, true);
    assert.equal(diff.wakeLines.length, 1);
  } finally { cleanup(); }
});

test('mixed batch — self lines excluded, foreign lines wake', () => {
  const { file, cleanup } = fixture(
    '[12:00 yosef] mine\n[12:01 watsan] hers\n[12:02 yosef] mine again\n[12:03 birdsan] his\n'
  );
  try {
    const diff = diffSinceBaseline(file, emptyBaseline, '/end', 'yosef');
    assert.equal(diff.woke, true);
    assert.deepEqual(diff.wakeLines, [
      '[12:01 watsan] hers',
      '[12:03 birdsan] his',
    ]);
  } finally { cleanup(); }
});

test('agent name with hyphens (e.g. sancho-nightly) escapes correctly', () => {
  const { file, cleanup } = fixture('[12:00 sancho-nightly] mine\n[12:01 sancho] not the same agent\n');
  try {
    const diff = diffSinceBaseline(file, emptyBaseline, '/end', 'sancho-nightly');
    assert.deepEqual(diff.wakeLines, ['[12:01 sancho] not the same agent']);
  } finally { cleanup(); }
});

test('FLAT_RE parses parallel-hand suffix (e.g. yosef #2)', () => {
  const m = FLAT_RE.exec('[14:23 yosef #2] hello from parallel hand');
  assert.ok(m, 'FLAT_RE should match #N suffix lines');
  assert.equal(m[1], '14:23');
  assert.equal(m[2], 'yosef #2');
  assert.equal(m[3], 'hello from parallel hand');
});

test('self flat line with #N suffix is filtered (same base agent)', () => {
  const { file, cleanup } = fixture('[12:00 yosef #2] parallel reply\n[12:01 watsan] foreign\n');
  try {
    const diff = diffSinceBaseline(file, emptyBaseline, '/end', 'yosef');
    assert.equal(diff.woke, true);
    assert.deepEqual(diff.wakeLines, ['[12:01 watsan] foreign']);
  } finally { cleanup(); }
});

test('cursor advances past #N parallel-hand lines', () => {
  const lines = [
    '[12:00 watsan] hey',
    '[12:01 yosef] first hand',
    '[12:02 yosef #2] second hand',
    '[12:03 watsan] reply',
  ];
  // Cursor should be after the last yosef line (index 2 → cursor = 3)
  const cursor = findCursorAfterLastSelfRound(lines, 'yosef');
  assert.equal(cursor, 3, 'cursor should advance past yosef #2 line');
});
