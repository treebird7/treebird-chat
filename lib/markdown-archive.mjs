import { appendFile, readFile } from 'node:fs/promises';
import chokidar from 'chokidar';

async function readLines(file) {
  try {
    const content = await readFile(file, 'utf8');
    const lines = content.split('\n');
    if (lines.at(-1) === '') lines.pop();
    return lines;
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function normalizeLine(line) {
  return String(line ?? '').replace(/\r?\n/g, ' ').trimEnd();
}

export function createMarkdownArchive({ pollMs = 500 } = {}) {
  return {
    async appendLine(file, line) {
      const normalized = normalizeLine(line);
      const before = await readLines(file);
      await appendFile(file, `${normalized}\n`);
      const after = await readLines(file);
      // Return the 1-based line number of the line we just appended. Scan the
      // newly-grown range from the END for our content: the line we wrote is
      // its most recent occurrence. Matching the FIRST occurrence resolves to a
      // stale duplicate line when the file already holds identical content,
      // which mis-registers the bridge's self-echo guard (selfInsertedLines)
      // and produces a re-post loop / echo storm.
      for (let index = after.length - 1; index >= before.length; index--) {
        if (after[index] === normalized) return index + 1;
      }
      return after.length;
    },

    async *watchForNewLines(file, fromLine = 0, signal) {
      let lastLine = fromLine;
      const queue = [];
      let wake = null;
      let scanChain = Promise.resolve();

      const notify = () => {
        if (!wake) return;
        const resolve = wake;
        wake = null;
        resolve();
      };

      const scan = () => {
        scanChain = scanChain.then(async () => {
          const lines = await readLines(file);
          if (lines.length < lastLine) lastLine = lines.length;
          if (lines.length <= lastLine) return;
          const next = lines.slice(lastLine).map((line, index) => ({
            lineNo: lastLine + index + 1,
            line,
          }));
          lastLine = lines.length;
          queue.push(...next);
          notify();
        });
        return scanChain;
      };

      await scan();

      const watcher = chokidar.watch(file, {
        ignoreInitial: true,
        usePolling: true,
        interval: pollMs,
        awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
      });

      const onAbort = () => notify();
      signal?.addEventListener('abort', onAbort, { once: true });
      watcher.on('add', scan).on('change', scan).on('unlink', scan);

      try {
        while (true) {
          if (queue.length > 0) {
            yield queue.shift();
            continue;
          }
          if (signal?.aborted) return;
          await new Promise((resolve) => {
            wake = resolve;
          });
          if (signal?.aborted && queue.length === 0) return;
        }
      } finally {
        signal?.removeEventListener('abort', onAbort);
        await watcher.close();
      }
    },
  };
}
