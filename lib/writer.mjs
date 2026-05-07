// Atomic flat-format append for treebird-chat files.
//
// Uses an O_EXCL lock file (<chatfile>.lock) to serialize concurrent writers
// across all processes on the local machine. Each write is a single write()
// syscall so it is also safe for short messages on its own, but the lock
// ensures multi-line replies (word-wrapped bridge responses) land contiguously.

import { closeSync, constants, openSync, unlinkSync, writeSync } from 'node:fs';

function nowHHMM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

async function acquireLock(lockPath) {
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      return openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (Date.now() >= deadline) throw new Error(`lock timeout: ${lockPath}`);
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
export async function appendLines(filePath, agent, lines) {
  const safeAgent = agent.replace(/[\r\n]/g, '');
  const t = nowHHMM();
  const out = lines.map(l => `[${t} ${safeAgent}] ${l}`).join('\n') + '\n';
  const lockPath = `${filePath}.lock`;
  let lockFd = null;
  let fileFd = null;
  try {
    lockFd = await acquireLock(lockPath);
    fileFd = openSync(filePath, constants.O_WRONLY | constants.O_APPEND);
    writeSync(fileFd, out);
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
