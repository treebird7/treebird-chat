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
  // Vault-probe-failure path. We inject a namespace/key combo guaranteed
  // not to exist so this stays robust whether envoak is broken, missing,
  // or healthy-but-empty. Without injection, the test would have been
  // dependent on the real vault not happening to hold the production key.
  const r = resolveSmalltoakUrl({
    env: { ENVOAK_AGENT_LABEL: 'test-agent' },
    namespace: '__test-namespace-that-does-not-exist__',
    key: '__test-key-that-does-not-exist__',
  });
  assert.equal(r.url, null);
  assert.equal(r.source, null);
});

test('loopback env on an envoak box is skipped (stale-local-env guard)', () => {
  // The 2026-06-13 failure: m2's stale SMALLTOAK_SERVER_URL=localhost:3000
  // silently beat the vault canonical URL. On an envoak box a loopback URL is
  // almost always wrong for a cross-machine server — fall through to vault.
  // No real vault entry here, so it lands in null/null (not the stale env).
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    const r = resolveSmalltoakUrl({
      env: { SMALLTOAK_SERVER_URL: `http://${host}:3000`, ENVOAK_AGENT_LABEL: 'test-agent' },
      namespace: '__test-namespace-that-does-not-exist__',
      key: '__test-key-that-does-not-exist__',
    });
    assert.equal(r.source, null, `loopback host ${host} must not win as env`);
    assert.equal(r.url, null);
  }
});

test('loopback env WITHOUT envoak still wins (vanilla local dev untouched)', () => {
  // No ENVOAK_AGENT_LABEL → no vault to prefer, so localhost is the user's
  // deliberate choice and must pass through.
  const r = resolveSmalltoakUrl({ env: { SMALLTOAK_SERVER_URL: 'http://localhost:3000' } });
  assert.equal(r.source, 'env');
  assert.equal(r.url, 'http://localhost:3000');
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
