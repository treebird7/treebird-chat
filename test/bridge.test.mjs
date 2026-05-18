import test from 'node:test';
import assert from 'node:assert/strict';
import { runBridge } from '../lib/bridge.mjs';
import { createSmalltoakTransport } from '../lib/smalltoak-transport.mjs';
import { encodeLine } from '../lib/message-codec.mjs';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition, { timeoutMs = 4000, intervalMs = 20, message = 'condition not met' } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await condition()) return;
    await sleep(intervalMs);
  }
  throw new Error(message);
}

class MemoryCursorAdapter {
  constructor() {
    this.values = new Map();
  }

  async load(chatId) {
    return structuredClone(
      this.values.get(chatId) ?? {
        chatId,
        lastSmalltoakId: 0,
        lastFileLine: 0,
        selfInsertedLines: [],
        pendingPosts: [],
        postedMessages: [],
      }
    );
  }

  async save(chatId, cursor) {
    this.values.set(chatId, structuredClone({ ...cursor, chatId }));
    return this.values.get(chatId);
  }
}

class FakeArchive {
  // `misnumber: true` makes appendLine return a line number that matches no
  // real line — simulating markdown-archive mis-resolving a duplicate-content
  // line. Both self-appended lines then miss the line-number guard, so the
  // content ledger is the sole backstop against an echo storm.
  // `deferNotify: true` holds back watcher notifications until flushNotify()
  // is called — letting a test stage several appends before the watch loop
  // drains them, which makes the duplicate-content race deterministic.
  constructor(initialLines = [], { misnumber = false, deferNotify = false } = {}) {
    this.lines = [...initialLines];
    this.listeners = new Set();
    this.misnumber = misnumber;
    this.deferNotify = deferNotify;
  }

  appendLocal(line) {
    this.lines.push(line);
    this.#notify();
    return this.lines.length;
  }

  flushNotify() {
    this.#notify();
  }

  async appendLine(file, line) {
    this.lines.push(line);
    if (!this.deferNotify) this.#notify();
    return this.misnumber ? 9999 : this.lines.length;
  }

  async *watchForNewLines(file, fromLine = 0, signal) {
    let cursor = fromLine;

    while (true) {
      while (cursor < this.lines.length) {
        const lineNo = cursor + 1;
        const line = this.lines[cursor];
        cursor += 1;
        yield { lineNo, line };
      }

      if (signal?.aborted) return;

      await new Promise((resolve) => {
        const done = () => {
          this.listeners.delete(done);
          signal?.removeEventListener('abort', done);
          resolve();
        };
        this.listeners.add(done);
        signal?.addEventListener('abort', done, { once: true });
      });

      if (signal?.aborted && cursor >= this.lines.length) return;
    }
  }

  #notify() {
    for (const listener of [...this.listeners]) listener();
  }
}

class FakeTransport {
  constructor({ sender = 'bridge-test', readFailures = 0, postFailures = 0 } = {}) {
    this.sender = sender;
    this.readFailures = readFailures;
    this.postFailures = postFailures;
    this.messages = [];
    this.nextId = 1;
  }

  queueRemote({ agent, text, time, sender = 'bridge-remote', recipient = 'chat' }) {
    const message = {
      id: this.nextId++,
      agent,
      text,
      time,
      rawText: encodeLine({ agent, text, time }),
      sender,
      recipient,
    };
    this.messages.push(message);
    return message;
  }

  async read({ chatId, sinceId = 0 }) {
    if (this.readFailures > 0) {
      this.readFailures -= 1;
      throw new Error('unreachable');
    }

    return this.messages
      .filter((message) => message.recipient === chatId && message.id > sinceId)
      .map((message) => structuredClone(message));
  }

  async post({ chatId, agent, text, time }) {
    if (this.postFailures > 0) {
      this.postFailures -= 1;
      throw new Error('unreachable');
    }

    const message = {
      id: this.nextId++,
      agent,
      text,
      time: '2026-05-03T12:30:00Z',
      rawText: encodeLine({ agent, text, time }),
      sender: this.sender,
      recipient: chatId,
    };
    this.messages.push(message);
    return structuredClone(message);
  }
}

function jsonResponse(payload, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return structuredClone(payload);
    },
  };
}

function startBridge({ archive, transport, cursorStore, chatId = 'chat' }) {
  const controller = new AbortController();
  const promise = runBridge({
    chatId,
    file: '/tmp/chat.md',
    transport,
    archive,
    cursorStore,
    signal: controller.signal,
  });
  return { controller, promise };
}

