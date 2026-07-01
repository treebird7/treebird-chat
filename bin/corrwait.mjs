#!/usr/bin/env node
// corrwait <CORR_file> [--end-word "/end"] [--timeout 540] [--catchup]
//
// Blocks until one of:
//   - new round from any agent       → exit 0, print wake content
//   - new human comment              → exit 0, print wake content
//   - end-word in human comment      → exit 1 (END)
//   - <CORR_file>.end sidecar exists → exit 1 (END)
//   - this agent revoked in ACL      → exit 3 (REVOKED)
//   - self-timeout reached           → exit 2 (re-invoke)
//
// --catchup: non-blocking one-shot read. Emits CATCHUP with all new content
//   since the cursor, advances the cursor, and exits immediately (exit 0).
//   Useful for reading session context after waking on an external signal.
//
// Identity: requires ENVOAK_AGENT_LABEL in env (run dawn first).
// Access:   requires the agent to be allowed in <CORR_file>.access.json.

import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import chokidar from 'chokidar';
import { verifyAgentIdentity, parseLabel } from '../lib/identity.mjs';
import { isAllowed, readAcl, aclPath, readCursor, writeCursor, isApprovedUnverified, setApprovedUnverified } from '../lib/access.mjs';
import { runApproveHook } from '../lib/approve-hook.mjs';
import { appendLine } from '../lib/writer.mjs';
import { loadEnv, loadSession } from '../lib/config.mjs';
import {
  snapshotAtCursor,
  snapshot,
  diffSinceBaseline,
  endMarkerExists,
  endMarkerPath,
} from '../lib/watcher.mjs';

loadEnv();

const EXIT = { WAKE: 0, END: 1, TIMEOUT: 2, REVOKED: 3, ERROR: 4 };

const USAGE = `corrwait — agent loop primitive: block until new chat content, or write/catch-up

usage: corrwait <file> [--as <agent>] [--session <chat-id>]
                 [--write <message>] [--ack <ref>] [--catchup] [--on-mention]
                 [--end-word "/end"] [--timeout 540]

  --as <agent>      identity when no ENVOAK_AGENT_LABEL/BIRDCHAT_AGENT is set (unverified)
  --write <message> append one line as this agent, print a WROTE confirmation, exit
  --ack <ref>       post a one-line "seen it" receipt referencing <ref> and mark
                    everything up to now as read (advances the cursor), then exit
  --catchup         non-blocking one-shot: emit all new content since cursor, exit
  --on-mention      only wake on lines that @mention this agent
  --raw             also emit newContent (raw new lines incl. self); default is
                    wakeLines only — leaner payload, no self-echo (bridges pass this)
  --end-word <w>    human end sentinel (default: /end)
  --timeout <secs>  self-timeout; caller re-invokes on TIMEOUT (default: 540)

exit codes: 0 WAKE/CATCHUP/WROTE · 1 END · 2 TIMEOUT(re-invoke) · 3 REVOKED · 4 ERROR
`;

function parseArgs(argv) {
  if (argv.some((a) => a === '--help' || a === '-h')) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  const args = {
    file: null,
    session: null,
    endWord: '/end',
    timeoutSec: 540,
    as: null,
    onMention: false,
    write: null,
    writeMode: false,
    ack: null,
    ackMode: false,
    catchup: false,
    raw: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--end-word') args.endWord = argv[++i];
    else if (a === '--timeout') args.timeoutSec = parseInt(argv[++i], 10);
    else if (a === '--as') args.as = argv[++i];
    else if (a === '--session') args.session = argv[++i];
    else if (a === '--on-mention') args.onMention = true;
    else if (a === '--catchup') args.catchup = true;
    else if (a === '--raw') args.raw = true;
    else if (a === '--write') {
      args.writeMode = true;
      args.write = argv[++i];
    }
    else if (a === '--ack') {
      args.ackMode = true;
      args.ack = argv[++i];
    }
    else if (!a.startsWith('--') && !args.file) args.file = a;
  }
  return args;
}

function emit(reason, payload = {}) {
  process.stdout.write(JSON.stringify({ reason, ...payload }) + '\n');
}

