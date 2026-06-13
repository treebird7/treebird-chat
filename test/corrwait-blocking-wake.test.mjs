// Regression test for the corrwait blocking-wake cursor off-by-one (0.3.7).
//
// Before the fix, findCursorAfterLastSelfRound returned `lines.length` for a
// newline-terminated file, INCLUDING the phantom trailing '' from split('\n').
// When the listening agent's own message was the last line, the baseline was
// realLines+1, so the FIRST single foreign reply landed in the skipped slot and
// was missed until a second line arrived or the timeout re-invoked. No existing
// test exercised the real blocking watcher, so it went unnoticed.
//
// Strategy: spawn a real blocking corrwait as an agent whose own line is last,
// append exactly ONE foreign line while it blocks, and assert it WAKES (not
// TIMEOUT). Also covers the baseline-zero control (agent never posted).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appendLine } from '../lib/writer.mjs';

const CORRWAIT = fileURLToPath(new URL('../bin/corrwait.mjs', import.meta.url));

function fixture(content) {
  const dir = mkdtempSync(join(tmpdir(), 'corrwait-wake-'));
  const file = join(dir, 'chat.md');
  writeFileSync(file, content);
  writeFileSync(`${file}.access.json`,
    JSON.stringify({ owner: 'test', agents: { artisan: { allowed: true }, alice: { allowed: true } } }));
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function blockThenAppend(file, agent, author, message, timeoutSec = 6) {
  return new Promise((resolve) => {
    const cw = spawn(process.execPath, [CORRWAIT, file, '--as', agent, '--timeout', String(timeoutSec)],
      { env: { ...process.env, ENVOAK_AGENT_LABEL: agent } });
    let out = '';
    cw.stdout.on('data', d => (out += d));
    // Append one foreign line a beat after corrwait has started blocking. Track
    // the pending write so we can settle/cancel it before resolving — otherwise
    // an immediate wake (baseline-zero control) tears down the fixture dir while
    // the scheduled appendLine is still in flight (ENOENT on the lock file).
    let appendDone = null;
    const timer = setTimeout(() => { appendDone = appendLine(file, author, message).catch(() => {}); }, 900);
    cw.on('close', async () => {
      clearTimeout(timer);
      if (appendDone) { try { await appendDone; } catch { /* ignore */ } }
      let reason = null;
      try { reason = JSON.parse(out.trim().split('\n').pop()).reason; } catch { /* leave null */ }
      resolve(reason);
    });
  });
}

test('blocking corrwait wakes on the first foreign reply when the agent posted last (off-by-one regression)', async () => {
  const { file, cleanup } = fixture('[09:00 artisan] my last message\n');
  try {
    const reason = await blockThenAppend(file, 'artisan', 'alice', 'a single reply, nothing after');
    assert.equal(reason, 'WAKE', 'agent-last baseline must still see the first foreign append');
  } finally { cleanup(); }
});

test('blocking corrwait wakes when the agent never posted (baseline-zero control)', async () => {
  const { file, cleanup } = fixture('[09:00 alice] morning\n');
  try {
    // 'artisan' is in the ACL but hasn't posted in this file → baseline 0.
    const reason = await blockThenAppend(file, 'artisan', 'alice', 'foreign reply', 6);
    assert.equal(reason, 'WAKE');
  } finally { cleanup(); }
});
