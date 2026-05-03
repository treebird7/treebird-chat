#!/usr/bin/env node
// treebird-chat-tail <file> [--from-start]
// Read-only live viewer. Prints flat-format messages as they arrive,
// colorized by author. Handles atomic-rename saves via polling.

import { resolve } from 'node:path';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import chokidar from 'chokidar';
import { FLAT_RE } from '../lib/watcher.mjs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const fromStart = args.includes('--from-start');

if (!file) {
  process.stderr.write('usage: treebird-chat-tail <file> [--from-start]\n');
  process.exit(1);
}

const filePath = resolve(file);
if (!existsSync(filePath)) {
  process.stderr.write(`File not found: ${filePath}\n`);
  process.exit(1);
}

const COLORS = ['\x1b[36m', '\x1b[35m', '\x1b[33m', '\x1b[32m', '\x1b[34m', '\x1b[91m', '\x1b[95m'];
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function colorFor(author) {
  let h = 0;
  for (let i = 0; i < author.length; i++) h = (h * 31 + author.charCodeAt(i)) | 0;
  return COLORS[Math.abs(h) % COLORS.length];
}

function printLine(line) {
  const m = line.match(FLAT_RE);
  if (m) {
    const [, time, author, msg] = m;
    const c = colorFor(author);
    process.stdout.write(`${DIM}${time}${RESET} ${c}${author}${RESET} ${msg}\n`);
  } else if (line.trim()) {
    // Non-flat content (round headers, separators, freeform) — show dim.
    process.stdout.write(`${DIM}${line}${RESET}\n`);
  }
}

let cursor = 0;
if (!fromStart) {
  // Start at end of file — only show NEW messages.
  cursor = statSync(filePath).size;
} else {
  const content = readFileSync(filePath, 'utf8');
  for (const line of content.split('\n')) printLine(line);
  cursor = content.length;
}

let pump = Promise.resolve();
const onChange = () => {
  pump = pump.then(async () => {
    const size = statSync(filePath).size;
    if (size < cursor) {
      // File shrank (truncated or replaced) — re-snapshot from current size.
      cursor = size;
      return;
    }
    if (size === cursor) return;
    const fh = await open(filePath, 'r');
    const buf = Buffer.alloc(size - cursor);
    await fh.read(buf, 0, buf.length, cursor);
    await fh.close();
    cursor = size;
    const text = buf.toString('utf8');
    for (const line of text.split('\n').slice(0, -1)) printLine(line);
    // Note: trailing partial line (no \n yet) is left for next pump.
  });
};

const watcher = chokidar.watch(filePath, {
  usePolling: true,
  interval: 300,
  awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
});
watcher.on('add', onChange).on('change', onChange);

process.on('SIGINT', async () => {
  await watcher.close();
  process.exit(0);
});
