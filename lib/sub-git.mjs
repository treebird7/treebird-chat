// Auto-stage a freshly created sub-chat file + its .access.json sidecar.
//
// Closes the git half of issue #6 P2.1. The 10:21–10:23 nightjar event lived
// the gap: /sub created a sub locally, the human pinged @yosef @mappersan
// inside it, and neither could see the ping because the sub file wasn't on
// their machines and no bridge was relaying it. Auto-staging is the smallest
// move that closes the file-distribution half: peer machines pull the file on
// their next git sync.
//
// Triage decision (sherlocksan, issue #6 thread): stage only — no `git
// commit`, no `git push`. The TUI command must not mutate the user's git
// state beyond the index; commit + push are explicit user actions. Anyone
// wanting full auto-distribution can chain `/sub topic && git commit && git
// push` in their shell.

import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

// Run a git command synchronously in a given directory. Returns trimmed
// stdout on success, throws on non-zero exit. We use execFileSync (not exec)
// so arguments never pass through a shell — no quoting bugs, no injection.
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

// Detect whether `file`'s directory is inside a git worktree. We delegate to
// git itself (`rev-parse --is-inside-work-tree`) rather than walking for a
// `.git` directory — handles worktrees, submodules, and bare-clone edge
// cases correctly.
export function isInGitRepo(file) {
  const dir = existsSync(file) ? (isDir(file) ? file : dirname(file)) : dirname(file);
  try {
    return git(dir, 'rev-parse', '--is-inside-work-tree') === 'true';
  } catch {
    return false;
  }
}

function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

// Stage the sub file + its .access.json sidecar in the git index. No-op (with
// a returned reason) when the sub file isn't in a git repo or git is
// unavailable. Returns { staged: boolean, files?: string[], reason?: string }.
//
// Idempotent — `git add` on an already-staged file is a no-op.
export function autoStageSub(subFile) {
  if (!existsSync(subFile)) {
    return { staged: false, reason: 'sub file does not exist' };
  }
  const aclFile = `${subFile}.access.json`;
  const dir = dirname(subFile);

  if (!isInGitRepo(subFile)) {
    return { staged: false, reason: 'sub file is not in a git repo — peer machines must sync via another channel' };
  }

  // Stage what we can. Add the ACL only if it exists (subs can be created
  // without one in edge cases).
  const toStage = [subFile, ...(existsSync(aclFile) ? [aclFile] : [])];
  try {
    git(dir, 'add', '--', ...toStage);
    return { staged: true, files: toStage };
  } catch (e) {
    // Stage failures are unusual (gitignored file? worktree corruption?). We
    // don't want to crash the TUI on a best-effort housekeeping step.
    return { staged: false, reason: `git add failed: ${e.message.split('\n')[0]}` };
  }
}
