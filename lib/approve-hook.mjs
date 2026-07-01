// SPEC_identity-verification §3: --as human-approval hook (soft gate).
//
// When an unverified identity (source !== 'envoak') is about to participate,
// give the owner a chance to veto via an external command before it does.
// Off by default (absent hook → allow) — this is a convenience the operator
// opts into, not a security boundary; --as keeps working for everyone per
// the spec's display-only stance.

import { spawnSync } from 'node:child_process';

// runHook({ file, agent, source }) -> { approved: boolean, hookRan: boolean, message? }
//
// TREEBIRD_CHAT_APPROVE_HOOK unset: default allow, no subprocess at all (hot
// path for every unverified corrwait/join in normal use).
//
// TREEBIRD_CHAT_APPROVE_HOOK set: run it as a shell command, feeding
// {file, agent, source} as JSON on stdin. Exit 0 → approve. Non-zero (or a
// spawn failure, e.g. the command doesn't exist) → refuse.
export function runApproveHook({ file, agent, source, spawn } = {}) {
  const hookCmd = process.env.TREEBIRD_CHAT_APPROVE_HOOK;
  if (!hookCmd) return { approved: true, hookRan: false };

  const exec = spawn || ((cmd, input) => spawnSync(cmd, { shell: true, input, encoding: 'utf8' }));
  let result;
  try {
    result = exec(hookCmd, JSON.stringify({ file, agent, source }) + '\n');
  } catch (e) {
    return { approved: false, hookRan: true, message: `approve hook failed to run: ${e.message}` };
  }
  if (result?.error) {
    return { approved: false, hookRan: true, message: `approve hook failed to run: ${result.error.message}` };
  }
  const approved = result?.status === 0;
  return {
    approved,
    hookRan: true,
    message: approved ? undefined : `approve hook "${hookCmd}" refused "${agent}" (exit ${result?.status})`,
  };
}
