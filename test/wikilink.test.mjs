import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseLinks, classify, isActive, resolveLink } from '../lib/wikilink.mjs';

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
