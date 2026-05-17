#!/usr/bin/env node
// treebird-chat-join <chatId> [--smalltoak-url URL] [--as agent] [--tui]
//
// Single-command join for a remote treebird-chat session.
// Reads SMALLTOAK_TOKEN from ~/.treebird-chat/.env automatically.
// Default: spawns bridge in background, runs corrwait loop in foreground.
// With --tui: spawns bridge then opens the full TUI.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, resolvePublicUrl, spawnEnv } from '../lib/config.mjs';
import { verifyAgentIdentity } from '../lib/identity.mjs';
import { setAllowed } from '../lib/access.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));

loadEnv();

let chatId = null, asArg = null, smalltoakUrl = null, tui = false;
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--as') asArg = argv[++i];
    else if (argv[i] === '--smalltoak-url') smalltoakUrl = argv[++i];
    else if (argv[i] === '--tui') tui = true;
    else if (!argv[i].startsWith('--') && !chatId) chatId = argv[i];
  }
}
if (!chatId) {
  process.stderr.write('usage: treebird-chat-join <chatId> [--smalltoak-url URL] [--as agent] [--tui]\n');
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

if (!smalltoakUrl) smalltoakUrl = process.env.SMALLTOAK_URL || process.env.SMALLTOAK_SERVER_URL;
if (!smalltoakUrl) {
  process.stderr.write(
    'No smalltoak URL. Pass --smalltoak-url or set SMALLTOAK_URL in ~/.treebird-chat/.env\n'
  );
  process.exit(1);
}
const { url: joinUrl } = resolvePublicUrl(smalltoakUrl);

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

const mirrorFile = `/tmp/${chatId}.md`;
if (!existsSync(mirrorFile)) writeFileSync(mirrorFile, '');

// local ACL (pre-T10; bridge is the real gate post-T10)
setAllowed(mirrorFile, agent, true);

// S1a: single-instance bridge lock — PID-file under ~/.treebird-chat/locks/ (0700)
// flock(2) is unavailable in plain Node; PID + kill(0) liveness check is equivalent
// for our threat model (local user, same machine).
const LOCKS_DIR = join(homedir(), '.treebird-chat', 'locks');
const lockFile = join(LOCKS_DIR, `${chatId}.pid`);
mkdirSync(LOCKS_DIR, { recursive: true, mode: 0o700 });

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
process.stderr.write(`[join] mirror: ${mirrorFile}\n`);

let bridge = null;

if (livePid) {
  process.stderr.write(`[join] bridge already running (pid ${livePid}), attaching\n`);
} else {
  bridge = spawn(
    process.execPath,
    [join(__dir, 'treebird-chat-bridge.mjs'), chatId, mirrorFile, '--smalltoak-url', joinUrl, '--as', agent],
    {
      env: spawnEnv({ SMALLTOAK_TOKEN: token, BIRDCHAT_AGENT: agent }),
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

const cleanup = (msg) => {
  if (msg) process.stderr.write(`[join] ${msg}\n`);
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
  const chat = spawn(
    process.execPath,
    [join(__dir, 'treebird-chat.mjs'), mirrorFile, '--as', agent],
    { env: spawnEnv({ BIRDCHAT_AGENT: agent }), stdio: 'inherit' }
  );
  chat.on('exit', () => cleanup('TUI closed'));
} else {
  process.stderr.write(`[join] corrwait loop running — Ctrl-C to leave\n\n`);
  const corrwait = join(__dir, 'corrwait.mjs');
  while (true) {
    const cw = spawn(
      process.execPath,
      [corrwait, mirrorFile, '--as', agent, '--timeout', '540', '--end-word', '/end'],
      { env: spawnEnv({ BIRDCHAT_AGENT: agent }), stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let out = '';
    cw.stdout.on('data', d => { out += d.toString(); });
    cw.stderr.on('data', d => process.stderr.write(d));
    const code = await new Promise(r => cw.on('exit', r));
    if (code === 0) {
      try {
        const d = JSON.parse(out);
        process.stdout.write(`WAKE ${new Date().toLocaleTimeString()}\n`);
        for (const line of d.wakeLines || []) process.stdout.write(`  ${line}\n`);
        process.stdout.write(JSON.stringify(d) + '\n');
      } catch { process.stdout.write(out + '\n'); }
    } else if (code === 1 || code === 3) {
      cleanup('session ended');
    } else if (code === 2) {
      // timeout — re-arm silently
    } else {
      process.stderr.write(`[corrwait] unexpected exit ${code}\n`);
      break;
    }
  }
  cleanup();
}
