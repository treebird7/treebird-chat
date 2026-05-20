import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { supervise, makePanicWatch, makeHeartbeat } from '../lib/corrwait-supervisor.mjs';

// ── Pure unit tests (no spawn) ────────────────────────────────────────────────

test('makePanicWatch fires when count is reached inside the window', () => {
  const w = makePanicWatch(3, 1_000_000);
  assert.equal(w.record(), false);
  assert.equal(w.record(), false);
  assert.equal(w.record(), true); // 3rd inside window
});

test('makePanicWatch does not fire when restarts are spread out beyond the window', async () => {
  const w = makePanicWatch(3, 1); // 1 ms window
  w.record();
  await new Promise((r) => setTimeout(r, 5));
  w.record();
  await new Promise((r) => setTimeout(r, 5));
  // Each record is its own first; the older ones expire.
  assert.equal(w.record(), false);
});

test('makeHeartbeat fires the callback repeatedly until stop', async () => {
  let count = 0;
  const hb = makeHeartbeat(() => { count++; }, 10);
  hb.start();
  await new Promise((r) => setTimeout(r, 55));
  hb.stop();
  const final = count;
  await new Promise((r) => setTimeout(r, 30));
  // The callback fires every 10ms; in ~55ms we should see 4-6 ticks, exact
  // count depends on event-loop jitter. The important property is "fires
  // multiple times" and "stops on stop()".
  assert.ok(final >= 3, `expected ≥3 ticks in 55ms, got ${final}`);
  assert.equal(count, final, 'no further ticks fire after stop');
});

test('makeHeartbeat is a no-op when fn is null', () => {
  const hb = makeHeartbeat(null, 10);
  // start + stop must not throw or set timers.
  hb.start();
  hb.stop();
});

test('makeHeartbeat swallows thrown callbacks (loop must survive)', async () => {
  let count = 0;
  const hb = makeHeartbeat(async () => { count++; throw new Error('boom'); }, 10);
  hb.start();
  await new Promise((r) => setTimeout(r, 45));
  hb.stop();
  assert.ok(count >= 2, 'callback continued firing despite throws');
});

// ── Integration via a stub corrwait binary ────────────────────────────────────
//
// We avoid running the real corrwait — it requires ENVOAK_AGENT_LABEL, an
// ACL file, etc. Instead, write a tiny script that mimics corrwait's
// exit-code + stdout contract for each test scenario.

function makeStubCorrwait(workDir, scriptBody) {
  const stub = join(workDir, 'fake-corrwait.mjs');
  writeFileSync(stub, `#!/usr/bin/env node\n${scriptBody}\n`, { mode: 0o755 });
  chmodSync(stub, 0o755);
  return stub;
}

test('supervise dispatches WAKE payloads via onWake', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sup-test-'));
  try {
    // Stub corrwait: emit one WAKE then exit 0 with the payload. State is
    // tracked via a counter file so we can exit cleanly on the second call.
    const counter = join(dir, 'count');
    writeFileSync(counter, '0');
    const stub = makeStubCorrwait(dir, `
      import { readFileSync, writeFileSync } from 'node:fs';
      const n = parseInt(readFileSync('${counter}', 'utf8'), 10);
      writeFileSync('${counter}', String(n + 1));
      if (n === 0) {
        process.stdout.write(JSON.stringify({ reason: 'WAKE', wakeLines: ['hi'], newContent: '[10:00 t] hi' }));
        process.exit(0);
      }
      // Second call → END so supervisor exits cleanly.
      process.stdout.write(JSON.stringify({ reason: 'END' }));
      process.exit(1);
    `);

    const wakes = [];
    const result = await supervise({
      corrwaitBin: stub,
      filePath: join(dir, 'chat.md'),
      agent: 'tester',
      timeoutSec: 5,
      catchup: false,
      panic: null,
      onWake: (p) => { wakes.push(p); },
    });

    assert.equal(result.reason, 'END');
    assert.equal(wakes.length, 1);
    assert.equal(wakes[0].reason, 'WAKE');
    assert.deepEqual(wakes[0].wakeLines, ['hi']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('supervise exits with PANIC when restarts exceed threshold', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sup-panic-'));
  try {
    // Stub that always exits ERROR (bare exit 99). Should trip the panic
    // threshold immediately at the configured count.
    const stub = makeStubCorrwait(dir, `process.exit(99);`);

    const errors = [];
    const result = await supervise({
      corrwaitBin: stub,
      filePath: join(dir, 'chat.md'),
      agent: 'tester',
      timeoutSec: 5,
      catchup: false,
      panic: { count: 3, windowMs: 10_000 },
      errorBackoffMs: 0,
      onWake: () => {},
      onError: (p) => { errors.push(p); },
      log: () => {}, // silent in tests
    });

    assert.equal(result.reason, 'PANIC');
    assert.ok(result.restarts >= 3, `expected ≥3 restarts before panic, got ${result.restarts}`);
    assert.ok(errors.length >= 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('supervise treats exit 1 (END) as clean exit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sup-end-'));
  try {
    const stub = makeStubCorrwait(dir, `process.exit(1);`);
    const result = await supervise({
      corrwaitBin: stub,
      filePath: join(dir, 'chat.md'),
      agent: 'tester',
      timeoutSec: 5,
      catchup: false,
      panic: null,
      onWake: () => {},
    });
    assert.equal(result.reason, 'END');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('supervise treats exit 3 (REVOKED) as clean exit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sup-revoked-'));
  try {
    const stub = makeStubCorrwait(dir, `process.exit(3);`);
    const result = await supervise({
      corrwaitBin: stub,
      filePath: join(dir, 'chat.md'),
      agent: 'tester',
      timeoutSec: 5,
      catchup: false,
      panic: null,
      onWake: () => {},
    });
    assert.equal(result.reason, 'REVOKED');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('supervise dispatches catchup payload before entering the blocking loop', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sup-catchup-'));
  try {
    // Stub: if --catchup is in argv, emit a CATCHUP payload with content;
    // otherwise emit END so the supervisor exits cleanly.
    const stub = makeStubCorrwait(dir, `
      if (process.argv.includes('--catchup')) {
        process.stdout.write(JSON.stringify({
          reason: 'CATCHUP', wakeLines: ['queued msg'], newContent: '[09:00 q] queued msg'
        }));
        process.exit(0);
      }
      process.exit(1); // END
    `);

    const wakes = [];
    const result = await supervise({
      corrwaitBin: stub,
      filePath: join(dir, 'chat.md'),
      agent: 'tester',
      timeoutSec: 5,
      catchup: true,
      panic: null,
      onWake: (p) => { wakes.push(p); },
    });
    assert.equal(result.reason, 'END');
    assert.equal(wakes.length, 1);
    assert.equal(wakes[0].fromCatchup, true, 'catchup payloads must be tagged fromCatchup');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('supervise required-args check throws on missing fields', async () => {
  await assert.rejects(
    () => supervise({}),
    /required/,
    'missing required args must throw',
  );
});
