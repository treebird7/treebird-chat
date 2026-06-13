// Tests for day-separator writing (0.3.7 token-cost fast-follow).
//
// lib/writer.mjs emits a `--- YYYY-MM-DD ---` divider the first time content
// lands on a new calendar day, tracked via a `<file>.day` sidecar. The very
// first write to a file initialises the stamp with NO divider (nothing to
// separate from); only an observed day transition emits one. The watcher must
// treat the divider as non-waking.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendLine } from '../lib/writer.mjs';
import { DAY_SEPARATOR_RE } from '../lib/watcher.mjs';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'day-sep-'));
  const file = join(dir, 'chat.md');
  writeFileSync(file, '');
  return { file, dayPath: `${file}.day`, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('first write emits NO separator but initialises the .day stamp', async () => {
  const { file, dayPath, cleanup } = fixture();
  try {
    await appendLine(file, 'alice', 'hello');
    const body = readFileSync(file, 'utf8');
    assert.doesNotMatch(body, DAY_SEPARATOR_RE, 'no divider above the very first message');
    assert.equal(body.split('\n').filter(Boolean).length, 1, 'exactly one line written');
    assert.ok(existsSync(dayPath), '.day sidecar should be created');
  } finally { cleanup(); }
});

test('same-day second write emits NO separator', async () => {
  const { file, cleanup } = fixture();
  try {
    await appendLine(file, 'alice', 'one');
    await appendLine(file, 'bob', 'two');
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 2, 'two messages, no divider between same-day writes');
    assert.ok(!lines.some(l => DAY_SEPARATOR_RE.test(l)));
  } finally { cleanup(); }
});

test('a day transition (stamp set to yesterday) emits a dated separator', async () => {
  const { file, dayPath, cleanup } = fixture();
  try {
    await appendLine(file, 'alice', 'yesterday-msg');
    // Simulate the calendar rolling forward by rewinding the stamp.
    writeFileSync(dayPath, '2000-01-01\n');
    await appendLine(file, 'bob', 'today-msg');
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const sepIdx = lines.findIndex(l => DAY_SEPARATOR_RE.test(l));
    assert.ok(sepIdx >= 0, 'a day-separator line should be emitted on transition');
    // separator sits immediately before today's message
    assert.match(lines[sepIdx + 1], /today-msg/);
    // stamp advanced off the rewound value
    assert.notEqual(readFileSync(dayPath, 'utf8').trim(), '2000-01-01');
  } finally { cleanup(); }
});

test('the separator shape matches DAY_SEPARATOR_RE and is non-waking', async () => {
  const { file, dayPath, cleanup } = fixture();
  try {
    await appendLine(file, 'alice', 'first');
    writeFileSync(dayPath, '2000-01-01\n');
    await appendLine(file, 'bob', 'second');
    const sep = readFileSync(file, 'utf8').split('\n').find(l => l.startsWith('--- 2'));
    assert.ok(sep, 'separator present');
    assert.match(sep, DAY_SEPARATOR_RE);
    // The watcher excludes DAY_SEPARATOR_RE from freeform wakes — assert the
    // regex the writer relies on actually matches the emitted shape, so the two
    // can never drift (a separator that wakes the room would be a regression).
    assert.match(sep, /^--- \d{4}-\d{2}-\d{2} ---$/);
  } finally { cleanup(); }
});
