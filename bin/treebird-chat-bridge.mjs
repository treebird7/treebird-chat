#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import os from 'node:os';
import { runBridge } from '../lib/bridge.mjs';
import { createFileCursorStore } from '../lib/bridge-cursor.mjs';
import { createMarkdownArchive } from '../lib/markdown-archive.mjs';
import { AuthError, createSmalltoakTransport } from '../lib/smalltoak-transport.mjs';

const EXIT = { OK: 0, ERROR: 1, REVOKED: 3 };

function parseArgs(argv) {
  const args = { chatId: null, file: null, smalltoakUrl: process.env.SMALLTOAK_SERVER_URL || null };

  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === '--smalltoak-url') args.smalltoakUrl = argv[++index];
    else if (!value.startsWith('--') && !args.chatId) args.chatId = value;
    else if (!value.startsWith('--') && !args.file) args.file = value;
  }

  return args;
}

function usage() {
  process.stderr.write('usage: treebird-chat-bridge <chat-id> <local-file> [--smalltoak-url URL]\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.chatId || !args.file) {
    usage();
    process.exit(EXIT.ERROR);
  }

  if (!args.smalltoakUrl) {
    process.stderr.write('Missing smalltoak URL. Set SMALLTOAK_SERVER_URL or pass --smalltoak-url.\n');
    process.exit(EXIT.ERROR);
  }

  const token = process.env.SMALLTOAK_TOKEN;
  if (!token) {
    process.stderr.write('Missing SMALLTOAK_TOKEN.\n');
    process.exit(EXIT.ERROR);
  }

  const file = resolve(args.file);
  if (!existsSync(file)) {
    process.stderr.write(`File not found: ${file}\n`);
    process.exit(EXIT.ERROR);
  }

  const machine = process.env.TREEBIRD_MACHINE || os.hostname().split('.')[0];
  const transport = createSmalltoakTransport({
    baseUrl: args.smalltoakUrl,
    token,
    sender: `bridge-${machine}`,
  });
  const archive = createMarkdownArchive({
    pollMs: Number.parseInt(process.env.BIRDCHAT_BRIDGE_POLL_MS || '500', 10) || 500,
  });
  const cursorStore = createFileCursorStore(file);
  const controller = new AbortController();
  const stop = () => controller.abort();

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  try {
    await runBridge({
      chatId: args.chatId,
      file,
      transport,
      archive,
      cursorStore,
      signal: controller.signal,
    });
    process.exit(EXIT.OK);
  } catch (error) {
    if (error instanceof AuthError || error?.code === 'AUTH') {
      process.stderr.write(`${error.message}\n`);
      process.exit(EXIT.REVOKED);
    }
    process.stderr.write(`treebird-chat-bridge error: ${error.stack || error.message}\n`);
    process.exit(EXIT.ERROR);
  }
}

main();
