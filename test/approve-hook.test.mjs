import test from 'node:test';
import assert from 'node:assert/strict';
import { runApproveHook } from '../lib/approve-hook.mjs';

function restoreHookEnv(t) {
  const previous = process.env.TREEBIRD_CHAT_APPROVE_HOOK;
  t.after(() => {
    if (previous === undefined) delete process.env.TREEBIRD_CHAT_APPROVE_HOOK;
    else process.env.TREEBIRD_CHAT_APPROVE_HOOK = previous;
  });
}

test('runApproveHook default-allows with no subprocess when the hook is unset', (t) => {
  restoreHookEnv(t);
  delete process.env.TREEBIRD_CHAT_APPROVE_HOOK;
  let calls = 0;
  const result = runApproveHook({
    file: '/tmp/chat.md',
    agent: 'cc2',
    source: 'cli',
    spawn: () => { calls += 1; throw new Error('must not run'); },
  });
  assert.deepEqual(result, { approved: true, hookRan: false });
  assert.equal(calls, 0);
});

test('runApproveHook approves on exit 0 and feeds {file, agent, source} as JSON stdin', (t) => {
  restoreHookEnv(t);
  process.env.TREEBIRD_CHAT_APPROVE_HOOK = 'fake-approver';
  let seenCmd = null, seenInput = null;
  const result = runApproveHook({
    file: '/tmp/chat.md',
    agent: 'cc2',
    source: 'cli',
    spawn: (cmd, input) => { seenCmd = cmd; seenInput = input; return { status: 0 }; },
  });
  assert.equal(result.approved, true);
  assert.equal(result.hookRan, true);
  assert.equal(seenCmd, 'fake-approver');
  assert.deepEqual(JSON.parse(seenInput), { file: '/tmp/chat.md', agent: 'cc2', source: 'cli' });
});

test('runApproveHook refuses on non-zero exit', (t) => {
  restoreHookEnv(t);
  process.env.TREEBIRD_CHAT_APPROVE_HOOK = 'fake-approver';
  const result = runApproveHook({
    file: '/tmp/chat.md', agent: 'cc2', source: 'cli',
    spawn: () => ({ status: 1 }),
  });
  assert.equal(result.approved, false);
  assert.match(result.message, /refused "cc2"/);
});

test('runApproveHook refuses when the command fails to spawn', (t) => {
  restoreHookEnv(t);
  process.env.TREEBIRD_CHAT_APPROVE_HOOK = 'does-not-exist';
  const result = runApproveHook({
    file: '/tmp/chat.md', agent: 'cc2', source: 'cli',
    spawn: () => { throw new Error('ENOENT'); },
  });
  assert.equal(result.approved, false);
  assert.match(result.message, /failed to run/);
});
