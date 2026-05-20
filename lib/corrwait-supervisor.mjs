// Shared supervisor for the corrwait-based agent loop.
//
// Closes the "two parallel supervisors" gap surfaced in issue #6 P3 +
// mappersan's "hidden respawn" observation. Before this module, the same
// `while (true) { spawn corrwait; dispatch by exit code }` lived in two
// places — bin/treebird-chat-join.mjs:223 and lib/bridge-agent-base.mjs:92.
// They drifted on error-backoff and logging; merging them here makes the
// supervisor grep-able (mappersan's pkill killed a corrwait; the supervisor
// spawned the next one — that's the *job*, not a hidden behavior).
//
// What this module adds on top of the extracted shape:
//   - Panic threshold: N restarts inside T seconds = broken config, exit
//     non-zero instead of looping forever
//   - Logged restarts: every (re)start carries a tag with elapsed timing
//     so an operator running `tail -f` sees the loop is alive
//   - Optional heartbeat hook: caller can pass an async fn that fires
//     every N seconds while the supervisor is alive. Default: no-op
//     (envoak integration is a wire-up, not a code dependency — keeps the
//     vanilla path working without envoak)
//   - Catchup pass at start: drains any messages that landed while the
//     agent was away (uses `corrwait --catchup` from PR #5)
//
// Identity / argv are unchanged from the prior call sites — same corrwait
// binary, same flags, same timeout default.

import { spawn } from 'node:child_process';
import { spawnEnv } from './config.mjs';

const DEFAULT_TIMEOUT_SEC = 540;
const DEFAULT_PANIC_COUNT = 10;
const DEFAULT_PANIC_WINDOW_MS = 60_000;
const DEFAULT_HEARTBEAT_MS = 30_000;

// Run one corrwait invocation and return the parsed payload + the exit code.
// The dispatch shape (WAKE/END/REVOKED/TIMEOUT/ERROR) is owned by corrwait
// itself; we just parse + relay. Exit codes (per bin/corrwait.mjs):
//   0 → WAKE (payload on stdout)
//   1 → end-word reached         → reason 'END'
//   2 → timeout                  → reason 'TIMEOUT' (re-arm)
//   3 → ACL revoked              → reason 'REVOKED'
//   other → unexpected           → reason 'ERROR'
function runOnce({ corrwaitBin, filePath, agent, timeoutSec, extraArgs = [], stderrPassthrough }) {
  return new Promise((resolve) => {
    const args = [
      corrwaitBin,
      filePath,
      '--as', agent,
      '--timeout', String(timeoutSec),
      ...extraArgs,
    ];
    // OS-level safety timeout: 60s margin past corrwait's own --timeout. If
    // corrwait's internal watchdog fails (poll deadlock, fs handle stuck),
    // child_process kills it so the supervisor can re-arm. Mirrors the prior
    // CORRWAIT_TIMEOUT_MS=600_000 from bridge-agent-base.mjs before extraction.
    const childTimeoutMs = (timeoutSec + 60) * 1000;
    const cw = spawn(process.execPath, args, {
      env: spawnEnv({ BIRDCHAT_AGENT: agent }),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: childTimeoutMs,
    });

    let out = '';
    cw.stdout.on('data', (d) => { out += d.toString(); });
    if (stderrPassthrough) {
      cw.stderr.on('data', (d) => process.stderr.write(d));
    } else {
      cw.stderr.on('data', () => {}); // drain
    }
    cw.on('error', () => resolve({ code: -1, payload: { reason: 'ERROR', error: 'spawn failed' } }));
    cw.on('close', (code) => {
      let payload = null;
      try { payload = JSON.parse(out.trim()); } catch { /* fall through */ }
      if (!payload) {
        payload = { reason: code === 0 ? 'ERROR' : codeToReason(code), raw: out };
      }
      resolve({ code, payload });
    });
  });
}

function codeToReason(code) {
  if (code === 1) return 'END';
  if (code === 2) return 'TIMEOUT';
  if (code === 3) return 'REVOKED';
  return 'ERROR';
}

// Panic detector: keeps a sliding window of recent (re)start timestamps.
// Fires when `count` starts happen inside `windowMs` — a clear signal that
// corrwait is failing immediately every spawn (bad config, missing ENV,
// corrupt file, etc.) rather than doing real work.
function makePanicWatch(count, windowMs) {
  const stamps = [];
  return {
    record() {
      const now = Date.now();
      stamps.push(now);
      while (stamps.length && stamps[0] < now - windowMs) stamps.shift();
      return stamps.length >= count;
    },
    snapshot() { return [...stamps]; },
  };
}

// Heartbeat scheduler. Fires the (optional, async) callback every `ms`.
// Independent of the corrwait loop — fires even when the loop is *inside* a
// blocking corrwait call. This is the whole point: presence is independent
// of whether the agent is currently waiting on a message.
function makeHeartbeat(fn, ms) {
  if (!fn) return { start() {}, stop() {} };
  let timer = null;
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try { await fn(); } catch { /* swallow — heartbeat must not break the loop */ }
    if (!stopped) timer = setTimeout(tick, ms);
  };
  return {
    start() { timer = setTimeout(tick, ms); },
    stop() { stopped = true; if (timer) clearTimeout(timer); },
  };
}

