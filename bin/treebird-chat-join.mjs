#!/usr/bin/env node
// treebird-chat-join <chatId> [--smalltoak-url URL] [--as agent] [--tui] [--all-traffic]
//
// Single-command join for a remote treebird-chat session.
// Reads SMALLTOAK_TOKEN from ~/.treebird-chat/.env automatically.
// Default: spawns bridge in background, runs corrwait loop in foreground.
// With --tui: spawns bridge then opens the full TUI.
//
// Mention-only is the DEFAULT (sasusan token-cost fast-follow): corrwait wakes
// only on freeform lines that @-mention this agent (short or full label). Round
// headers and human comments still wake (they're external by definition). @all
// is recognised for *priority* (@@/@@@) but not as a wake target — see
// lib/watcher.mjs diffSinceBaseline. This default is scoped to the interactive
// join path only; the corrwait binary and bridges keep all-traffic.
//   --all-traffic   opt back out — wake on every freeform line (the old default).
//   --mention-only  accepted for back-compat; now a no-op since it is the default.
// Forwards --on-mention to the supervised corrwait subprocess (including the
// catchup pass on restart).

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { dirname, join, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, resolvePublicUrl, resolveMirrorFile, resolveSmalltoakUrl, spawnEnv } from '../lib/config.mjs';
import { supervise } from '../lib/corrwait-supervisor.mjs';
import { verifyAgentIdentity } from '../lib/identity.mjs';
import { setAllowed } from '../lib/access.mjs';
import { closeSubInParent } from '../lib/subs.mjs';
import { loadPin, fingerprintFromPem } from '../lib/smalltoak-pin.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));

loadEnv();

// mentionOnly defaults true (interactive busy-room default); --all-traffic opts
// out. mentionOnlyExplicit tracks an explicit --mention-only so the --tui no-op
// warning fires only when the user asked for it, not on every default join.
let chatId = null, asArg = null, smalltoakUrl = null, tui = false, parentFile = null, certFileArg = null, mentionOnly = true, mentionOnlyExplicit = false;
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--as') asArg = argv[++i];
    else if (argv[i] === '--smalltoak-url') smalltoakUrl = argv[++i];
    else if (argv[i] === '--parent') parentFile = argv[++i];
    else if (argv[i] === '--cert-file') certFileArg = argv[++i];
    else if (argv[i] === '--tui') tui = true;
    else if (argv[i] === '--mention-only') { mentionOnly = true; mentionOnlyExplicit = true; }
    else if (argv[i] === '--all-traffic') mentionOnly = false;
    else if (!argv[i].startsWith('--') && !chatId) chatId = argv[i];
  }
}
if (!chatId) {
  process.stderr.write('usage: treebird-chat-join <chatId> [--smalltoak-url URL] [--as agent] [--cert-file PATH] [--tui] [--all-traffic]\n');
  process.exit(1);
}
// Char allowlist + length cap. 128 fits the worst sub-chat-id shape
// (<parent-32>-sub-<topic-64>) plus margin without enabling resource-abuse
// inputs. (/ts-review input_validation cap on argv.)
if (!/^[a-zA-Z0-9_-]{1,128}$/.test(chatId)) {
  process.stderr.write('Invalid chatId: must match /^[a-zA-Z0-9_-]{1,128}$/\n');
  process.exit(1);
}

let identity;
try { identity = verifyAgentIdentity(asArg); }
catch (e) { process.stderr.write(`Identity check failed: ${e.message}\n`); process.exit(1); }
const { agent } = identity;

