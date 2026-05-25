#!/usr/bin/env node
// treebird-chat-join <chatId> [--smalltoak-url URL] [--as agent] [--tui]
//
// Single-command join for a remote treebird-chat session.
// Reads SMALLTOAK_TOKEN from ~/.treebird-chat/.env automatically.
// Default: spawns bridge in background, runs corrwait loop in foreground.
// With --tui: spawns bridge then opens the full TUI.

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

let chatId = null, asArg = null, smalltoakUrl = null, tui = false, parentFile = null, certFileArg = null;
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--as') asArg = argv[++i];
    else if (argv[i] === '--smalltoak-url') smalltoakUrl = argv[++i];
    else if (argv[i] === '--parent') parentFile = argv[++i];
    else if (argv[i] === '--cert-file') certFileArg = argv[++i];
    else if (argv[i] === '--tui') tui = true;
    else if (!argv[i].startsWith('--') && !chatId) chatId = argv[i];
  }
}
if (!chatId) {
  process.stderr.write('usage: treebird-chat-join <chatId> [--smalltoak-url URL] [--as agent] [--cert-file PATH] [--tui]\n');
  process.exit(1);
}
if (!/^[a-zA-Z0-9_-]+$/.test(chatId)) {
  process.stderr.write('Invalid chatId: must match [a-zA-Z0-9_-]+\n');
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
    'No smalltoak URL. Pass --smalltoak-url, set SMALLTOAK_SERVER_URL in ~/.treebird-chat/.env,\n' +
    'or (with envoak) `envoak vault set treebird-chat SMALLTOAK_SERVER_URL <url>`.\n'
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
    'No SMALLTOAK_TOKEN. Add it to ~/.treebird-chat/.env:\n' +
    '  mkdir -p ~/.treebird-chat && chmod 700 ~/.treebird-chat\n' +
    '  printf \'SMALLTOAK_TOKEN=%s\\n\' \\\n' +
    '    "$(envoak vault get treebird-chat SMALLTOAK_TOKEN)" \\\n' +
    '    >> ~/.treebird-chat/.env\n' +
    '  chmod 600 ~/.treebird-chat/.env\n'
  );
  process.exit(1);
}

// Closes issue #6 P2. Previously this was hardcoded to /tmp/<chatId>.md,
// which silently orphaned every joiner from the canonical canopy file the
// wizard registered. Now we honour sessions.json; /tmp remains the fallback
// for remote invites where the joiner has no local registration.
const { mirrorFile, source: mirrorSource, warning: mirrorWarning } = resolveMirrorFile(chatId);
if (mirrorWarning) process.stderr.write(`[join] WARN: ${mirrorWarning}\n`);
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

let bridge = null;

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
  bridge = spawn(
    process.execPath,
    bridgeArgs,
    {
      env: spawnEnv({
        SMALLTOAK_TOKEN: token,
        BIRDCHAT_AGENT: agent,
        // Belt-and-braces: env-pass the cert path too, so a bridge that loses
        // its argv (unlikely but possible via wrapper scripts) still pins.
        ...(certFile ? { SMALLTOAK_CERT_FILE: certFile } : {}),
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    }
  );
  bridge.stdout.on('data', d => process.stderr.write(`[bridge] ${d}`));
  bridge.stderr.on('data', d => process.stderr.write(`[bridge] ${d}`));
  bridge.on('spawn', () => {
    writeFileSync(lockFile, String(bridge.pid), { mode: 0o600 });
  });
}

const cleanup = async (msg) => {
  if (msg) process.stderr.write(`[join] ${msg}\n`);
  if (parentFile) {
    try { await closeSubInParent(parentFile, mirrorFile, null, agent); }
    catch (e) { process.stderr.write(`[join] parent close failed: ${e.message}\n`); }
  }
  if (bridge) {
    try { rmSync(lockFile); } catch {}
    try { bridge.kill(); } catch {}
  }
  process.exit(0);
};
process.on('SIGINT', () => cleanup('leaving'));
process.on('SIGTERM', () => cleanup('terminated'));

if (bridge) {
  bridge.on('exit', code => {
    try { rmSync(lockFile); } catch {}
    cleanup(code ? `bridge exited ${code}` : 'bridge closed');
  });
}

// give bridge a moment to connect before listening (skip when attaching)
if (bridge) await new Promise(r => setTimeout(r, 900));

if (tui) {
  process.stderr.write('[join] opening TUI ...\n');
  const chatArgs = [join(__dir, 'treebird-chat.mjs'), mirrorFile, '--as', agent];
  if (parentFile) chatArgs.push('--parent', parentFile);
  const chat = spawn(process.execPath, chatArgs,
    { env: spawnEnv({ BIRDCHAT_AGENT: agent }), stdio: 'inherit' }
  );
  chat.on('exit', () => cleanup('TUI closed'));
} else {
  process.stderr.write(`[join] corrwait loop running — Ctrl-C to leave\n\n`);
  const corrwait = join(__dir, 'corrwait.mjs');
  // P3: supervised loop. Same shape, observable restarts + panic threshold.
  const result = await supervise({
    corrwaitBin: corrwait,
    filePath: mirrorFile,
    agent,
    extraArgs: ['--end-word', '/end'],
    onWake: (payload) => {
      process.stdout.write(`WAKE ${new Date().toLocaleTimeString()}${payload.fromCatchup ? ' (catchup)' : ''}\n`);
      for (const line of payload.wakeLines || []) process.stdout.write(`  ${line}\n`);
      process.stdout.write(JSON.stringify(payload) + '\n');
    },
  });
  if (result.reason === 'PANIC') process.stderr.write(`[join] supervisor panicked after ${result.restarts} restarts — exiting\n`);
  cleanup(result.reason === 'PANIC' ? 'supervisor panic' : 'session ended');
}
