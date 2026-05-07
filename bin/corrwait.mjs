#!/usr/bin/env node
// corrwait <CORR_file> [--end-word "/end"] [--timeout 540]
//
// Blocks until one of:
//   - new round from any agent       → exit 0, print wake content
//   - new human comment              → exit 0, print wake content
//   - end-word in human comment      → exit 1 (END)
//   - <CORR_file>.end sidecar exists → exit 1 (END)
//   - this agent revoked in ACL      → exit 3 (REVOKED)
//   - self-timeout reached           → exit 2 (re-invoke)
//
// Identity: requires ENVOAK_AGENT_LABEL in env (run dawn first).
// Access:   requires the agent to be allowed in <CORR_file>.access.json.

import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import chokidar from 'chokidar';
import { verifyAgentIdentity } from '../lib/identity.mjs';
import { isAllowed, readAcl, aclPath, readCursor, writeCursor } from '../lib/access.mjs';
import { appendLine } from '../lib/writer.mjs';
import {
  snapshotAtCursor,
  snapshot,
  diffSinceBaseline,
  endMarkerExists,
  endMarkerPath,
} from '../lib/watcher.mjs';

const EXIT = { WAKE: 0, END: 1, TIMEOUT: 2, REVOKED: 3, ERROR: 4 };

function parseArgs(argv) {
  const args = {
    file: null,
    endWord: '/end',
    timeoutSec: 540,
    as: null,
    onMention: false,
    write: null,
    writeMode: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--end-word') args.endWord = argv[++i];
    else if (a === '--timeout') args.timeoutSec = parseInt(argv[++i], 10);
    else if (a === '--as') args.as = argv[++i];
    else if (a === '--on-mention') args.onMention = true;
    else if (a === '--write') {
      args.writeMode = true;
      args.write = argv[++i];
    }
    else if (!a.startsWith('--') && !args.file) args.file = a;
  }
  return args;
}

function emit(reason, payload = {}) {
  process.stdout.write(JSON.stringify({ reason, ...payload }) + '\n');
}

