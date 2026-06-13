// Atomic flat-format append for treebird-chat files.
//
// Uses an O_EXCL lock file (<chatfile>.lock) to serialize concurrent writers
// across all processes on the local machine. Each write is a single write()
// syscall so it is also safe for short messages on its own, but the lock
// ensures multi-line replies (word-wrapped bridge responses) land contiguously.

import { closeSync, constants, openSync, readFileSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';

function nowHHMM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// Local-time date (YYYY-MM-DD) to match nowHHMM()'s local clock, so the
// day-separator aligns with the HH:MM stamps actually written into the file.
function todayYMD() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Day-separator: emit a `--- YYYY-MM-DD ---` divider the first time content is
// written on a new calendar day, so a long log is visually grouped by day
// without paying the ~26KB cost of a per-line date (CLAUDE.md format note).
//
// The last-stamped day lives in a `<file>.day` sidecar (same pattern as
// `.cursor.<agent>` / `.access.json`). We only emit on an observed *transition*
// — the very first write to a file (no sidecar yet) just initialises the stamp
// with no divider, so there is no stray separator above the first message.
// Must be called inside the writer lock to stay race-free with concurrent
// writers. `DAY_SEPARATOR_RE` in lib/watcher.mjs matches this exact shape so the
// divider never wakes corrwait.
function daySeparatorPrefix(filePath) {
  const dayPath = `${filePath}.day`;
  const today = todayYMD();
  let prevDay = null;
  try { prevDay = readFileSync(dayPath, 'utf8').trim() || null; } catch { /* no stamp yet */ }
  if (prevDay === today) return '';
  try { writeFileSync(dayPath, today + '\n', { mode: 0o600 }); }
  catch { /* best effort — a missing stamp just re-evaluates next write */ }
  return prevDay ? `--- ${today} ---\n` : '';
}

async function acquireLock(lockPath) {
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      return openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (Date.now() >= deadline) throw new Error(`lock timeout: ${lockPath}`);
      // Recover stale lock left by a crashed process (> 3 s old). Threshold
      // must be less than the 5 s deadline so recovery is reachable before
      // the caller gives up.
      try {
        const { mtimeMs } = statSync(lockPath);
        if (Date.now() - mtimeMs > 3_000) unlinkSync(lockPath);
      } catch { /* lock may have been released between EEXIST check and statSync */ }
      await new Promise(r => setTimeout(r, 50));
    }
  }
}

/**
 * Atomically append one or more flat-format lines to a treebird-chat file.
 *
 * Each element of `lines` is written as `[HH:MM agent] line\n`.
 * All lines land as a single contiguous write under the lock.
 *
 * @param {string} filePath  - Path to the chat file
 * @param {string} agent     - Agent name (used as author)
 * @param {string[]} lines   - Message lines to append (one per flat line)
 */
// Per-line cap. Two reasons: (a) atomic O_APPEND writes are only guaranteed
// contiguous up to PIPE_BUF (4096 on macOS, 8192 on Linux) — beyond that,
// concurrent writers can interleave; (b) defense against a caller that
// floods the chat with a multi-MB string.
// Was silently truncated with " […truncated]" — now throws MessageTooLongError
// so callers can surface a clear "split into shorter posts" message to the
// author instead of dropping bytes invisibly.
export const MAX_LINE_LEN = 4000;

export class MessageTooLongError extends Error {
  constructor({ lineIndex, length, limit }) {
    super(`message line ${lineIndex} is ${length} chars, limit is ${limit}`);
    this.name = 'MessageTooLongError';
    this.code = 'MESSAGE_TOO_LONG';
    this.lineIndex = lineIndex;
    this.length = length;
    this.limit = limit;
  }
}

export async function appendLines(filePath, agent, lines) {
  const safeAgent = agent.replace(/[\r\n]/g, '');
  const t = nowHHMM();
  // Strip embedded newlines from each `line` — without this, a caller passing
  // `"line1\nline2"` would produce a malformed flat-format entry: only the
  // first line gets the `[HH:MM agent]` prefix, continuation lines fail
  // FLAT_RE and become invisible to the watcher's cursor logic. Per the
  // CLAUDE.md "one prefix per line" convention, callers should pass an array
  // of single-line strings — but enforce it defensively. (Rubber-duck #4.)
  const safeLines = lines.map((l, i) => {
    const collapsed = String(l).replace(/[\r\n]+/g, ' ');
    if (collapsed.length > MAX_LINE_LEN) {
      throw new MessageTooLongError({ lineIndex: i, length: collapsed.length, limit: MAX_LINE_LEN });
    }
    return collapsed;
  });
  const out = safeLines.map(l => `[${t} ${safeAgent}] ${l}`).join('\n') + '\n';
  const lockPath = `${filePath}.lock`;
  let lockFd = null;
  let fileFd = null;
  try {
    lockFd = await acquireLock(lockPath);
    // Day-separator decided under the lock so two same-day writers can't both
    // emit a divider (the sidecar stamp advances atomically with the write).
    const sep = daySeparatorPrefix(filePath);
    fileFd = openSync(filePath, constants.O_WRONLY | constants.O_APPEND);
    writeSync(fileFd, sep + out);
  } finally {
    if (fileFd !== null) try { closeSync(fileFd); } catch { /* best effort */ }
    if (lockFd !== null) {
      try { closeSync(lockFd); } catch { /* best effort */ }
      try { unlinkSync(lockPath); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
  }
}

/**
 * Atomically append a single flat-format line.
 * Convenience wrapper around appendLines for one-liners.
 */
export async function appendLine(filePath, agent, message) {
  return appendLines(filePath, agent, [message]);
}