async function main() {
  const { file: rawFile, session, endWord, timeoutSec, as, onMention, write, writeMode: isWriteMode, ack, ackMode: isAckMode, catchup: isCatchup, raw } =
    parseArgs(process.argv.slice(2));

  // --session <chat-id>: look up file path from session registry
  let file = rawFile;
  if (!file && session) {
    const saved = loadSession(session);
    if (!saved) {
      process.stderr.write(`No saved session "${session}". Run treebird-chat-wizard to create one.\n`);
      process.exit(EXIT.ERROR);
    }
    file = saved.filePath;
  }

  if (!file) {
    process.stderr.write(
      'usage: corrwait <CORR_file> [--session <chat-id>] [--as <agent>] [--write <message>] [--on-mention] [--end-word "/end"] [--timeout 540]\n'
    );
    process.exit(EXIT.ERROR);
  }
  if (isWriteMode && write == null) {
    process.stderr.write('usage: corrwait <CORR_file> --write <message> [--as <agent>]\n');
    process.exit(EXIT.ERROR);
  }
  if (isAckMode && (ack == null || String(ack).trim() === '')) {
    process.stderr.write('usage: corrwait <CORR_file> --ack <ref> [--as <agent>]\n');
    process.exit(EXIT.ERROR);
  }
  // --write / --ack / --catchup are three distinct one-shot modes.
  if ([isWriteMode, isAckMode, isCatchup].filter(Boolean).length > 1) {
    process.stderr.write('--write, --ack and --catchup are mutually exclusive\n');
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
  const { agent, verified, instance } = identity;
  // Display/self-detection name for a second+ concurrent instance of the same
  // base agent (SPEC_identity-verification §2), e.g. `sherlock#2`. ACL grants
  // and the cursor's agent-key stay on the base `agent` (by-base is the
  // recommended granularity — one allow admits every instance); only the
  // written line and self-wake filtering need to be instance-specific, or
  // instance 2 would treat instance 1's lines as its own and vice versa.
  const displayName = instance ? `${agent}#${instance}` : agent;

  // Identity-precedence footgun: --as is the lowest-priority source, so a
  // leftover ENVOAK_AGENT_LABEL / BIRDCHAT_AGENT silently wins and the agent
  // would post under the wrong name. Warn loudly instead of failing silently.
  if (as && identity.source !== 'cli' && parseLabel(as).agent !== agent) {
    process.stderr.write(
      `[corrwait] note: --as ${as} ignored; using ${identity.source} identity "${agent}" ` +
      `(ENVOAK_AGENT_LABEL/BIRDCHAT_AGENT take precedence over --as). ` +
      `Run with a clean env to use --as.\n`
    );
  }

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

  // SPEC_identity-verification §3: soft approval gate for unverified (--as /
  // BIRDCHAT_AGENT) identities. Runs once per name — a prior approval is
  // persisted on the ACL entry, so this is a cheap ACL-read on every
  // subsequent invocation once approved. Absent TREEBIRD_CHAT_APPROVE_HOOK,
  // runApproveHook default-allows with no subprocess call — this is a no-op
  // for the vast majority of sessions that never set the hook.
  if (!verified && !isApprovedUnverified(filePath, agent)) {
    const approval = runApproveHook({ file: filePath, agent, source: identity.source });
    if (!approval.approved) {
      emit('UNAPPROVED', { agent, instance, source: identity.source, message: approval.message });
      process.exit(EXIT.REVOKED);
    }
    setApprovedUnverified(filePath, agent, true);
  }

  if (isWriteMode) {
    const message = write.replace(/[\r\n]/g, ' ');
    await appendLine(filePath, displayName, message, { verified });
    // Confirm the write landed — previously --write succeeded silently, leaving
    // no signal that the line was posted. Emit the author + verification status.
    emit('WROTE', { agent, instance, verified, message });
    process.exit(EXIT.WAKE);
  }

  // --ack <ref>: post a lightweight "seen it" receipt and mark everything up to
  // now as read. Cheaper than a full reply when the right response is just "on
  // it" — and unlike a bare --write it also advances the persisted cursor, so
  // the next corrwait doesn't re-surface the content this ack acknowledges.
  if (isAckMode) {
    const ref = String(ack).replace(/[\r\n]/g, ' ').trim();
    await appendLine(filePath, displayName, `✓ ack ${ref}`, { verified });
    try {
      const lines = snapshot(filePath).lines;
      const realLines = lines.length > 0 && lines[lines.length - 1] === ''
        ? lines.length - 1
        : lines.length;
      writeCursor(filePath, agent, realLines, instance);
    } catch (e) { process.stderr.write(`[corrwait] writeCursor failed: ${e.message}\n`); }
    emit('ACKED', { agent, instance, verified, ref });
    process.exit(EXIT.WAKE);
  }

  if (endMarkerExists(filePath)) {
    emit('END', { source: 'sidecar', path: endMarkerPath(filePath) });
    process.exit(EXIT.END);
  }

  // Baseline = max(implicit cursor from agent's last self-message,
  // persisted cursor from prior WAKE). Persisted cursor advances even when
  // the agent chooses to stay quiet, so the same content isn't replayed.
  const implicit = snapshotAtCursor(filePath, displayName);
  const persisted = readCursor(filePath, agent, instance);
  const baseline = persisted > implicit.lines.length
    ? { length: 0, lines: snapshot(filePath).lines.slice(0, persisted) }
    : implicit;

  // --catchup: non-blocking one-shot read. Advance cursor, emit CATCHUP, exit.
  if (isCatchup) {
    const mentionTarget = onMention ? agent : null;
    const diff = diffSinceBaseline(filePath, baseline, endWord, displayName, mentionTarget);
    try {
      const lines = snapshot(filePath).lines;
      const realLines = lines.length > 0 && lines[lines.length - 1] === ''
        ? lines.length - 1
        : lines.length;
      writeCursor(filePath, agent, realLines, instance);
    } catch (e) { process.stderr.write(`[corrwait] writeCursor failed: ${e.message}\n`); }
    emit('CATCHUP', {
      agent,
      instance,
      verified,
      wakeLines: diff.wakeLines,
      ...(raw ? { newContent: diff.newLines.join('\n') } : {}),
      newRound: diff.hasNewRound,
      newHuman: diff.hasNewHuman,
      newFreeform: diff.hasNewFreeform,
      priority: diff.priority,
      woke: diff.woke,
    });
    process.exit(EXIT.WAKE);
  }

  let watcher = null;
  let resolved = false;
  const finish = (code, reason, payload) => {
    if (resolved) return;
    resolved = true;
    // Persist cursor on WAKE so the next corrwait skips already-seen content
    // even if the agent chooses to stay quiet (no self-message to advance the
    // implicit cursor). Cursor = number of real lines (excluding the trailing
    // empty that `split('\n')` produces for files ending in '\n').
    if (reason === 'WAKE' || reason === 'URGENT_WAKE') {
      try {
        const lines = snapshot(filePath).lines;
        const realLines = lines.length > 0 && lines[lines.length - 1] === ''
          ? lines.length - 1
          : lines.length;
        writeCursor(filePath, agent, realLines, instance);
      } catch (e) { process.stderr.write(`[corrwait] writeCursor failed: ${e.message}\n`); }
    }
    emit(reason, { agent, instance, verified, ...payload });
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
  const initial = diffSinceBaseline(filePath, baseline, endWord, displayName, mentionTarget);
  if (initial.endViaWord) {
    return finish(EXIT.END, 'END', {
      source: 'end-word',
      endWord,
      ...(raw ? { newContent: initial.newLines.join('\n') } : {}),
    });
  }
  if (initial.woke) {
    return finish(EXIT.WAKE, initial.priority === 'urgent' ? 'URGENT_WAKE' : 'WAKE', {
      wakeLines: initial.wakeLines,
      ...(raw ? { newContent: initial.newLines.join('\n') } : {}),
      newRound: initial.hasNewRound,
      newHuman: initial.hasNewHuman,
      newFreeform: initial.hasNewFreeform,
      priority: initial.priority,
      immediate: true,
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

    const diff = diffSinceBaseline(filePath, baseline, endWord, displayName, mentionTarget);

    if (diff.endViaWord) {
      clearTimeout(timer);
      return finish(EXIT.END, 'END', { source: 'end-word', endWord });
    }

    if (diff.woke) {
      clearTimeout(timer);
      return finish(EXIT.WAKE, diff.priority === 'urgent' ? 'URGENT_WAKE' : 'WAKE', {
        wakeLines: diff.wakeLines,
        ...(raw ? { newContent: diff.newLines.join('\n') } : {}),
        newRound: diff.hasNewRound,
        newHuman: diff.hasNewHuman,
        newFreeform: diff.hasNewFreeform,
        priority: diff.priority,
      });
    }
  };

  watcher.on('add', check).on('change', check).on('unlink', check);
}

main().catch((e) => {
  process.stderr.write(`corrwait error: ${e.stack || e.message}\n`);
  process.exit(EXIT.ERROR);
});