// P1: env → envoak vault → null. SMALLTOAK_URL is a historical alias for
// SMALLTOAK_SERVER_URL; honour it but resolveSmalltoakUrl is the canonical
// path that also probes the vault.
if (!smalltoakUrl) smalltoakUrl = process.env.SMALLTOAK_URL || resolveSmalltoakUrl().url;
if (!smalltoakUrl) {
  process.stderr.write(
    'No smalltoak URL. Run `trbc init` to save it once, or pass --smalltoak-url,\n' +
    'set SMALLTOAK_URL in ~/.treebird-chat/.env, or (with envoak)\n' +
    '`envoak vault set treebird-chat SMALLTOAK_SERVER_URL <url>`.\n'
  );
  process.exit(1);
}
const { url: joinUrl } = resolvePublicUrl(smalltoakUrl);

// ── Cert pinning (Option A from SPEC_smalltoak_tls_pinning.md) ──────────────
// If joining an https:// smalltoak the bridge needs the pin or it'll refuse.
// Source: --cert-file > SMALLTOAK_CERT_FILE env > persisted default location.
// Anything we accept is copied to the default location (mode 0600) so the
// bridge spawn just needs the env var, and subsequent joins find it auto.

const DEFAULT_CERT_PATH = join(homedir(), '.treebird-chat', 'smalltoak.crt');
let certFile =
  certFileArg ||
  process.env.SMALLTOAK_CERT_FILE ||
  (existsSync(DEFAULT_CERT_PATH) ? DEFAULT_CERT_PATH : null);

if (certFile) {
  // Validate before persisting — a broken PEM should fail loudly here,
  // not 5s later inside the spawned bridge.
  let pem;
  try { pem = loadPin(certFile); }
  catch (e) {
    process.stderr.write(`[join] ${e.message}\n`);
    process.exit(1);
  }
  // If the user passed --cert-file pointing somewhere other than our default,
  // mirror it into ~/.treebird-chat/smalltoak.crt (0600). The dir is already
  // 0700 (matches the existing token-storage convention).
  const absSource = pathResolve(certFile);
  if (absSource !== DEFAULT_CERT_PATH) {
    mkdirSync(dirname(DEFAULT_CERT_PATH), { recursive: true, mode: 0o700 });
    writeFileSync(DEFAULT_CERT_PATH, pem, { mode: 0o600 });
    process.stderr.write(`[join] cert persisted to ${DEFAULT_CERT_PATH}\n`);
    certFile = DEFAULT_CERT_PATH;
  }
  process.stderr.write(`[join] cert SHA-256: ${fingerprintFromPem(pem)}\n`);
} else if (joinUrl.startsWith('https://')) {
  process.stderr.write(
    '[join] ERROR: https:// requires --cert-file (or SMALLTOAK_CERT_FILE), no pin found.\n' +
    '       Get the cert from the session host (see /invite output) and re-run with:\n' +
    `         --cert-file <path-to-cert.pem>\n`
  );
  process.exit(1);
}

const token = process.env.SMALLTOAK_TOKEN;
if (!token) {
  process.stderr.write(
    'No SMALLTOAK_TOKEN. Run `trbc init --token <token>` (or `trbc init --from-vault`)\n' +
    'to save it to ~/.treebird-chat/.env once.\n'
  );
  process.exit(1);
}

// Closes issue #6 P2 + tb-d21.1. A registered chat-id honours its canonical
// sessions.json filePath; a joiner (no local registration) resolves to a
// deterministic file in the mirror store (~/.treebird-chat/rooms/), not a
// reboot-wiped /tmp orphan.
const { mirrorFile, source: mirrorSource, note: mirrorNote } = resolveMirrorFile(chatId);
if (mirrorNote) process.stderr.write(`[join] note: ${mirrorNote}\n`);
if (!existsSync(mirrorFile)) {
  // Registered file may not exist locally yet (just-created sub, fresh clone).
  // Touch it so corrwait/chokidar can attach; the bridge populates from smalltoak.
  mkdirSync(dirname(mirrorFile), { recursive: true });
  writeFileSync(mirrorFile, '');
}

// local ACL (pre-T10; bridge is the real gate post-T10)
setAllowed(mirrorFile, agent, true);