test('bridge dedups local echoes and appends remote messages once', async (t) => {
  const archive = new FakeArchive();
  const transport = new FakeTransport();
  const cursorStore = new MemoryCursorAdapter();
  const bridge = startBridge({ archive, transport, cursorStore });

  t.after(async () => {
    bridge.controller.abort();
    await bridge.promise;
  });

  archive.appendLocal('[10:00 alice] local hello');

  await waitFor(
    () => transport.messages.some((message) => message.rawText === '[10:00 alice] local hello'),
    { message: 'local line was not posted' }
  );

  await sleep(200);
  assert.deepEqual(archive.lines, ['[10:00 alice] local hello']);

  transport.queueRemote({
    agent: 'bob',
    text: 'remote hi',
    time: '2026-05-03T12:34:00Z',
  });

  await waitFor(
    () => archive.lines.includes('[12:34 bob] remote hi'),
    { message: 'remote line was not appended' }
  );

  assert.equal(
    archive.lines.filter((line) => line === '[10:00 alice] local hello').length,
    1
  );
  assert.equal(
    archive.lines.filter((line) => line === '[12:34 bob] remote hi').length,
    1
  );
});

test('bridge appends identical-content remote messages once each and never re-posts them', async (t) => {
  // Contract: two remote messages with identical text must each be appended
  // exactly once and neither re-posted to smalltoak — exercising the self-echo
  // guard under duplicate content with a correctly-numbering archive.
  const archive = new FakeArchive();
  const transport = new FakeTransport();
  const cursorStore = new MemoryCursorAdapter();
  const bridge = startBridge({ archive, transport, cursorStore });

  t.after(async () => {
    bridge.controller.abort();
    await bridge.promise;
  });

  transport.queueRemote({ agent: 'treesan', text: 'joined', time: '2026-05-03T12:30:00Z' });
  transport.queueRemote({ agent: 'treesan', text: 'joined', time: '2026-05-03T12:30:00Z' });

  await waitFor(
    () => archive.lines.filter((line) => line === '[12:30 treesan] joined').length === 2,
    { message: 'both identical remote lines were not appended' }
  );

  // Give the bridge a window to (incorrectly) re-post if the guard fails.
  await sleep(300);

  assert.equal(
    archive.lines.filter((line) => line === '[12:30 treesan] joined').length,
    2,
    'echo storm: identical line was re-appended beyond the two remote messages'
  );
  assert.equal(
    transport.messages.filter((m) => m.sender === transport.sender).length,
    0,
    'bridge re-posted a remote line back to smalltoak'
  );
});

test('bridge does not echo-storm when duplicate self-lines miss the line-number guard', async (t) => {
  // Echo-storm regression. Two identical remote messages are appended before
  // the watch loop drains either (deferNotify), and the archive mis-numbers
  // both (misnumber) so neither hits the line-number guard. The content guard
  // is then the only thing standing between the bridge and a re-post loop —
  // and a plain Set collapses the two identical credits into one, so the
  // second echo escapes. The counting ledger keeps one credit per append.
  const archive = new FakeArchive([], { misnumber: true, deferNotify: true });
  const transport = new FakeTransport();
  const cursorStore = new MemoryCursorAdapter();
  const bridge = startBridge({ archive, transport, cursorStore });

  t.after(async () => {
    bridge.controller.abort();
    await bridge.promise;
  });

  transport.queueRemote({ agent: 'treesan', text: 'joined', time: '2026-05-03T12:30:00Z' });
  transport.queueRemote({ agent: 'treesan', text: 'joined', time: '2026-05-03T12:30:00Z' });

  // Wait until syncOnce has appended both copies (and registered both content
  // credits) before releasing the watch loop.
  await waitFor(
    () => archive.lines.filter((line) => line === '[12:30 treesan] joined').length === 2,
    { message: 'both identical remote lines were not appended' }
  );
  archive.flushNotify();

  // Window for a storm to amplify if the second echo escapes the guard.
  await sleep(400);

  assert.equal(
    archive.lines.filter((line) => line === '[12:30 treesan] joined').length,
    2,
    'echo storm: identical line was re-appended'
  );
  assert.equal(
    transport.messages.filter((m) => m.sender === transport.sender).length,
    0,
    'bridge re-posted a remote line back to smalltoak'
  );
});

