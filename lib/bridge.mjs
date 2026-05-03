import { AuthError } from './smalltoak-transport.mjs';
import { decodeLine, encodeLine } from './message-codec.mjs';

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
    context.state.lastSmalltoakId = Math.max(context.state.lastSmalltoakId, message.id);

    if (removePostedMessage(context.state, message)) {
      await context.persist();
      continue;
    }

    if (message.sender === context.transport.sender && removeByLine(context.state.pendingPosts, message.rawText)) {
      await context.persist();
      continue;
    }

    const line = encodeLine(message);
    const lineNo = await context.archive.appendLine(context.file, line);
    context.state.selfInsertedLines.add(lineNo);
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
      console.error(`treebird-chat-bridge read error: ${error.message}`);
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

    if (context.state.selfInsertedLines.has(lineNo)) {
      context.state.selfInsertedLines.delete(lineNo);
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
      console.error(`treebird-chat-bridge post error: ${error.message}`);
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