// Run the supervisor loop. Returns when the agent disconnects cleanly
// (END / REVOKED) or panics. Throws on programmer error (missing corrwaitBin
// etc.) — that's a config bug the caller should crash on, not a runtime
// case worth catching.
//
// opts:
//   corrwaitBin     — absolute path to bin/corrwait.mjs        REQUIRED
//   filePath        — chat file to watch                         REQUIRED
//   agent           — identity to pass corrwait via --as         REQUIRED
//   onWake(payload) — async fn called once per WAKE              REQUIRED
//   timeoutSec      — per-corrwait timeout (default 540)
//   onTimeout()     — fires after corrwait exit code 2 (default: silent re-arm)
//   onError(payload) — fires on unexpected exit (default: stderr 1-liner)
//   errorBackoffMs  — sleep before retry after ERROR (default 0)
//   panic           — { count, windowMs } (default 10/60s; null disables)
//   heartbeat       — { fn, intervalMs } — optional liveness hook
//   catchup         — true to run one `corrwait --catchup` before the loop
//                     (defaults to true; set false for tests / one-off scripts)
//   log(msg)        — observability sink (default: stderr with [supervisor] tag)
//   stderrPassthrough — pass child corrwait's stderr to parent (default: true)
//   extraArgs       — additional flags appended to corrwait (e.g. ['--end-word', '/end'])
//
// Returns: { reason: 'END' | 'REVOKED' | 'PANIC', restarts: number }
export async function supervise(opts) {
  const {
    corrwaitBin, filePath, agent, onWake,
    timeoutSec = DEFAULT_TIMEOUT_SEC,
    onTimeout = () => {},
    onError = (p) => process.stderr.write(`[supervisor] corrwait ERROR: ${p?.error ?? 'unknown'}\n`),
    errorBackoffMs = 0,
    panic = { count: DEFAULT_PANIC_COUNT, windowMs: DEFAULT_PANIC_WINDOW_MS },
    heartbeat = null,
    catchup = true,
    log = (m) => process.stderr.write(`[supervisor] ${m}\n`),
    stderrPassthrough = true,
    extraArgs = [],
  } = opts;

  if (!corrwaitBin || !filePath || !agent || typeof onWake !== 'function') {
    throw new Error('supervise: corrwaitBin, filePath, agent, onWake are required');
  }

  const panicWatch = panic ? makePanicWatch(panic.count, panic.windowMs) : null;
  const hb = makeHeartbeat(heartbeat?.fn, heartbeat?.intervalMs ?? DEFAULT_HEARTBEAT_MS);
  hb.start();

  let restarts = 0;
  let reason = null;

  // Catchup pass — drain anything that landed while we were away. Uses
  // --catchup mode (PR #5): non-blocking, exits 0 with whatever's there.
  if (catchup) {
    const { payload: cu } = await runOnce({
      corrwaitBin, filePath, agent, timeoutSec,
      extraArgs: ['--catchup'],
      stderrPassthrough,
    });
    if (cu?.reason === 'CATCHUP' && (cu.newContent || (cu.wakeLines || []).length)) {
      try { await onWake({ ...cu, fromCatchup: true }); }
      catch (e) { log(`onWake (catchup) threw: ${e.message}`); }
    }
  }

  try {
    while (true) {
      const { code, payload } = await runOnce({
        corrwaitBin, filePath, agent, timeoutSec,
        extraArgs,
        stderrPassthrough,
      });

      if (payload?.reason === 'WAKE' || payload?.reason === 'URGENT_WAKE') {
        try { await onWake(payload); }
        catch (e) { log(`onWake threw: ${e.message}`); }
        continue;
      }
      if (payload?.reason === 'TIMEOUT') {
        try { await onTimeout(); } catch { /* swallow */ }
        // Re-arm after timeout. Track in the panic window so a corrwait that
        // exits immediately on TIMEOUT (bug) doesn't loop silently forever.
        restarts++;
        if (panicWatch && panicWatch.record()) {
          reason = 'PANIC';
          log(`PANIC: ${panicWatch.snapshot().length} restarts in ${panic.windowMs}ms — exiting`);
          break;
        }
        continue;
      }
      if (payload?.reason === 'END' || payload?.reason === 'REVOKED') {
        reason = payload.reason;
        break;
      }

      // ERROR / unknown. Log, optionally backoff, re-arm under panic watch.
      try { await onError(payload); } catch { /* swallow */ }
      restarts++;
      if (panicWatch && panicWatch.record()) {
        reason = 'PANIC';
        log(`PANIC: ${panicWatch.snapshot().length} restarts in ${panic.windowMs}ms — exiting`);
        break;
      }
      if (errorBackoffMs > 0) {
        await new Promise((r) => setTimeout(r, errorBackoffMs));
      }
    }
  } finally {
    hb.stop();
  }

  return { reason: reason ?? 'END', restarts };
}

// Test seam — exported so unit tests can call the leaf without spawning.
export { makePanicWatch, makeHeartbeat };
