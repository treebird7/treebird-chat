// Tests for lib/identity.mjs — label parsing, verification status, and the
// non-throwing resolveIdentity helper.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLabel, verifyAgentIdentity, resolveIdentity } from '../lib/identity.mjs';

// Run `fn` with a clean identity env, restoring whatever was there after.
function withEnv(vars, fn) {
  const keys = ['ENVOAK_AGENT_LABEL', 'BIRDCHAT_AGENT', 'TREEBIRD_MACHINE'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, vars);
  try { return fn(); }
  finally {
    for (const k of keys) delete process.env[k];
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
  }
}

test('parseLabel — <agent>-<machine>', () => {
  assert.deepEqual(parseLabel('sasusan-m5'), { agent: 'sasusan', machine: 'm5', instance: null });
});

test('parseLabel — <agent>-<machine>-<instance>', () => {
  assert.deepEqual(parseLabel('sherlock-m2-2'), { agent: 'sherlock', machine: 'm2', instance: 2 });
});

test('parseLabel — hyphenated agent name keeps its hyphen', () => {
  assert.deepEqual(parseLabel('ibn-yosef-m5'), { agent: 'ibn-yosef', machine: 'm5', instance: null });
  assert.deepEqual(parseLabel('ibn-yosef-m5-3'), { agent: 'ibn-yosef', machine: 'm5', instance: 3 });
});

test('parseLabel — digit-suffixed bare name is NOT an instance', () => {
  // cc2 has no machine/instance — the trailing digit is part of the name.
  assert.deepEqual(parseLabel('cc2'), { agent: 'cc2', machine: null, instance: null });
});

test('verifyAgentIdentity — envoak label is verified', () => {
  withEnv({ ENVOAK_AGENT_LABEL: 'sasusan-m5' }, () => {
    const id = verifyAgentIdentity('cc2');
    assert.equal(id.agent, 'sasusan');
    assert.equal(id.machine, 'm5');
    assert.equal(id.source, 'envoak');
    assert.equal(id.verified, true);
  });
});

test('verifyAgentIdentity — env label wins over --as and is unverified', () => {
  withEnv({ BIRDCHAT_AGENT: 'cc2' }, () => {
    const id = verifyAgentIdentity('sasusan');
    assert.equal(id.agent, 'cc2');
    assert.equal(id.source, 'env');
    assert.equal(id.verified, false);
  });
});

test('verifyAgentIdentity — --as fallback is unverified', () => {
  withEnv({}, () => {
    const id = verifyAgentIdentity('cc2');
    assert.equal(id.agent, 'cc2');
    assert.equal(id.source, 'cli');
    assert.equal(id.verified, false);
  });
});

test('verifyAgentIdentity — multi-instance --as parses instance', () => {
  withEnv({}, () => {
    const id = verifyAgentIdentity('sherlock-m2-2');
    assert.equal(id.agent, 'sherlock');
    assert.equal(id.machine, 'm2');
    assert.equal(id.instance, 2);
    assert.equal(id.verified, false);
  });
});

test('resolveIdentity — returns null when no identity set', () => {
  withEnv({}, () => {
    assert.equal(resolveIdentity(), null);
  });
});

test('resolveIdentity — returns identity when --as fallback given', () => {
  withEnv({}, () => {
    assert.equal(resolveIdentity('cc2')?.agent, 'cc2');
  });
});
