// Auto-spawn a smalltoak bridge for a freshly created sub-chat.
//
// Closes the bridge half of issue #6 P2.1. After `/sub <topic>` creates a sub
// file locally, this:
//   1. Derives a deterministic sub chat-id from the parent session and the
//      sanitised topic (so peer machines can derive the same one and join via
//      `treebird-chat-join <sub-chat-id>`).
//   2. Registers the sub in `sessions.json` so a same-machine re-join attaches
//      to the canonical sub file via PR #8's resolveMirrorFile().
//   3. Spawns a detached bridge process tailing the sub file ↔ smalltoak
//      chat-id `<parent>-sub-<topic>`. Detached because the sub's lifetime is
//      not the parent TUI's — agents can still join the sub after the parent
//      session ends.
//
// All three are no-ops when the parent has no smalltoak session registered
// (running TUI on a bare local file). The caller should report the reason so
// operators understand whether the sub is bridged or local-only.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { findSessionByPath, saveSession, spawnEnv } from './config.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const BRIDGE_BIN = join(__dir, '..', 'bin', 'treebird-chat-bridge.mjs');
const LOCKS_DIR = join(homedir(), '.treebird-chat', 'locks');

// Sanitise a sub topic the same way resolveSub does (lib/wikilink.mjs:222).
// Keeps the chat-id within smalltoak's [a-zA-Z0-9_-]+ alphabet (the same
// regex bin/treebird-chat-join.mjs:41 enforces on its argv).
function sanitiseTopic(topic) {
  return topic.replace(/[^A-Za-z0-9_-]/g, '-');
}

// Deterministic naming so machines that didn't run `/sub` can still derive
// the chat-id. Format: `<parent-chat-id>-sub-<safe-topic>`.
export function subChatId(parentChatId, topic) {
  return `${parentChatId}-sub-${sanitiseTopic(topic)}`;
}

// PID-file liveness check (mirrors join's S1a check; one bridge per chat-id).
function readLivePid(lockFile) {
  try {
    const pid = parseInt(readFileSync(lockFile, 'utf8').trim(), 10);
    if (!pid || isNaN(pid)) return null;
    process.kill(pid, 0);
    return pid;
  } catch { return null; }
}

// Spawn (or attach to) the sub-chat bridge.
//
// Returns one of:
//   { spawned: true,  chatId, pid, attached: false }  — fresh spawn
//   { spawned: true,  chatId, pid, attached: true  }  — bridge was already up
//   { spawned: false, reason }                        — parent unregistered etc
export function spawnSubBridge({ parentFile, subFile, subTopic, agent }) {
  if (!existsSync(subFile)) {
    return { spawned: false, reason: 'sub file does not exist' };
  }

  const parent = findSessionByPath(parentFile);
  if (!parent?.chatId || !parent?.smalltoakUrl) {
    return {
      spawned: false,
      reason: 'parent has no smalltoak session — sub stays local-only',
    };
  }

  const chatId = subChatId(parent.chatId, subTopic);

  // Register the sub in sessions.json so a same-machine `treebird-chat-join
  // <chatId>` resolves through PR #8's resolveMirrorFile() to *this* sub
  // file, not a /tmp orphan. Inherit URL/token from parent.
  saveSession(chatId, {
    filePath: subFile,
    smalltoakUrl: parent.smalltoakUrl,
    smalltoakToken: parent.smalltoakToken,
    smalltoakCertFile: parent.smalltoakCertFile,
    humanName: parent.humanName,
    parentChatId: parent.chatId,
  });

  // Idempotency: if a bridge is already running for this sub (e.g. someone
  // ran `/sub` twice), don't spawn another — there'd be two relays echoing
  // each other.
  mkdirSync(LOCKS_DIR, { recursive: true, mode: 0o700 });
  const lockFile = join(LOCKS_DIR, `${chatId}.pid`);
  const livePid = readLivePid(lockFile);
  if (livePid) {
    return { spawned: true, chatId, pid: livePid, attached: true };
  }

  // The bearer token must come from env, not the saved session — saveSession
  // stores it 0600 but spawning a child with a token in argv would expose it
  // to ps(1) on a shared machine.
  const token =
    process.env.SMALLTOAK_TOKEN || parent.smalltoakToken;
  if (!token) {
    return { spawned: false, reason: 'no SMALLTOAK_TOKEN in env or parent session' };
  }

  const args = [
    BRIDGE_BIN,
    chatId, subFile,
    '--smalltoak-url', parent.smalltoakUrl,
    '--as', agent,
  ];
  if (parent.smalltoakCertFile) args.push('--cert-file', parent.smalltoakCertFile);

  // Detached + unref'd: the sub bridge outlives the parent TUI. The TUI is
  // not the supervisor for sub bridges — they live until killed via
  // `treebird-chat-join` cleanup or explicit kill.
  const child = spawn(process.execPath, args, {
    env: spawnEnv({
      SMALLTOAK_TOKEN: token,
      BIRDCHAT_AGENT: agent,
      ...(parent.smalltoakCertFile ? { SMALLTOAK_CERT_FILE: parent.smalltoakCertFile } : {}),
    }),
    stdio: 'ignore',
    detached: true,
  });
  child.unref();

  if (!child.pid) {
    return { spawned: false, reason: 'spawn returned no pid' };
  }

  // Best-effort lockfile write — same shape as join.mjs's S1a guard.
  try {
    writeFileSync(lockFile, String(child.pid), { mode: 0o600 });
  } catch { /* swallow — the bridge is still live, just unlocked */ }

  return { spawned: true, chatId, pid: child.pid, attached: false };
}
