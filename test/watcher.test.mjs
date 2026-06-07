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

test('FLAT_RE — frozen format groups: date, time, agent, instance, message', () => {
  // No-space #N (frozen 2026-06-07 — agent#N, not agent #N)
  let m = FLAT_RE.exec('[14:23 yosef#2] hello from parallel hand');
  assert.ok(m, 'should match agent#N');
  assert.equal(m[1], undefined, 'no date');
  assert.equal(m[2], '14:23');
  assert.equal(m[3], 'yosef');
  assert.equal(m[4], '2');
  assert.equal(m[5], 'hello from parallel hand');

  // Backward-compat: dateless, instance-less line still parses.
  m = FLAT_RE.exec('[09:05 watsan] plain line');
  assert.ok(m);
  assert.equal(m[3], 'watsan');
  assert.equal(m[4], undefined);
  assert.equal(m[5], 'plain line');

  // Optional date prefix.
  m = FLAT_RE.exec('[2026-06-07 14:23 yosef] dated');
  assert.ok(m);
  assert.equal(m[1], '2026-06-07');
  assert.equal(m[2], '14:23');
  assert.equal(m[3], 'yosef');
  assert.equal(m[5], 'dated');
});

test('self flat line with #N suffix is filtered (same base agent)', () => {
  const { file, cleanup } = fixture('[12:00 yosef#2] parallel reply\n[12:01 watsan] foreign\n');
  try {
    const diff = diffSinceBaseline(file, emptyBaseline, '/end', 'yosef');
    assert.equal(diff.woke, true);
    assert.deepEqual(diff.wakeLines, ['[12:01 watsan] foreign']);
  } finally { cleanup(); }
});

test('cursor advances past #N parallel-hand lines (and dated self lines)', () => {
  const lines = [
    '[12:00 watsan] hey',
    '[12:01 yosef] first hand',
    '[12:02 yosef#2] second hand',
    '[2026-06-07 12:04 yosef] dated self line',
    '[12:05 watsan] reply',
  ];
  // Cursor should be after the last yosef line (the dated one, index 3 → 4).
  const cursor = findCursorAfterLastSelfRound(lines, 'yosef');
  assert.equal(cursor, 4, 'cursor should advance past yosef#2 and the dated self line');
});
