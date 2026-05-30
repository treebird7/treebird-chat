// Tests for the "notify, don't silently truncate" behavior introduced
// when the bridge encounters a too-long message — either at the local
// writer (TUI / agent sender) or on the inbound download path from a
// peer bridge.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { MAX_LINE_LEN, MessageTooLongError, appendLines } from '../lib/writer.mjs';
import { runBridge } from '../lib/bridge.mjs';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitFor(condition, { timeoutMs = 2000, intervalMs = 20 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await condition()) return;
    await sleep(intervalMs);
  }
  throw new Error('waitFor timeout');
}

// Minimal in-memory archive + cursor matching the shape bridge.test.mjs uses.
class MemoryArchive {
  constructor() { this.lines = []; this.listeners = new Set(); }
  #notify() { for (const fn of this.listeners) fn(); }
  async appendLine(_file, line) {
    this.lines.push(line);
    this.#notify();
    return this.lines.length;
  }
  async *watchForNewLines(_file, fromLine = 0, signal) {
    let cursor = fromLine;
    while (true) {
      while (cursor < this.lines.length) {
        const lineNo = cursor + 1;
        const line = this.lines[cursor];
        cursor++;
        yield { lineNo, line };
      }
      if (signal?.aborted) return;
      await new Promise((resolve) => {
        const onAbort = () => { signal.removeEventListener('abort', onAbort); this.listeners.delete(resolve); resolve(); };
        this.listeners.add(resolve);
        signal?.addEventListener('abort', onAbort);
      });
    }
  }
}

class MemoryCursor {
  constructor() { this.values = new Map(); }
  async load(chatId) {
    return structuredClone(this.values.get(chatId) ?? {
      chatId, lastSmalltoakId: 0, lastFileLine: 0,
      selfInsertedLines: [], pendingPosts: [], postedMessages: [],
    });
  }
  async save(chatId, cursor) {
    this.values.set(chatId, structuredClone({ ...cursor, chatId }));
    return this.values.get(chatId);
  }
}

test('writer.MAX_LINE_LEN is exported and equals 4000 (sanity)', () => {
  assert.equal(MAX_LINE_LEN, 4000);
});

test('appendLines short-line passes through (regression guard)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wtr-pass-'));
  try {
    const f = join(dir, 'chat.md');
    writeFileSync(f, '');
    await appendLines(f, 'alice', ['short message']);
    assert.match(readFileSync(f, 'utf8'), /\[\d{2}:\d{2} alice\] short message\n/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendLines exact-limit passes (boundary)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wtr-edge-'));
  try {
    const f = join(dir, 'chat.md');
    writeFileSync(f, '');
    await appendLines(f, 'alice', ['x'.repeat(MAX_LINE_LEN)]);
    assert.ok(readFileSync(f, 'utf8').includes('x'.repeat(MAX_LINE_LEN)), 'exact-limit line should pass');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendLines limit+1 throws — file untouched, no partial write', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wtr-toolong-'));
  try {
    const f = join(dir, 'chat.md');
    writeFileSync(f, '');
    await assert.rejects(
      () => appendLines(f, 'alice', ['x'.repeat(MAX_LINE_LEN + 1)]),
      MessageTooLongError
    );
    assert.equal(readFileSync(f, 'utf8'), '', 'file must be untouched on throw');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendLines: throws on offending line — atomic, no partial flush', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wtr-mixed-'));
  try {
    const f = join(dir, 'chat.md');
    writeFileSync(f, '');
    await assert.rejects(
      () => appendLines(f, 'alice', ['ok', 'x'.repeat(MAX_LINE_LEN + 1), 'never reached']),
      (err) => err instanceof MessageTooLongError && err.lineIndex === 1
    );
    assert.equal(readFileSync(f, 'utf8'), '', 'no partial flush on throw mid-array');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bridge replaces inbound too-long peer message with a visible system note', async () => {
  const oversizeText = 'a'.repeat(MAX_LINE_LEN + 100);
  const rawText = `[12:00 peer] ${oversizeText}`;
  let readCount = 0;

  const transport = {
    sender: 'me',
    async read({ since }) {
      readCount++;
      if (since > 0) return [];
      return [{
        id: 1, sender: 'peer-bridge', rawText,
        agent: 'peer', time: '12:00', text: oversizeText,
      }];
    },
    async post() { throw new Error('post should not be called'); },
  };

  const archive = new MemoryArchive();
  const cursorStore = new MemoryCursor();
  const controller = new AbortController();

  const bridgePromise = runBridge({
    chatId: 'test-chat',
    file: '/tmp/ignored-by-memory-archive.md',
    transport,
    archive,
    cursorStore,
    signal: controller.signal,
  }).catch(() => { /* aborted */ });

  await waitFor(() => archive.lines.length >= 1);
  controller.abort();
  await bridgePromise;

  assert.equal(archive.lines.length, 1, 'should write exactly one line');
  const written = archive.lines[0];
  assert.ok(!written.includes(oversizeText), 'oversize text must not appear');
  assert.match(written, /^\[12:00 system\]/, 'should be a system-authored note');
  assert.match(written, /inbound message from peer/, 'note should name source agent');
  assert.match(written, /exceeded line limit/, 'note should explain why');
  assert.match(written, new RegExp(`${rawText.length} chars > ${MAX_LINE_LEN}`), 'note should include byte counts');
});
