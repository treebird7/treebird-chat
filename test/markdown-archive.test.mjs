import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMarkdownArchive } from '../lib/markdown-archive.mjs';

function withTempFile(initial, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'treebird-archive-'));
  const file = join(dir, 'chat.md');
  writeFileSync(file, initial);
  return Promise.resolve(fn(file)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test('appendLine returns the line number of a distinct appended line', async () => {
  await withTempFile('[10:00 a] one\n[10:01 b] two\n', async (file) => {
    const archive = createMarkdownArchive();
    const lineNo = await archive.appendLine(file, '[10:02 c] three');
    assert.equal(lineNo, 3);
  });
});

test('appendLine resolves to the NEW line when identical content already exists', async () => {
  // Contract: when the file already holds an identical line, appendLine must
  // return the number of the copy it just wrote, not the pre-existing one.
  await withTempFile('[14:02 treesan] joined\n', async (file) => {
    const archive = createMarkdownArchive();
    const lineNo = await archive.appendLine(file, '[14:02 treesan] joined');
    assert.equal(lineNo, 2, 'must point at the appended copy, not the existing one');
  });
});

test('appendLine returns distinct ascending numbers for repeated identical content', async () => {
  await withTempFile('', async (file) => {
    const archive = createMarkdownArchive();
    const dup = '[14:02 treesan] joined';
    const a = await archive.appendLine(file, dup);
    const b = await archive.appendLine(file, dup);
    const c = await archive.appendLine(file, dup);
    assert.deepEqual([a, b, c], [1, 2, 3]);
    assert.equal(readFileSync(file, 'utf8').split('\n').filter(Boolean).length, 3);
  });
});
