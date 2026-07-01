import test from 'node:test';
import assert from 'node:assert/strict';
import { requireEnvoakUnlock } from '../lib/envoak-gate.mjs';

function restoreGateEnv(t) {
  const previous = process.env.TREEBIRD_CHAT_REQUIRE_ENVOAK;
  t.after(() => {
    if (previous === undefined) delete process.env.TREEBIRD_CHAT_REQUIRE_ENVOAK;
    else process.env.TREEBIRD_CHAT_REQUIRE_ENVOAK = previous;
  });
}

function setGateEnv(value) {
  if (value === undefined) delete process.env.TREEBIRD_CHAT_REQUIRE_ENVOAK;
  else process.env.TREEBIRD_CHAT_REQUIRE_ENVOAK = value;
}

test('requireEnvoakUnlock does not call vault status when the gate is off', async (t) => {
  restoreGateEnv(t);
  for (const value of [undefined, '0', 'false']) {
    setGateEnv(value);
    let calls = 0;
    const result = await requireEnvoakUnlock({
      runVaultStatus: () => {
        calls += 1;
        throw new Error('must not run');
      },
    });

    assert.deepEqual(result, { ok: true });
    assert.equal(calls, 0, `vault status should not run for ${String(value)}`);
  }
});

test('requireEnvoakUnlock allows exit-0 vault status when the gate is on', async (t) => {
  restoreGateEnv(t);
  setGateEnv('1');
  let calls = 0;
  const result = await requireEnvoakUnlock({
    runVaultStatus: () => {
      calls += 1;
      return 'Logged in\nVault unlocked\n';
    },
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 1);
});

test('requireEnvoakUnlock treats thrown vault status as locked or unavailable', async (t) => {
  restoreGateEnv(t);
  setGateEnv('true');
  const result = await requireEnvoakUnlock({
    action: 'treebird-chat-allow',
    runVaultStatus: () => {
      throw new Error('envoak exited 1');
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /treebird-chat-allow/);
  assert.match(result.message, /envoak vault unlock/);
});

test('requireEnvoakUnlock treats known lock signatures as locked', async (t) => {
  restoreGateEnv(t);
  setGateEnv('TRUE');
  const result = await requireEnvoakUnlock({
    runVaultStatus: () => 'needs_reauth\n',
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /envoak vault unlock/);
});
