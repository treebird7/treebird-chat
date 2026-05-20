import { AuthError } from './smalltoak-transport.mjs';
import { decodeLine, encodeLine } from './message-codec.mjs';
import { formatBridgeError } from './bridge-errors.mjs';

const DEFAULT_POLL_MS = Number.parseInt(process.env.BIRDCHAT_BRIDGE_POLL_MS || '500', 10) || 500;
const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;
const PRUNE_WINDOW = 1000;

function sleep(ms, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function nextBackoff(ms) {
  return Math.min(ms * 2, MAX_BACKOFF_MS);
}

// In-session multiset of line content the bridge appended itself, used as a
// backstop to the line-number guard. A plain Set collapses duplicate content,
// so a second identical self-line would go unrecognized once the first was
// consumed — that gap is what lets an echo storm form. Counting keeps one
// credit per self-append regardless of duplicate content.
function createSelfContentLedger() {
  const counts = new Map();
  return {
    add(line) {
      counts.set(line, (counts.get(line) ?? 0) + 1);
    },
    take(line) {
      const n = counts.get(line) ?? 0;
      if (n <= 0) return false;
      if (n === 1) counts.delete(line);
      else counts.set(line, n - 1);
      return true;
    },
  };
}

function createGate() {
  let open = false;
  let waiters = [];

  return {
    release() {
      if (open) return;
      open = true;
      const current = waiters;
      waiters = [];
      for (const resolve of current) resolve();
    },
    async wait(signal) {
      if (open || signal?.aborted) return;
      await new Promise((resolve) => {
        const done = () => {
          signal?.removeEventListener('abort', done);
          resolve();
        };
        waiters.push(done);
        signal?.addEventListener('abort', done, { once: true });
      });
    },
  };
}

function createNotifier() {
  let waiters = [];

  return {
    notify() {
      const current = waiters;
      waiters = [];
      for (const resolve of current) resolve();
    },
    async wait(signal) {
      if (signal?.aborted) return;
      await new Promise((resolve) => {
        const done = () => {
          signal?.removeEventListener('abort', done);
          resolve();
        };
        waiters.push(done);
        signal?.addEventListener('abort', done, { once: true });
      });
    },
  };
}

function createState(cursor) {
  return {
    chatId: cursor.chatId,
    lastSmalltoakId: cursor.lastSmalltoakId,
    lastFileLine: cursor.lastFileLine,
    selfInsertedLines: new Set(cursor.selfInsertedLines),
    pendingPosts: [...cursor.pendingPosts],
    postedMessages: [...cursor.postedMessages],
  };
}

function pruneState(state) {
  const floor = Math.max(0, state.lastFileLine - PRUNE_WINDOW);
  state.selfInsertedLines = new Set([...state.selfInsertedLines].filter((lineNo) => lineNo > floor));
  state.postedMessages = state.postedMessages.filter((message) => message.id > state.lastSmalltoakId);
}

function snapshotState(state) {
  pruneState(state);
  return {
    chatId: state.chatId,
    lastSmalltoakId: state.lastSmalltoakId,
    lastFileLine: state.lastFileLine,
    selfInsertedLines: [...state.selfInsertedLines].sort((a, b) => a - b),
    pendingPosts: state.pendingPosts.map((entry) => ({ lineNo: entry.lineNo, line: entry.line })),
    postedMessages: state.postedMessages.map((entry) => ({ id: entry.id, line: entry.line })),
  };
}

function removeByLine(entries, line) {
  const index = entries.findIndex((entry) => entry.line === line);
  if (index === -1) return null;
  return entries.splice(index, 1)[0];
}

function removePostedMessage(state, message) {
  const byId = state.postedMessages.findIndex((entry) => entry.id === message.id);
  if (byId !== -1) {
    state.postedMessages.splice(byId, 1);
    return true;
  }

  if (message.sender) {
    const byLine = state.postedMessages.findIndex((entry) => entry.line === message.rawText);
    if (byLine !== -1) {
      state.postedMessages.splice(byLine, 1);
      return true;
    }
  }

  return false;
}

async function syncOnce(context) {
  const messages = await context.transport.read({
    chatId: context.chatId,
    sinceId: context.state.lastSmalltoakId,
  });

  context.readReady.release();

  for (const message of messages) {
    if (context.signal.aborted) return;

    if (removePostedMessage(context.state, message)) {
      context.state.lastSmalltoakId = Math.max(context.state.lastSmalltoakId, message.id);
      await context.persist();
      continue;
    }

    if (message.sender === context.transport.sender && removeByLine(context.state.pendingPosts, message.rawText)) {
      context.state.lastSmalltoakId = Math.max(context.state.lastSmalltoakId, message.id);
      await context.persist();
      continue;
    }

    const line = encodeLine(message);
    // Pre-register by content before the async appendLine so watchFileLoop
    // can skip this line even if it fires between appendFile and lineNo return.
    context.selfInsertedContent.add(line);
    const lineNo = await context.archive.appendLine(context.file, line);
    context.state.selfInsertedLines.add(lineNo);
    // Advance cursor only after appendLine succeeds — prevents skipping on retry.
    context.state.lastSmalltoakId = Math.max(context.state.lastSmalltoakId, message.id);
    await context.persist();
  }
}

async function pollSmalltoakLoop(context) {
  let backoffMs = MIN_BACKOFF_MS;

  while (!context.signal.aborted) {
    try {
      await syncOnce(context);
      backoffMs = MIN_BACKOFF_MS;
      await sleep(context.pollMs, context.signal);
    } catch (error) {
      if (context.signal.aborted) return;
      if (error instanceof AuthError) throw error;
      console.error(formatBridgeError({
        error,
        op: 'read',
        url: context.transport.baseUrl,
        chatId: context.chatId,
      }));
      await sleep(backoffMs, context.signal);
      backoffMs = nextBackoff(backoffMs);
    }
  }
}

async function watchFileLoop(context) {
  for await (const { lineNo, line } of context.archive.watchForNewLines(
    context.file,
    context.state.lastFileLine,
    context.signal
  )) {
    if (context.signal.aborted) return;

    context.state.lastFileLine = Math.max(context.state.lastFileLine, lineNo);

    // Consume a credit from both guards. Call both (no short-circuit) so a
    // self-append registered under a stale line number still has its content
    // credit retired — otherwise the credit leaks and a later genuine local
    // line of the same content would be wrongly suppressed.
    const knownByLine = context.state.selfInsertedLines.delete(lineNo);
    const knownByContent = context.selfInsertedContent.take(line);
    if (knownByLine || knownByContent) {
      await context.persist();
      continue;
    }

    if (!decodeLine(line)) {
      await context.persist();
      continue;
    }

    if (!context.state.pendingPosts.some((entry) => entry.lineNo === lineNo)) {
      context.state.pendingPosts.push({ lineNo, line });
      context.pendingWrites.notify();
    }

    await context.persist();
  }
}

async function flushPendingPostsLoop(context) {
  let backoffMs = MIN_BACKOFF_MS;

  await context.readReady.wait(context.signal);

  while (!context.signal.aborted) {
    const next = context.state.pendingPosts[0];
    if (!next) {
      await context.pendingWrites.wait(context.signal);
      continue;
    }

    const decoded = decodeLine(next.line);
    if (!decoded) {
      context.state.pendingPosts.shift();
      await context.persist();
      continue;
    }

    try {
      const message = await context.transport.post({
        chatId: context.chatId,
        agent: decoded.agent,
        text: decoded.text,
        time: decoded.time,
      });
      removeByLine(context.state.pendingPosts, next.line);
      context.state.postedMessages.push({ id: message.id, line: message.rawText });
      await context.persist();
      backoffMs = MIN_BACKOFF_MS;
    } catch (error) {
      if (context.signal.aborted) return;
      if (error instanceof AuthError) throw error;
      console.error(formatBridgeError({
        error,
        op: 'post',
        url: context.transport.baseUrl,
        chatId: context.chatId,
      }));
      await sleep(backoffMs, context.signal);
      backoffMs = nextBackoff(backoffMs);
    }
  }
}

export async function runBridge({ chatId, file, transport, archive, cursorStore, signal }) {
  const loaded = await cursorStore.load(chatId);
  const state = createState(loaded);
  const readReady = createGate();
  const pendingWrites = createNotifier();
  let saveChain = Promise.resolve();

  const persist = async () => {
    const snapshot = snapshotState(state);
    saveChain = saveChain.then(() => cursorStore.save(chatId, snapshot));
    await saveChain;
  };

  const controller = new AbortController();
  const relayAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) relayAbort();
  else signal?.addEventListener('abort', relayAbort, { once: true });

  const context = {
    chatId,
    file,
    transport,
    archive,
    cursorStore,
    state,
    signal: controller.signal,
    pollMs: DEFAULT_POLL_MS,
    persist,
    readReady,
    pendingWrites,
    selfInsertedContent: createSelfContentLedger(), // in-session content guard against watchFileLoop race
  };

  try {
    await persist();
    await Promise.all([
      pollSmalltoakLoop(context),
      watchFileLoop(context),
      flushPendingPostsLoop(context),
    ]);
  } finally {
    controller.abort();
    signal?.removeEventListener('abort', relayAbort);
  }
}
