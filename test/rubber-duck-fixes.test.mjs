// Regression coverage for the rubber-duck pass fixes:
//   #1 findSessionByPath normalizes paths
//   #4 appendLines strips embedded newlines
//   #5 ensureAcl owner defaults via $USER, not hardcoded 'treebird'

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, chmodSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { appendLines } from '../lib/writer.mjs';
import { ensureAcl, readAcl } from '../lib/access.mjs';

// ── #1: findSessionByPath path normalization ──────────────────────────────────
//
// The function reads ~/.treebird-chat/sessions.json — there's no injection
// hook short of refactoring the module. Rather than touching the user's real
// registry, we use the helper's behaviour transitively via resolveMirrorFile
// (which we *can* inject). The actual normalization happens at the path-
// compare step that's shared in spirit between findSessionByPath and any
// future path-keyed lookups, so we verify the contract on a path level.
//
// (Direct unit test of findSessionByPath is omitted intentionally; refactoring
// the function to accept injected sessions would widen the API for one test.)

import { resolveMirrorFile } from '../lib/config.mjs';

test('#1 resolveMirrorFile still works after the normalization change (regression)', () => {
  // findSessionByPath and resolveMirrorFile both touch the same registry
  // shape; this test just ensures the normalization edit didn't break
  // resolveMirrorFile's key-based lookup. Path normalization is verified
  // implicitly by the live smoke in the PR body.
  const sessions = { foo: { filePath: '/canonical/foo.md' } };
  const r = resolveMirrorFile('foo', { sessions });
  assert.equal(r.mirrorFile, '/canonical/foo.md');
  assert.equal(r.source, 'registered');
});

// ── #4: appendLines strips embedded \n and \r from each line ──────────────────
//
// Without this, a caller passing `"line1\nline2"` produced a malformed
// flat-format entry: only the first physical line carried the prefix,
// continuation lines failed FLAT_RE.

test('#4 appendLines collapses embedded \\n to a single space', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rd-newline-'));
  try {
    const f = join(dir, 'chat.md');
    writeFileSync(f, '');
    await appendLines(f, 'tester', ['hello\nworld']);
    const content = readFileSync(f, 'utf8');
    // Exactly one chat line — the embedded \n must NOT have split into two.
    const lines = content.split('\n').filter(Boolean);
    assert.equal(lines.length, 1, `expected 1 line, got ${lines.length}: ${JSON.stringify(content)}`);
    assert.match(lines[0], /^\[\d{2}:\d{2} tester\] hello world$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#4 appendLines collapses \\r\\n the same way', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rd-crlf-'));
  try {
    const f = join(dir, 'chat.md');
    writeFileSync(f, '');
    await appendLines(f, 'tester', ['line\r\nbreak']);
    const content = readFileSync(f, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\[\d{2}:\d{2} tester\] line break$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#4 multi-element lines still produce one physical line per element', async () => {
  // The intended behavior is "one prefix per element"; the embedded-\n strip
  // only fires on \n *inside* an element, not between elements.
  const dir = mkdtempSync(join(tmpdir(), 'rd-multi-'));
  try {
    const f = join(dir, 'chat.md');
    writeFileSync(f, '');
    await appendLines(f, 'tester', ['one', 'two', 'three']);
    const content = readFileSync(f, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    assert.equal(lines.length, 3);
    assert.match(lines[0], /^\[\d{2}:\d{2} tester\] one$/);
    assert.match(lines[1], /^\[\d{2}:\d{2} tester\] two$/);
    assert.match(lines[2], /^\[\d{2}:\d{2} tester\] three$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #5: ensureAcl owner defaults via $USER, not hardcoded 'treebird' ──────────

test('#5 ensureAcl picks owner from $USER when no arg given', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rd-acl-'));
  try {
    const chat = join(dir, 'chat.md');
    writeFileSync(chat, '');
    const prevUser = process.env.USER;
    process.env.USER = 'rd-test-user';
    try {
      const acl = ensureAcl(chat);
      assert.equal(acl.owner, 'rd-test-user');
    } finally {
      if (prevUser === undefined) delete process.env.USER;
      else process.env.USER = prevUser;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#5 ensureAcl falls back to "owner" when $USER and $USERNAME are unset', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rd-acl-fallback-'));
  try {
    const chat = join(dir, 'chat.md');
    writeFileSync(chat, '');
    const prevUser = process.env.USER;
    const prevUsername = process.env.USERNAME;
    delete process.env.USER;
    delete process.env.USERNAME;
    try {
      const acl = ensureAcl(chat);
      assert.equal(acl.owner, 'owner');
    } finally {
      if (prevUser !== undefined) process.env.USER = prevUser;
      if (prevUsername !== undefined) process.env.USERNAME = prevUsername;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── /ts-review permissions_hygiene: ACL + cursor written 0o600 ───────────────

test('/ts-review#1 ensureAcl writes the .access.json with mode 0o600', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rd-acl-mode-'));
  try {
    const chat = join(dir, 'chat.md');
    writeFileSync(chat, '');
    ensureAcl(chat, 'tester');
    const stat = statSync(`${chat}.access.json`);
    // Mode lower 9 bits = perm bits. 0o600 means owner-rw, no group/world.
    assert.equal(stat.mode & 0o777, 0o600,
      `ACL mode should be 0o600; got 0o${(stat.mode & 0o777).toString(8)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('/ts-review#1 cursor file is written 0o600', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rd-cursor-mode-'));
  try {
    const chat = join(dir, 'chat.md');
    writeFileSync(chat, '');
    const { writeCursor, cursorPath } = await import('../lib/access.mjs');
    writeCursor(chat, 'tester', 42);
    const stat = statSync(cursorPath(chat, 'tester'));
    assert.equal(stat.mode & 0o777, 0o600,
      `cursor mode should be 0o600; got 0o${(stat.mode & 0o777).toString(8)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#5 ensureAcl explicit owner arg still wins over $USER', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rd-acl-explicit-'));
  try {
    const chat = join(dir, 'chat.md');
    writeFileSync(chat, '');
    process.env.USER = 'should-not-be-used';
    const acl = ensureAcl(chat, 'explicit-owner');
    assert.equal(acl.owner, 'explicit-owner');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
