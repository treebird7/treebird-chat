import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyAgentIdentity } from '../lib/identity.mjs';

// Precedence (2026-06): explicit --as > BIRDCHAT_AGENT > ENVOAK_AGENT_LABEL.
// An explicitly chosen chat handle (e.g. a colony-assigned `sherlock2`) must win
// over the agent's machine label — otherwise it gets overridden back to the base
// agent, which caused the concurrent-instance handle confusion.

function withEnv(env, fn) {
  const keys = ['ENVOAK_AGENT_LABEL', 'BIRDCHAT_AGENT', 'TREEBIRD_MACHINE'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, env);
  try { return fn(); }
  finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('explicit --as wins over BIRDCHAT_AGENT and ENVOAK_AGENT_LABEL', () => {
  withEnv({ ENVOAK_AGENT_LABEL: 'sherlocksan-m2', BIRDCHAT_AGENT: 'sherlock3' }, () => {
    const id = verifyAgentIdentity('sherlock2');
    assert.equal(id.agent, 'sherlock2');
    assert.equal(id.source, 'cli');
  });
});

test('BIRDCHAT_AGENT wins over ENVOAK_AGENT_LABEL when no --as', () => {
  withEnv({ ENVOAK_AGENT_LABEL: 'sherlocksan-m2', BIRDCHAT_AGENT: 'sherlock2' }, () => {
    const id = verifyAgentIdentity(null);
    assert.equal(id.agent, 'sherlock2');
    assert.equal(id.source, 'env');
  });
});

test('falls through to ENVOAK_AGENT_LABEL (machine stripped) when no override — unchanged default', () => {
  withEnv({ ENVOAK_AGENT_LABEL: 'sherlocksan-m2' }, () => {
    const id = verifyAgentIdentity(null);
    assert.equal(id.agent, 'sherlocksan');
    assert.equal(id.source, 'envoak');
  });
});

test('throws with no identity at all', () => {
  withEnv({}, () => {
    assert.throws(() => verifyAgentIdentity(null), /No identity/);
  });
});
