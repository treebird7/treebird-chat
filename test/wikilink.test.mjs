import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { parseLinks, classify, isActive, resolveLink, isContained } from '../lib/wikilink.mjs';

// ── parseLinks ────────────────────────────────────────────────────────────────

describe('parseLinks', () => {
  it('extracts a plain link', () => {
    const links = parseLinks('see [[docs/adr/0001]] for details');
    assert.equal(links.length, 1);
    assert.equal(links[0].name, 'docs/adr/0001');
    assert.equal(links[0].prefix, null);
    assert.equal(links[0].anchor, null);
  });

  it('extracts anchor', () => {
    const links = parseLinks('[[docs/adr/0001#§5]]');
    assert.equal(links[0].anchor, '§5');
    assert.equal(links[0].name, 'docs/adr/0001');
  });

  it('extracts sub: prefix', () => {
    const links = parseLinks('[[sub:oauth-redirect]]');
    assert.equal(links[0].prefix, 'sub');
    assert.equal(links[0].name, 'oauth-redirect');
  });

  it('extracts task: prefix', () => {
    const links = parseLinks('[[task:P2.1]]');
    assert.equal(links[0].prefix, 'task');
    assert.equal(links[0].name, 'P2.1');
  });

  it('extracts mem: prefix', () => {
    const links = parseLinks('[[mem:artisan-p2-ownership]]');
    assert.equal(links[0].prefix, 'mem');
    assert.equal(links[0].name, 'artisan-p2-ownership');
  });

  it('extracts multiple links from one line', () => {
    const links = parseLinks('see [[adr/0001]] and [[task:P2.1]] and [[sub:auth]]');
    assert.equal(links.length, 3);
    assert.deepEqual(links.map(l => l.prefix), [null, 'task', 'sub']);
  });

  it('returns empty array for no links', () => {
    assert.deepEqual(parseLinks('no links here'), []);
  });
});

// ── classify ─────────────────────────────────────────────────────────────────