// S1a: single-instance bridge lock — PID-file under ~/.treebird-chat/locks/ (0700)
// flock(2) is unavailable in plain Node; PID + kill(0) liveness check is equivalent
// for our threat model (local user, same machine).
const LOCKS_DIR = join(homedir(), '.treebird-chat', 'locks');
const lockFile = join(LOCKS_DIR, `${chatId}.pid`);
mkdirSync(LOCKS_DIR, { recursive: true, mode: 0o700 });
// mkdirSync's `mode` only applies on creation — re-assert for a pre-existing
// dir with looser perms. (Rubber-duck #6.)
try { chmodSync(LOCKS_DIR, 0o700); } catch { /* not fatal */ }

function readLivePid(path) {
  try {
    const pid = parseInt(readFileSync(path, 'utf8').trim(), 10);
    if (!pid || isNaN(pid)) return null;
    process.kill(pid, 0); // throws ESRCH if dead, EPERM if alive but unowned
    return pid;
  } catch (e) {
    if (e.code === 'EPERM') return parseInt(readFileSync(path, 'utf8').trim(), 10);
    return null; // ESRCH = stale or unreadable
  }
}

const livePid = readLivePid(lockFile);

process.stderr.write(`[join] ${agent} → ${chatId} via ${joinUrl}\n`);
process.stderr.write(`[join] mirror: ${mirrorFile} (${mirrorSource})\n`);

// Supervised bridge loop — restarts the smalltoak bridge on crash with
// exponential backoff. Five crashes inside 60 s triggers a panic log and
// stops. Runs concurrently with the corrwait supervisor; neither loop owns
// the other. P3 acceptance criterion: kill bridge mid-session, restarts
// within 10 s (backoff starts at 1 s).
//
// onProc(proc) is called each time a new child is spawned so the caller
// can hold a reference for synchronous cleanup on SIGTERM.
async function runBridgeLoop({ bridgeArgs, env, lockFile: lf, signal, onProc }) {
  const PANIC_COUNT = 5;
  const PANIC_WINDOW_MS = 60_000;
  const MAX_BACKOFF_MS = 30_000;
  let backoffMs = 1_000;
  const crashes = [];

  while (!signal.aborted) {
    const proc = spawn(process.execPath, bridgeArgs, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });
    if (onProc) onProc(proc);
    proc.stdout.on('data', d => process.stderr.write(`[bridge] ${d}`));
    proc.stderr.on('data', d => process.stderr.write(`[bridge] ${d}`));
    // proc.pid is set synchronously after spawn() regardless of when the
    // 'spawn' event fires — write immediately to avoid the spawn/exit race.
    if (proc.pid) {
      try { writeFileSync(lf, String(proc.pid), { mode: 0o600 }); } catch {}
    }

    const exitCode = await new Promise((resolve) => {
      proc.on('error', (err) => {
        process.stderr.write(`[bridge] spawn error: ${err.message}\n`);
        resolve(null);
      });
      proc.on('close', resolve);
    });
    try { rmSync(lf); } catch {}
    if (signal.aborted) break;

    // Count crash and check panic threshold immediately — before sleeping —
    // so a broken config panics on the 5th crash without a backoff delay.
    const now = Date.now();
    crashes.push(now);
    while (crashes.length && crashes[0] < now - PANIC_WINDOW_MS) crashes.shift();
    if (crashes.length >= PANIC_COUNT) {
      process.stderr.write(`[bridge] PANIC: ${PANIC_COUNT} crashes in ${Math.round(PANIC_WINDOW_MS / 1000)}s — giving up\n`);
      break;
    }

    process.stderr.write(`[bridge] exited (code ${exitCode ?? 'null'}), restarting in ${backoffMs}ms\n`);
    await new Promise(r => {
      const t = setTimeout(r, backoffMs);
      signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true });
    });
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
  }
  try { rmSync(lf); } catch {}
}

