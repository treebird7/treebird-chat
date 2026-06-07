#!/usr/bin/env node
// treebird-chat-init — first-run setup: persist the smalltoak relay config to
// ~/.treebird-chat/.env so `trbc join <chat-id> --as <name>` needs no flags.
//
// Writes SMALLTOAK_URL + SMALLTOAK_TOKEN only. By design it does NOT store an
// identity: a persisted identity (ENVOAK_AGENT_LABEL/BIRDCHAT_AGENT) would
// silently win over --as (the precedence footgun sasusan flagged). Relay config
// is machine-level and safe to persist; identity stays per-invocation.
//
// usage: treebird-chat-init [--url URL] [--token TOKEN] [--from-vault] [--force]
//   --url URL       smalltoak relay URL (e.g. http://192.168.1.207:3000)
//   --token TOKEN   smalltoak shared token
//   --from-vault    pull URL + token from the envoak vault (treebird-chat ns)
//   --force         overwrite values already in .env (default: keep existing)
//   --help, -h

import readline from 'node:readline';
import { resolveSmalltoakUrl, vaultGet, upsertUserEnv, userEnvPath } from '../lib/config.mjs';

const USAGE = `treebird-chat-init — write smalltoak relay config to ~/.treebird-chat/.env

usage: treebird-chat-init [--url URL] [--token TOKEN] [--from-vault] [--force]
  --url URL       smalltoak relay URL (e.g. http://192.168.1.207:3000)
  --token TOKEN   smalltoak shared token
  --from-vault    pull URL + token from the envoak vault (treebird-chat ns)
  --force         overwrite values already in .env (default: keep existing)
  --help, -h      show this help

Persists SMALLTOAK_URL + SMALLTOAK_TOKEN only — never an identity (use --as /
envoak per session). After this, joining is just: trbc join <chat-id> --as <name>.
`;

function parseArgs(argv) {
  if (argv.some(a => a === '--help' || a === '-h')) { process.stdout.write(USAGE); process.exit(0); }
  const a = { url: null, token: null, fromVault: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if      (x === '--url')        a.url = argv[++i];
    else if (x === '--token')      a.token = argv[++i];
    else if (x === '--from-vault') a.fromVault = true;
    else if (x === '--force')      a.force = true;
    else { process.stderr.write(`unknown argument: ${x}\n\n${USAGE}`); process.exit(2); }
  }
  return a;
}

function prompt(q, { silent = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (silent && rl.output) {
      // Mask token input — mute the echo while typing.
      rl._writeToOutput = (s) => { if (s.includes('\n')) rl.output.write('\n'); };
    }
    rl.question(q, (ans) => { rl.close(); resolve(ans.trim()); });
  });
}

const args = parseArgs(process.argv.slice(2));

let url = args.url;
let token = args.token;

if (args.fromVault) {
  if (!url)   url   = resolveSmalltoakUrl().url;                      // env/vault URL
  if (!token) token = vaultGet('treebird-chat', 'SMALLTOAK_TOKEN');  // vault token
  if (url)   process.stdout.write(`[init] url from ${args.url ? 'flag' : 'vault/env'}: ${url}\n`);
  if (token) process.stdout.write(`[init] token from vault: ${'•'.repeat(8)} (hidden)\n`);
}

// Interactive fill for anything still missing (only when attached to a TTY).
if ((!url || !token) && process.stdin.isTTY) {
  if (!url)   url   = await prompt('smalltoak relay URL (e.g. http://192.168.1.207:3000): ');
  if (!token) token = await prompt('smalltoak token: ', { silent: true });
}

if (!url && !token) {
  process.stderr.write(
    'Nothing to write. Provide --url and/or --token, use --from-vault, or run in a terminal to be prompted.\n\n' + USAGE
  );
  process.exit(1);
}

const updates = {};
if (url)   updates.SMALLTOAK_URL = url;
if (token) updates.SMALLTOAK_TOKEN = token;

const { path, written, skipped } = upsertUserEnv(updates, { overwrite: args.force });

process.stdout.write(`\n✅ ${path} (mode 0600)\n`);
if (written.length) process.stdout.write(`   set: ${written.join(', ')}\n`);
if (skipped.length) process.stdout.write(`   kept existing (use --force to overwrite): ${skipped.join(', ')}\n`);
if (url)   process.stdout.write(`   SMALLTOAK_URL=${url}\n`);
if (token) process.stdout.write(`   SMALLTOAK_TOKEN=${'•'.repeat(8)} (hidden)\n`);
if (url && url.startsWith('http://')) {
  process.stdout.write(`   ⚠️  plain http — token travels unencrypted on shared networks. Prefer https + cert-pin for production.\n`);
}
process.stdout.write(`\nNext: create a session (registers a chat-id), then anyone runs:\n  trbc join <chat-id> --as <name>\n`);