describe('classify', () => {
  const dir = join(tmpdir(), `wikilink-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });

  it('returns missing for non-existent file', () => {
    assert.equal(classify(join(dir, 'nope.md')), 'missing');
  });

  it('returns chat for file with protocol lines', () => {
    const f = join(dir, 'chat.md');
    writeFileSync(f, '[10:32 artisan] hello\n[10:33 mycsan] world\n');
    assert.equal(classify(f), 'chat');
  });

  it('returns doc for static markdown', () => {
    const f = join(dir, 'spec.md');
    writeFileSync(f, '# Spec\n\nThis is a specification document.\n');
    assert.equal(classify(f), 'doc');
  });

  // cleanup
  after(() => rmSync(dir, { recursive: true, force: true }));
});

// ── isActive ──────────────────────────────────────────────────────────────────

describe('isActive', () => {
  const dir = join(tmpdir(), `wikilink-active-${Date.now()}`);
  mkdirSync(dir, { recursive: true });

  it('returns false for file with no cursor sidecar', () => {
    const f = join(dir, 'chat.md');
    writeFileSync(f, '[10:00 artisan] hi\n');
    assert.equal(isActive(f), false);
  });

  it('returns true for file with recent bridge-cursor sidecar', () => {
    const f = join(dir, 'live.md');
    writeFileSync(f, '[10:00 artisan] hi\n');
    writeFileSync(`${f}.bridge-cursor.json`, JSON.stringify({
      chatId: 'test',
      updatedAt: new Date().toISOString(),
    }));
    assert.equal(isActive(f), true);
  });

  it('returns false for file with stale bridge-cursor', () => {
    const f = join(dir, 'stale.md');
    writeFileSync(f, '[10:00 artisan] hi\n');
    const stale = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
    writeFileSync(`${f}.bridge-cursor.json`, JSON.stringify({
      chatId: 'test',
      updatedAt: stale,
    }));
    assert.equal(isActive(f), false);
  });

  after(() => rmSync(dir, { recursive: true, force: true }));
});

// ── resolveLink ───────────────────────────────────────────────────────────────

describe('resolveLink', () => {
  const dir = join(tmpdir(), `wikilink-resolve-${Date.now()}`);
  mkdirSync(dir, { recursive: true });

  it('resolves a sibling doc file', () => {
    const spec = join(dir, 'spec.md');
    writeFileSync(spec, '# Spec\n');
    const from = join(dir, 'CONSORTIUM_2026-05-18.md');
    writeFileSync(from, '[10:00 artisan] hi\n');

    const result = resolveLink('spec', { from, workspaceRoots: [] });
    assert.equal(result.path, spec);
    assert.equal(result.type, 'doc');
    assert.equal(result.active, false);
  });

  it('resolves a sibling chat file', () => {
    const sub = join(dir, 'CONSORTIUM_2026-05-18_sub_auth_1000.md');
    writeFileSync(sub, '[10:00 artisan] sub start\n');
    const from = join(dir, 'CONSORTIUM_2026-05-18.md');

    const result = resolveLink('CONSORTIUM_2026-05-18_sub_auth_1000', { from, workspaceRoots: [] });
    assert.equal(result.path, sub);
    assert.equal(result.type, 'chat');
  });

  it('sub: finds existing sub file', () => {
    const sub = join(dir, 'CONSORTIUM_2026-05-18_sub_ratelimit_1200.md');
    writeFileSync(sub, '[10:00 artisan] sub\n');
    const from = join(dir, 'CONSORTIUM_2026-05-18.md');

    const result = resolveLink('sub:ratelimit', { from, workspaceRoots: [] });
    assert.equal(result.path, sub);
    assert.equal(result.type, 'sub');
    assert.equal(result.topic, 'ratelimit');
  });

  it('sub: returns proposed path when sub does not exist', () => {
    const from = join(dir, 'CONSORTIUM_2026-05-18.md');

    const result = resolveLink('sub:newtopic', { from, workspaceRoots: [] });
    assert.equal(result.proposed, true);
    assert.equal(result.type, 'sub');
    assert.ok(result.path.includes('newtopic'));
  });

  it('returns missing for unresolvable target', () => {
    const result = resolveLink('totally-nonexistent-file', { from: join(dir, 'x.md'), workspaceRoots: [] });
    assert.equal(result.type, 'missing');
    assert.equal(result.path, null);
  });

  it('preserves anchor', () => {
    const spec = join(dir, 'adr.md');
    writeFileSync(spec, '# ADR\n');
    const result = resolveLink('adr#§5', { from: join(dir, 'x.md'), workspaceRoots: [] });
    assert.equal(result.anchor, '§5');
  });

  after(() => rmSync(dir, { recursive: true, force: true }));
});

// ── isContained ───────────────────────────────────────────────────────────────

describe('isContained', () => {
  it('accepts a path equal to a root', () => {
    assert.equal(isContained('/a/b', ['/a/b']), true);
  });

  it('accepts a path inside a root', () => {
    assert.equal(isContained('/a/b/c.md', ['/a/b']), true);
  });

  it('accepts a path inside any of several roots', () => {
    assert.equal(isContained('/x/y/file.md', ['/a/b', '/x/y']), true);
  });

  it('rejects a path that escapes via ../', () => {
    // join('/a/b', '../secret') resolves to /a/secret — outside /a/b.
    assert.equal(isContained(join('/a/b', '../secret'), ['/a/b']), false);
  });

  it('rejects a path with a directory-prefix false match', () => {
    // /a/bc is not inside /a/b (must check the trailing separator).
    assert.equal(isContained('/a/bc/file.md', ['/a/b']), false);
  });

  it('rejects a path outside any root', () => {
    assert.equal(isContained('/etc/passwd', ['/a/b', '/x/y']), false);
  });
});

// ── resolveLink — path traversal ──────────────────────────────────────────────

describe('resolveLink — path traversal', () => {
  // Layout:
  //   <tmp>/wikilink-trav-<rand>/
  //     outside.md            ← escape target, NOT a workspace root
  //     inner/                ← the sole search dir (sibling of `from`)
  //       from.md             ← the file containing the link
  //       legit.md            ← a legit in-root link target
  const root = join(tmpdir(), `wikilink-trav-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  const inner = join(root, 'inner');
  mkdirSync(inner, { recursive: true });
  const outside = join(root, 'outside.md');
  const from = join(inner, 'from.md');
  const legit = join(inner, 'legit.md');
  writeFileSync(outside, '# secret outside\n');
  writeFileSync(from, '[10:00 artisan] hi\n');
  writeFileSync(legit, '# legit\n');

  it('plain [[legit]] resolves (positive control)', () => {
    const r = resolveLink('legit', { from, workspaceRoots: [] });
    assert.equal(r.path, legit);
    assert.equal(r.type, 'doc');
  });

  it('plain [[../outside]] does NOT escape sibling dir', () => {
    // Without the guard, join(inner, '../outside.md') = outside.md and existsSync passes.
    const r = resolveLink('../outside', { from, workspaceRoots: [] });
    assert.equal(r.path, null, 'traversal target must not resolve');
    assert.equal(r.type, 'missing');
  });

  it('plain [[../../etc/passwd]] does NOT escape', () => {
    const r = resolveLink('../../etc/passwd', { from, workspaceRoots: [] });
    assert.equal(r.path, null);
    assert.equal(r.type, 'missing');
  });

  it('plain [[../outside]] does NOT escape any of multiple workspace roots', () => {
    // Even with extra workspace roots, traversal still must not reach outside.md.
    const r = resolveLink('../outside', { from, workspaceRoots: [inner] });
    assert.equal(r.path, null);
    assert.equal(r.type, 'missing');
  });

  it('mem: slug containing ../ returns null path', () => {
    // resolveMem hardcodes memory roots under ~/.claude/projects; we can't easily
    // override them. But the guard runs unconditionally — any slug with ../ that
    // would escape to a real file path returns null. We test the structural
    // contract: traversal slug → path: null.
    const r = resolveLink('mem:../../../../../../../../tmp/anything', { from, workspaceRoots: [] });
    assert.equal(r.path, null);
    assert.equal(r.type, 'mem');
  });

  it('mem: slug with embedded ../ in middle returns null', () => {
    const r = resolveLink('mem:safe/../../escape', { from, workspaceRoots: [] });
    assert.equal(r.path, null);
    assert.equal(r.type, 'mem');
  });

  it('sub: topic with ../ is sanitised, cannot escape to parent dir', () => {
    // resolveSub replaces non-[A-Za-z0-9_-] with '-', so '../../etc/passwd' becomes
    // '------etc-passwd'. The proposed path lives inside dirname(from), never above.
    const r = resolveLink('sub:../../etc/passwd', { from, workspaceRoots: [] });
    assert.equal(r.type, 'sub');
    // Whether it returns a proposed path or a found match, the path must live
    // under `inner/` — never escape to `root/` or `/etc/`.
    if (r.path) {
      assert.ok(
        r.path.startsWith(inner + sep) || r.path === inner,
        `sub path must stay under ${inner}, got: ${r.path}`,
      );
      // And the sanitised topic must not contain any path separator characters.
      assert.ok(!r.path.includes('/etc/'), 'sanitised path must not contain raw /etc/');
    }
  });

  it('plain [[legit]] still works after traversal attempts (no global state pollution)', () => {
    const r = resolveLink('legit', { from, workspaceRoots: [] });
    assert.equal(r.path, legit);
  });

  after(() => rmSync(root, { recursive: true, force: true }));
});
