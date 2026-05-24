import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSmalltoakUrl } from '../lib/config.mjs';

// resolveSmalltoakUrl resolution order:
//   1. env SMALLTOAK_SERVER_URL (works for any user)
//   2. envoak vault (only when ENVOAK_AGENT_LABEL is set — opt-in path)
//   3. null
//
// We test (1) and (3) directly by injecting `env`. The vault-hit branch
// requires a live envoak binary + vault entry, which we don't reproduce in
// tests — its absence falls cleanly into (3).

test('env hit: SMALLTOAK_SERVER_URL takes priority', () => {
  const r = resolveSmalltoakUrl({ env: { SMALLTOAK_SERVER_URL: 'http://192.168.100.1:3000' } });
  assert.equal(r.source, 'env');
  assert.equal(r.url, 'http://192.168.100.1:3000');
});

test('env hit beats envoak: even with ENVOAK_AGENT_LABEL, env wins', () => {
  const r = resolveSmalltoakUrl({
    env: {
      SMALLTOAK_SERVER_URL: 'http://from-env:3000',
      ENVOAK_AGENT_LABEL: 'test-agent',
    },
  });
  // env path returns first; vault probe never fires. The source identifies
  // which lookup succeeded — important for the wizard's `(from env)` /
  // `(from vault)` user-facing hint.
  assert.equal(r.source, 'env');
  assert.equal(r.url, 'http://from-env:3000');
});

test('no env, no envoak: returns null/null', () => {
  // No SMALLTOAK_SERVER_URL and no ENVOAK_AGENT_LABEL — vanilla user with
  // nothing configured yet. The wizard must prompt explicitly in this case.
  const r = resolveSmalltoakUrl({ env: {} });
  assert.equal(r.url, null);
  assert.equal(r.source, null);
});

test('no env, envoak present but vault entry missing: returns null', () => {
  // This exercises the vault-probe-failure path. Without a real envoak
  // binary on PATH, execFileSync throws; the function swallows and falls
  // through to null. (If envoak IS on the test runner's PATH but has no
  // entry, same outcome — the empty/non-URL stdout filters out.)
  const r = resolveSmalltoakUrl({ env: { ENVOAK_AGENT_LABEL: 'nonexistent-agent-for-test' } });
  assert.equal(r.url, null);
  assert.equal(r.source, null);
});

test('env URL containing https:// passes through unchanged', () => {
  // No URL parsing or rewriting — the resolver is a pure lookup. The TLS
  // path is the caller's concern (treebird-chat-bridge handles it via
  // smalltoak-pin.mjs).
  const r = resolveSmalltoakUrl({ env: { SMALLTOAK_SERVER_URL: 'https://smalltoak.example.com:443' } });
  assert.equal(r.url, 'https://smalltoak.example.com:443');
  assert.equal(r.source, 'env');
});

test('empty-string env var treated as missing (falls through)', () => {
  // A common .env-handling pitfall: `SMALLTOAK_SERVER_URL=` (no value)
  // becomes the empty string, not undefined. Our truthy check handles it.
  const r = resolveSmalltoakUrl({ env: { SMALLTOAK_SERVER_URL: '' } });
  assert.equal(r.url, null);
  assert.equal(r.source, null);
});
