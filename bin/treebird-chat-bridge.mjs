#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import os from 'node:os';
import { runBridge } from '../lib/bridge.mjs';
import { createFileCursorStore } from '../lib/bridge-cursor.mjs';
import { createMarkdownArchive } from '../lib/markdown-archive.mjs';
import { AuthError, createSmalltoakTransport } from '../lib/smalltoak-transport.mjs';
import { loadPin } from '../lib/smalltoak-pin.mjs';
import { formatBridgeError } from '../lib/bridge-errors.mjs';
import { loadEnv, resolveSmalltoakUrl, gitRepoRootFor } from '../lib/config.mjs';

loadEnv();

const EXIT = { OK: 0, ERROR: 1, REVOKED: 3 };

function parseArgs(argv) {
  // P1: env → envoak vault → null. resolveSmalltoakUrl runs at parse-time
  // (after loadEnv()), so .env values are seen here too.
  const { url: defaultUrl } = resolveSmalltoakUrl();
  const args = {
    chatId: null,
    file: null,
    smalltoakUrl: defaultUrl,
    // --cert-file beats SMALLTOAK_CERT_FILE beats SMALLTOAK_CERT (server-side
    // env var; tolerated here so a single .env covers both server + client).
    certFile: process.env.SMALLTOAK_CERT_FILE || process.env.SMALLTOAK_CERT || null,
  };

  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === '--smalltoak-url') args.smalltoakUrl = argv[++index];
    else if (value === '--cert-file') args.certFile = argv[++index];
    else if (value === '--as') index++; // accepted-and-ignored — for forward-compat with join's invocation
    else if (!value.startsWith('--') && !args.chatId) args.chatId = value;
    else if (!value.startsWith('--') && !args.file) args.file = value;
  }

  return args;
}

function usage() {
  process.stderr.write('usage: treebird-chat-bridge <chat-id> <local-file> [--smalltoak-url URL] [--cert-file PATH]\n');
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

  // Dual-sync guard. A chat file should have ONE sync layer. If this file is
  // inside a git work tree, a `git pull`/`checkout` will atomic-rename it out
  // from under the bridge and desync the cursor (the 2026-06-07 incident). Warn
  // — don't refuse, since the file may legitimately live in a repo for archival
  // as long as nobody runs git on it mid-session. Set TREEBIRD_CHAT_NO_GIT_WARN=1
  // to silence once acknowledged.
  const repoRoot = gitRepoRootFor(file);
  if (repoRoot && !process.env.TREEBIRD_CHAT_NO_GIT_WARN) {
    process.stderr.write(
      `[bridge] ⚠️  ${file}\n` +
      `         is inside a git repo (${repoRoot}). Running the bridge AND git-syncing\n` +
      `         the same file conflict — git's atomic-rename saves desync the bridge.\n` +
      `         Pick ONE transport: bridge (don't git pull/push this file mid-session)\n` +
      `         OR git (don't bridge it). Silence with TREEBIRD_CHAT_NO_GIT_WARN=1.\n`
    );
  }

  const machine = process.env.TREEBIRD_MACHINE || os.hostname().split('.')[0];

  // Resolve the pin if the URL is https:// — the transport will refuse to
  // construct without one (fail-closed). For http:// the pin is unused.
  let pin = null;
  if (args.certFile) {
    try { pin = loadPin(args.certFile); }
    catch (e) {
      process.stderr.write(`${e.message}\n`);
      process.exit(EXIT.ERROR);
    }
  }

  let transport;
  try {
    transport = createSmalltoakTransport({
      baseUrl: args.smalltoakUrl,
      token,
      sender: `bridge-${machine}`,
      pin,
    });
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(EXIT.ERROR);
  }
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
      process.stderr.write(`${formatBridgeError({
        error, op: 'auth', url: transport.baseUrl, chatId: args.chatId,
      })}\n`);
      process.exit(EXIT.REVOKED);
    }
    process.stderr.write(`${formatBridgeError({
      error, op: 'bridge', url: transport.baseUrl, chatId: args.chatId,
    })}\n`);
    process.exit(EXIT.ERROR);
  }
}

main();
