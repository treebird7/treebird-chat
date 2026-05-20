#!/usr/bin/env node
// treebird-chat-status [<chat-id>]
//
// Lists registered chats and their bridge liveness. The "am I actually
// present?" check P3 of issue #6 asked for. With no args, lists all chats;
// with a chat-id, shows only that one.
//
// This is the vanilla path — reads sessions.json + lockfiles. envoak hive
// state integration (for per-agent heartbeat ages) is a follow-up; this
// works without envoak installed.
//
// Exit codes:
//   0 — all queried chats have a live bridge
//   1 — at least one chat has a dead/missing bridge
//   2 — usage / argv error

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadEnv, listSessions } from '../lib/config.mjs';

loadEnv();

const LOCKS_DIR = join(homedir(), '.treebird-chat', 'locks');

// Liveness check for a bridge by its chat-id. Reads the PID lockfile and
// probes with kill(0). Same pattern bin/treebird-chat-join.mjs uses for
// the S1a single-instance guard.
function bridgeLiveness(chatId) {
  const lockFile = join(LOCKS_DIR, `${chatId}.pid`);
  if (!existsSync(lockFile)) return { state: 'no-lock', pid: null, age: null };
  let pid;
  try { pid = parseInt(readFileSync(lockFile, 'utf8').trim(), 10); }
  catch { return { state: 'unreadable-lock', pid: null, age: null }; }
  if (!pid || Number.isNaN(pid)) {
    return { state: 'corrupt-lock', pid: null, age: null };
  }
  try {
    process.kill(pid, 0); // probe — throws ESRCH if dead, EPERM if alive
    let age = null;
    try { age = Math.floor((Date.now() - statSync(lockFile).mtimeMs) / 1000); } catch { /* ignore */ }
    return { state: 'live', pid, age };
  } catch (e) {
    if (e.code === 'EPERM') return { state: 'live-but-foreign', pid, age: null };
    return { state: 'dead', pid, age: null }; // ESRCH
  }
}

function formatAge(seconds) {
  if (seconds == null) return '';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function tag(state) {
  switch (state) {
    case 'live': return '✓ bridge      ';
    case 'live-but-foreign': return '✓ bridge (other user)';
    case 'no-lock': return '· no bridge   ';
    case 'dead': return '✗ stale lock  ';
    case 'corrupt-lock': return '! corrupt lock';
    case 'unreadable-lock': return '! lock unreadable';
    default: return state;
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write('usage: treebird-chat-status [<chat-id>]\n');
    process.exit(2);
  }
  const filter = args.find((a) => !a.startsWith('--')) ?? null;

  const sessions = listSessions();
  const ids = filter
    ? (sessions[filter] ? [filter] : [])
    : Object.keys(sessions).sort();

  if (filter && !sessions[filter]) {
    process.stderr.write(`unknown chat-id: ${filter}\n`);
    process.exit(2);
  }
  if (ids.length === 0) {
    process.stderr.write('no sessions registered. Run `treebird-chat-wizard` to register one.\n');
    process.exit(2);
  }

  let anyDead = false;
  for (const id of ids) {
    const sess = sessions[id];
    const live = bridgeLiveness(id);
    if (live.state !== 'live' && live.state !== 'live-but-foreign') anyDead = true;

    const age = live.age != null ? `, lock ${formatAge(live.age)} old` : '';
    const pid = live.pid ? `pid ${live.pid}` : '';
    const meta = [pid, age.slice(2)].filter(Boolean).join(', ');
    process.stdout.write(`${id}\n`);
    process.stdout.write(`  ${tag(live.state)}  ${meta}\n`);
    if (sess.filePath) process.stdout.write(`  file=${sess.filePath}\n`);
    if (sess.smalltoakUrl) process.stdout.write(`  url=${sess.smalltoakUrl}\n`);
    process.stdout.write('\n');
  }

  // Orphan bridges: lockfiles for chat-ids not in sessions.json. These can
  // be ad-hoc remote joins, stale locks, or bridges spawned before the chat
  // was registered. Worth surfacing — they can hold a bridge open against a
  // /tmp mirror nothing else knows about (the pre-PR-#8 failure mode).
  if (!filter && existsSync(LOCKS_DIR)) {
    let lockFiles = [];
    try { lockFiles = readdirSync(LOCKS_DIR).filter((f) => f.endsWith('.pid')); } catch { /* */ }
    const known = new Set(Object.keys(sessions));
    const orphanIds = lockFiles
      .map((f) => f.replace(/\.pid$/, ''))
      .filter((id) => !known.has(id));
    if (orphanIds.length) {
      process.stdout.write('── orphan bridges (lockfile without sessions.json entry) ──\n');
      for (const id of orphanIds) {
        const live = bridgeLiveness(id);
        const pid = live.pid ? `pid ${live.pid}` : '';
        const age = live.age != null ? `, lock ${formatAge(live.age)} old` : '';
        const meta = [pid, age.slice(2)].filter(Boolean).join(', ');
        process.stdout.write(`${id}\n  ${tag(live.state)}  ${meta}\n\n`);
      }
    }
  }

  process.exit(anyDead ? 1 : 0);
}

main();