let currentBridgeProc = null;
const bridgeController = new AbortController();

if (livePid) {
  process.stderr.write(`[join] bridge already running (pid ${livePid}), attaching\n`);
} else {
  const bridgeArgs = [
    join(__dir, 'treebird-chat-bridge.mjs'),
    chatId, mirrorFile,
    '--smalltoak-url', joinUrl,
    '--as', agent,
  ];
  if (certFile) bridgeArgs.push('--cert-file', certFile);
  // Intentionally not awaited — runs concurrently with the corrwait supervisor.
  runBridgeLoop({
    bridgeArgs,
    env: spawnEnv({
      SMALLTOAK_TOKEN: token,
      BIRDCHAT_AGENT: agent,
      // Belt-and-braces: env-pass the cert path too, so a bridge that loses
      // its argv (unlikely but possible via wrapper scripts) still pins.
      ...(certFile ? { SMALLTOAK_CERT_FILE: certFile } : {}),
    }),
    lockFile,
    signal: bridgeController.signal,
    onProc: (p) => { currentBridgeProc = p; },
  });
}

const cleanup = async (msg) => {
  if (msg) process.stderr.write(`[join] ${msg}\n`);
  if (parentFile) {
    try { await closeSubInParent(parentFile, mirrorFile, null, agent); }
    catch (e) { process.stderr.write(`[join] parent close failed: ${e.message}\n`); }
  }
  bridgeController.abort();
  // Synchronous cleanup before process.exit — async continuations in the
  // bridge loop won't run after exit(). Kill the bridge so it doesn't
  // orphan on SIGTERM-to-parent, and remove the lockFile unconditionally.
  if (currentBridgeProc) try { currentBridgeProc.kill(); } catch {}
  try { rmSync(lockFile); } catch {}
  process.exit(0);
};
process.on('SIGINT', () => cleanup('leaving'));
process.on('SIGTERM', () => cleanup('terminated'));

// give bridge a moment to connect before listening (skip when attaching)
if (!livePid) await new Promise(r => setTimeout(r, 900));

if (tui) {
  if (mentionOnlyExplicit) {
    process.stderr.write('[join] --mention-only has no effect with --tui (TUI shows every message; filtering applies only to the corrwait loop)\n');
  }
  process.stderr.write('[join] opening TUI ...\n');
  const chatArgs = [join(__dir, 'treebird-chat.mjs'), mirrorFile, '--as', agent];
  if (parentFile) chatArgs.push('--parent', parentFile);
  const chat = spawn(process.execPath, chatArgs,
    { env: spawnEnv({ BIRDCHAT_AGENT: agent }), stdio: 'inherit' }
  );
  chat.on('exit', () => cleanup('TUI closed'));
} else {
  process.stderr.write(
    `[join] corrwait loop running (${mentionOnly ? 'mention-only — pass --all-traffic for every line' : 'all-traffic'}) — Ctrl-C to leave\n\n`
  );
  const corrwait = join(__dir, 'corrwait.mjs');
  // P3: supervised loop. Same shape, observable restarts + panic threshold.
  const extraArgs = ['--end-word', '/end'];
  if (mentionOnly) extraArgs.push('--on-mention');
  const result = await supervise({
    corrwaitBin: corrwait,
    filePath: mirrorFile,
    agent,
    extraArgs,
    onWake: (payload) => {
      process.stdout.write(`WAKE ${new Date().toLocaleTimeString()}${payload.fromCatchup ? ' (catchup)' : ''}\n`);
      for (const line of payload.wakeLines || []) process.stdout.write(`  ${line}\n`);
      process.stdout.write(JSON.stringify(payload) + '\n');
    },
  });
  if (result.reason === 'PANIC') process.stderr.write(`[join] supervisor panicked after ${result.restarts} restarts — exiting\n`);
  cleanup(result.reason === 'PANIC' ? 'supervisor panic' : 'session ended');
}
