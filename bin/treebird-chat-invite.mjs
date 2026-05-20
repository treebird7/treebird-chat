#!/usr/bin/env node
// treebird-chat-invite <file> <agent> [--smalltoak-url URL] [--chat-id ID]
//
// Prints a self-contained invite block for an agent to copy-paste into their
// Claude Code session. Works for local (same-machine) and smalltoak (remote)
// setups. When the server is running TLS (SMALLTOAK_CERT in env), the invite
// embeds the pinned cert + its SHA-256 fingerprint.

import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { isValidAgentName } from '../lib/identity.mjs';
import { loadEnv, resolvePublicUrl } from '../lib/config.mjs';
import {
  readInviterCert,
  composeRemoteInvite,
  composeLocalInvite,
} from '../lib/invite-block.mjs';

loadEnv();

function parseArgs(argv) {
  const args = { file: null, agent: null, smalltoakUrl: null, chatId: null };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--smalltoak-url') args.smalltoakUrl = argv[++i];
    else if (a === '--chat-id')    args.chatId      = argv[++i];
    else if (!a.startsWith('--')) positional.push(a);
  }
  args.file  = positional[0];
  args.agent = positional[1];
  return args;
}

const { file, agent, smalltoakUrl, chatId } = parseArgs(process.argv.slice(2));
if (!file || !agent) {
  process.stderr.write('usage: treebird-chat-invite <file> <agent> [--smalltoak-url URL] [--chat-id ID]\n');
  process.exit(1);
}
if (!isValidAgentName(agent)) {
  process.stderr.write(`Invalid agent name "${agent}": letters/digits/hyphens/underscores, must start with a letter, max 64 chars.\n`);
  process.exit(1);
}

const filePath = resolve(file);
if (!existsSync(filePath)) {
  process.stderr.write(`File not found: ${filePath}\n`);
  process.exit(1);
}

if (smalltoakUrl && chatId) {
  // Remote / cross-machine invite. A localhost URL would point the invitee at
  // their own machine — rewrite to this host's reachable IP.
  const { url: joinUrl, alternates } = resolvePublicUrl(smalltoakUrl);
  const cert = readInviterCert();
  // Sanity: if the URL is https:// but no cert is in env, the resulting
  // invite would silently lack a pin — refuse to print one we know is unsafe.
  if (joinUrl.startsWith('https://') && !cert) {
    process.stderr.write(
      'Refusing to print invite: smalltoak-url is https:// but no SMALLTOAK_CERT[_FILE] is set.\n' +
      'The invitee would have no pin to verify the server. Set SMALLTOAK_CERT in env, or switch to http://.\n'
    );
    process.exit(1);
  }
  process.stdout.write(composeRemoteInvite({
    chatId, joinUrl, invitee: agent, alternates, cert,
  }));
} else {
  process.stdout.write(composeLocalInvite({ invitee: agent, filePath }));
}