test('bridge preserves remote [HH:MM] from line text when smalltoak ts disagrees', async (t) => {
  const archive = new FakeArchive();
  const cursorStore = new MemoryCursorAdapter();
  const transport = createSmalltoakTransport({
    baseUrl: 'http://smalltoak.test',
    sender: 'bridge-local',
    fetchImpl: async (input, init = {}) => {
      const url = String(input);
      if (init.method === 'POST') {
        throw new Error(`unexpected POST to ${url}`);
      }

      return jsonResponse([
        {
          id: 1,
          from: 'bridge-m5',
          to: 'chat',
          text: '[17:08 yosef] hi from m5',
          ts: '2026-05-03T14:08:00Z',
        },
      ]);
    },
  });
  const bridge = startBridge({ archive, transport, cursorStore });

  t.after(async () => {
    bridge.controller.abort();
    await bridge.promise;
  });

  await waitFor(
    () => archive.lines.includes('[17:08 yosef] hi from m5'),
    { message: 'remote line was not appended with original [HH:MM]' }
  );

  assert.equal(
    archive.lines.filter((line) => line === '[17:08 yosef] hi from m5').length,
    1
  );
  assert.equal(
    archive.lines.includes('[14:08 yosef] hi from m5'),
    false
  );
});

test('bridge restart resumes pending local lines and remote reads without duplicates', async () => {
  const archive = new FakeArchive(['[10:00 alice] first']);
  const transport = new FakeTransport();
  const cursorStore = new MemoryCursorAdapter();

  let bridge = startBridge({ archive, transport, cursorStore });

  await waitFor(
    () => transport.messages.some((message) => message.rawText === '[10:00 alice] first'),
    { message: 'first line was not posted' }
  );

  bridge.controller.abort();
  await bridge.promise;

  archive.appendLocal('[10:01 alice] second');
  transport.queueRemote({
    agent: 'bob',
    text: 'while you were away',
    time: '2026-05-03T12:35:00Z',
  });

  bridge = startBridge({ archive, transport, cursorStore });

  await waitFor(
    () => transport.messages.some((message) => message.rawText === '[10:01 alice] second'),
    { message: 'second line was not posted after restart' }
  );

  await waitFor(
    () => archive.lines.includes('[12:35 bob] while you were away'),
    { message: 'remote backlog line was not appended after restart' }
  );

  bridge.controller.abort();
  await bridge.promise;

  assert.equal(
    archive.lines.filter((line) => line === '[10:01 alice] second').length,
    1
  );
  assert.equal(
    archive.lines.filter((line) => line === '[12:35 bob] while you were away').length,
    1
  );
});

test('bridge backs off on transport failures and drains queued file lines after recovery', async (t) => {
  const archive = new FakeArchive();
  const transport = new FakeTransport({ readFailures: 1 });
  const cursorStore = new MemoryCursorAdapter();
  const bridge = startBridge({ archive, transport, cursorStore });

  t.after(async () => {
    bridge.controller.abort();
    await bridge.promise;
  });

  archive.appendLocal('[10:00 alice] queued while offline');

  await sleep(200);
  const queued = await cursorStore.load('chat');
  assert.equal(queued.pendingPosts.length, 1);
  assert.equal(transport.messages.length, 0);

  await waitFor(
    () => transport.messages.some((message) => message.rawText === '[10:00 alice] queued while offline'),
    { timeoutMs: 3500, message: 'queued post never drained after recovery' }
  );

  const drained = await cursorStore.load('chat');
  assert.equal(drained.pendingPosts.length, 0);
});

test('bridge ignores malformed file lines', async (t) => {
  const archive = new FakeArchive();
  const transport = new FakeTransport();
  const cursorStore = new MemoryCursorAdapter();
  const bridge = startBridge({ archive, transport, cursorStore });

  t.after(async () => {
    bridge.controller.abort();
    await bridge.promise;
  });

  archive.appendLocal('this is not a flat birdchat line');

  await waitFor(
    async () => (await cursorStore.load('chat')).lastFileLine === 1,
    { message: 'malformed line was not consumed' }
  );

  await sleep(200);
  assert.equal(transport.messages.length, 0);
});

test('bridge stops cleanly on abort', async () => {
  const archive = new FakeArchive();
  const transport = new FakeTransport();
  const cursorStore = new MemoryCursorAdapter();
  const bridge = startBridge({ archive, transport, cursorStore });
  let settled = false;

  bridge.promise.then(() => {
    settled = true;
  });

  bridge.controller.abort();

  await waitFor(() => settled, { timeoutMs: 1000, message: 'bridge did not stop on abort' });
  await bridge.promise;
});
