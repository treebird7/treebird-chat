// Tests for the first-run-setup config helpers added 2026-06-07:
// SMALLTOAK_URL resolution, ~/.treebird-chat/.env upsert, and the git
// dual-sync detector.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveSmalltoakUrl, upsertUserEnv, userEnvPath, gitRepoRootFor } from '../lib/config.mjs';

// ── resolveSmalltoakUrl — SMALLTOAK_URL canonical, SERVER_URL back-compat ──

test('resolveSmalltoakUrl — SMALLTOAK_URL is honored', () => {
  const r = resolveSmalltoakUrl({ env: { SMALLTOAK_URL: 'http://relay:3000' } });
  assert.equal(r.url, 'http://relay:3000');
  assert.equal(r.source, 'env');
});

test('resolveSmalltoakUrl — SMALLTOAK_SERVER_URL still works (back-compat)', () => {
  const r = resolveSmalltoakUrl({ env: { SMALLTOAK_SERVER_URL: 'http://old:3000' } });
  assert.equal(r.url, 'http://old:3000');
});

test('resolveSmalltoakUrl — SMALLTOAK_URL beats SMALLTOAK_SERVER_URL', () => {
  const r = resolveSmalltoakUrl({ env: { SMALLTOAK_URL: 'http://new:3000', SMALLTOAK_SERVER_URL: 'http://old:3000' } });
  assert.equal(r.url, 'http://new:3000');
});

test('resolveSmalltoakUrl — none set, no envoak → null', () => {
  const r = resolveSmalltoakUrl({ env: {} });
  assert.equal(r.url, null);
  assert.equal(r.source, null);
});

// ── upsertUserEnv — order-preserving, 0600, overwrite control ──

function withHome(fn) {
  const saved = process.env.HOME;
  const dir = mkdtempSync(join(tmpdir(), 'tbc-home-'));
  process.env.HOME = dir;
  try { return fn(dir); }
  finally {
    process.env.HOME = saved;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('upsertUserEnv — writes keys, 0600, into ~/.treebird-chat/.env', () => {
  withHome(() => {
    const { path, written } = upsertUserEnv({ SMALLTOAK_URL: 'http://r:3000', SMALLTOAK_TOKEN: 'tok' });
    assert.equal(path, userEnvPath());
    assert.deepEqual(written.sort(), ['SMALLTOAK_TOKEN', 'SMALLTOAK_URL']);
    const content = readFileSync(path, 'utf8');
    assert.match(content, /^SMALLTOAK_URL=http:\/\/r:3000$/m);
    assert.match(content, /^SMALLTOAK_TOKEN=tok$/m);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  });
});

test('upsertUserEnv — preserves comments + unrelated keys, updates in place', () => {
  withHome(() => {
    const path = userEnvPath();
    mkdirSync(join(process.env.HOME, '.treebird-chat'), { recursive: true });
    writeFileSync(path, '# my config\nOTHER_KEY=keep\nSMALLTOAK_TOKEN=old\n');
    upsertUserEnv({ SMALLTOAK_TOKEN: 'new', SMALLTOAK_URL: 'http://r:3000' });
    const content = readFileSync(path, 'utf8');
    assert.match(content, /^# my config$/m);       // comment kept
    assert.match(content, /^OTHER_KEY=keep$/m);     // unrelated key kept
    assert.match(content, /^SMALLTOAK_TOKEN=new$/m); // updated in place
    assert.match(content, /^SMALLTOAK_URL=http:\/\/r:3000$/m); // appended
  });
});

test('upsertUserEnv — overwrite:false keeps the existing value', () => {
  withHome(() => {
    const path = userEnvPath();
    mkdirSync(join(process.env.HOME, '.treebird-chat'), { recursive: true });
    writeFileSync(path, 'SMALLTOAK_TOKEN=keepme\n');
    const { skipped } = upsertUserEnv({ SMALLTOAK_TOKEN: 'nope' }, { overwrite: false });
    assert.deepEqual(skipped, ['SMALLTOAK_TOKEN']);
    assert.match(readFileSync(path, 'utf8'), /^SMALLTOAK_TOKEN=keepme$/m);
  });
});

test('upsertUserEnv — strips CR/LF from values (no .env line injection)', () => {
  withHome(() => {
    // A value carrying a newline must NOT become two .env lines.
    const { path } = upsertUserEnv({ SMALLTOAK_TOKEN: 'tok\nINJECTED=1', SMALLTOAK_URL: 'http://r:3000\r\n' });
    const content = readFileSync(path, 'utf8');
    assert.doesNotMatch(content, /^INJECTED=1$/m);          // injection neutralised
    assert.match(content, /^SMALLTOAK_TOKEN=tokINJECTED=1$/m); // newline stripped, value joined
    assert.match(content, /^SMALLTOAK_URL=http:\/\/r:3000$/m); // trailing CRLF stripped
    // No stray line: exactly the two keys + trailing newline.
    assert.equal(content.trim().split('\n').length, 2);
  });
});

// ── gitRepoRootFor — dual-sync detector ──

test('gitRepoRootFor — finds the repo root for a file inside a git work tree', () => {
  const root = mkdtempSync(join(tmpdir(), 'tbc-git-'));
  try {
    mkdirSync(join(root, '.git'));
    mkdirSync(join(root, 'sub'));
    const f = join(root, 'sub', 'chat.md');
    writeFileSync(f, '');
    // fs.realpath collapses /tmp symlink on macOS; compare basenames to avoid that.
    assert.ok(gitRepoRootFor(f)?.endsWith(root.split('/').pop()));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('gitRepoRootFor — null when no .git ancestor', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tbc-nogit-'));
  try {
    const f = join(dir, 'chat.md');
    writeFileSync(f, '');
    assert.equal(gitRepoRootFor(f), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