async function main() {
  const { file, endWord, timeoutSec, as, onMention, write, writeMode: isWriteMode } =
    parseArgs(process.argv.slice(2));
  if (!file) {
    process.stderr.write(
      'usage: corrwait <CORR_file> [--as <agent>] [--write <message>] [--on-mention] [--end-word "/end"] [--timeout 540]\n'
    );
    process.exit(EXIT.ERROR);
  }
  if (isWriteMode && write == null) {
    process.stderr.write('usage: corrwait <CORR_file> --write <message> [--as <agent>]\n');
    process.exit(EXIT.ERROR);
  }

  const filePath = resolve(file);
  if (!existsSync(filePath)) {
    process.stderr.write(`File not found: ${filePath}\n`);
    process.exit(EXIT.ERROR);
  }

  let identity;
  try {
    identity = verifyAgentIdentity(as);
  } catch (e) {
    process.stderr.write(`Identity check failed: ${e.message}\n`);
    process.exit(EXIT.ERROR);
  }
  const { agent } = identity;

  const acl = readAcl(filePath);
  if (!acl) {
    process.stderr.write(
      `No ACL at ${aclPath(filePath)}. Owner must run: treebird-chat-allow ${file} ${agent}\n`
    );
    process.exit(EXIT.ERROR);
  }
  if (!isAllowed(filePath, agent)) {
    emit('REVOKED', { agent });
    process.exit(EXIT.REVOKED);
  }

  if (isWriteMode) {
    await appendLine(filePath, agent, write);
    process.exit(EXIT.WAKE);
  }

  if (endMarkerExists(filePath)) {
    emit('END', { source: 'sidecar', path: endMarkerPath(filePath) });
    process.exit(EXIT.END);
  }

  // Baseline = max(implicit cursor from agent's last self-message,
  // persisted cursor from prior WAKE). Persisted cursor advances even when
  // the agent chooses to stay quiet, so the same content isn't replayed.
  const implicit = snapshotAtCursor(filePath, agent);
  const persisted = readCursor(filePath, agent);
  const baseline = persisted > implicit.lines.length
    ? { length: 0, lines: snapshot(filePath).lines.slice(0, persisted) }
    : implicit;

  let watcher = null;
  let resolved = false;
  const finish = (code, reason, payload) => {
    if (resolved) return;
    resolved = true;
    // Persist cursor on WAKE so the next corrwait skips already-seen content
    // even if the agent chooses to stay quiet (no self-message to advance the
    // implicit cursor). Cursor = number of real lines (excluding the trailing
    // empty that `split('\n')` produces for files ending in '\n').
    if (reason === 'WAKE') {
      try {
        const lines = snapshot(filePath).lines;
        const realLines = lines.length > 0 && lines[lines.length - 1] === ''
          ? lines.length - 1
          : lines.length;
        writeCursor(filePath, agent, realLines);
      } catch { /* non-fatal */ }
    }
    emit(reason, { agent, ...payload });
    if (watcher) {
      watcher.close().finally(() => process.exit(code));
    } else {
      process.exit(code);
    }
  };

  // Catchup: if there's already pending wake-worthy content, fire immediately.
  // Pass `agent` so self-authored lines never trigger wake (filters self-noise
  // when a stale corrwait was running while this agent appended).
  const mentionTarget = onMention ? agent : null;
  const initial = diffSinceBaseline(filePath, baseline, endWord, agent, mentionTarget);
  if (initial.endViaWord) {
    return finish(EXIT.END, 'END', {
      source: 'end-word',
      endWord,
      newContent: initial.newLines.join('\n'),
    });
  }
  if (initial.woke) {
    return finish(EXIT.WAKE, 'WAKE', {
      wakeLines: initial.wakeLines,
      newContent: initial.newLines.join('\n'),
      newRound: initial.hasNewRound,
      newHuman: initial.hasNewHuman,
      newFreeform: initial.hasNewFreeform,
      immediate: true, // woke from pending content already in file at startup
    });
  }

  // Self-timeout — caller re-invokes immediately on TIMEOUT.
  const timer = setTimeout(() => finish(EXIT.TIMEOUT, 'TIMEOUT'), timeoutSec * 1000);

  // Polling mode: immune to atomic-rename saves (Zed, VS Code, vim's
  // backup-and-rename, etc) which swap inodes and break inode-based watchers.
  // 500ms interval is fast enough for a chat loop.
  watcher = chokidar.watch([filePath, aclPath(filePath), endMarkerPath(filePath)], {
    ignoreInitial: true,
    usePolling: true,
    interval: 500,
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
  });

  const check = () => {
    if (resolved) return;

    // Re-check ACL on every change — owner may have toggled this agent off.
    if (!isAllowed(filePath, agent)) {
      clearTimeout(timer);
      return finish(EXIT.REVOKED, 'REVOKED');
    }

    if (endMarkerExists(filePath)) {
      clearTimeout(timer);
      return finish(EXIT.END, 'END', { source: 'sidecar' });
    }

    const diff = diffSinceBaseline(filePath, baseline, endWord, agent, mentionTarget);

    if (diff.endViaWord) {
      clearTimeout(timer);
      return finish(EXIT.END, 'END', { source: 'end-word', endWord });
    }

    if (diff.woke) {
      clearTimeout(timer);
      return finish(EXIT.WAKE, 'WAKE', {
        wakeLines: diff.wakeLines,
        newContent: diff.newLines.join('\n'),
        newRound: diff.hasNewRound,
        newHuman: diff.hasNewHuman,
        newFreeform: diff.hasNewFreeform,
      });
    }
  };

  watcher.on('add', check).on('change', check).on('unlink', check);
}

main().catch((e) => {
  process.stderr.write(`corrwait error: ${e.stack || e.message}\n`);
  process.exit(EXIT.ERROR);
});
