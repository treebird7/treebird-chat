import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { autoStageSub, isInGitRepo } from '../lib/sub-git.mjs';

// Each test gets a fresh temp git repo to avoid cross-test contamination.
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sub-git-test-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  // CI-safe identity so commits would succeed (we don't commit, but git checks
  // for one on some operations).
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  return dir;
}

test('isInGitRepo returns true for a path inside a git worktree', () => {
  const repo = makeRepo();
  try {
    const f = join(repo, 'foo.md');
    writeFileSync(f, '# foo\n');
    assert.equal(isInGitRepo(f), true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('isInGitRepo returns false for a path outside any git repo', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'nogit-'));
  try {
    const f = join(tmp, 'foo.md');
    writeFileSync(f, 'plain\n');
    assert.equal(isInGitRepo(f), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('autoStageSub stages the sub file + its .access.json', () => {
  const repo = makeRepo();
  try {
    const sub = join(repo, 'sub_demo.md');
    const acl = `${sub}.access.json`;
    writeFileSync(sub, '<!-- sub -->\n');
    writeFileSync(acl, '{"owner":"x","agents":{}}\n');

    const r = autoStageSub(sub);
    assert.equal(r.staged, true);
    assert.equal(r.files.length, 2);

    // Verify the files are in the git index.
    const staged = execFileSync('git', ['diff', '--cached', '--name-only'], {
      cwd: repo, encoding: 'utf8',
    }).trim().split('\n').sort();
    assert.deepEqual(staged, ['sub_demo.md', 'sub_demo.md.access.json'].sort());
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('autoStageSub stages just the sub file when no ACL exists', () => {
  const repo = makeRepo();
  try {
    const sub = join(repo, 'sub_demo.md');
    writeFileSync(sub, '<!-- sub -->\n');
    // no .access.json

    const r = autoStageSub(sub);
    assert.equal(r.staged, true);
    assert.equal(r.files.length, 1);
    assert.equal(r.files[0], sub);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('autoStageSub is a no-op outside a git repo, returns a clear reason', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'nogit-'));
  try {
    const sub = join(tmp, 'sub_demo.md');
    writeFileSync(sub, '<!-- sub -->\n');

    const r = autoStageSub(sub);
    assert.equal(r.staged, false);
    assert.match(r.reason, /not in a git repo/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('autoStageSub returns a clear reason when the sub file is missing', () => {
  const repo = makeRepo();
  try {
    const r = autoStageSub(join(repo, 'does-not-exist.md'));
    assert.equal(r.staged, false);
    assert.match(r.reason, /does not exist/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('autoStageSub is idempotent on already-staged files', () => {
  const repo = makeRepo();
  try {
    const sub = join(repo, 'sub_demo.md');
    writeFileSync(sub, 'x\n');

    const r1 = autoStageSub(sub);
    const r2 = autoStageSub(sub);
    assert.equal(r1.staged, true);
    assert.equal(r2.staged, true); // no error on second add
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
