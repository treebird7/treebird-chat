#!/usr/bin/env node
// treebird-chat-invite <file> <agent> [--smalltoak-url URL] [--chat-id ID]
//
// Prints a self-contained invite block for an agent to copy-paste into their
// Claude Code session. Works for local (same-machine) and smalltoak (remote) setups.

import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

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

const filePath = resolve(file);
if (!existsSync(filePath)) {
  process.stderr.write(`File not found: ${filePath}\n`);
  process.exit(1);
}

const W = '═'.repeat(56);
const line = '─'.repeat(56);

if (smalltoakUrl && chatId) {
  // Remote / cross-machine invite
  process.stdout.write(`
${W}
 treebird-chat invite — ${agent}  [cross-machine via smalltoak]
${W}

 You've been invited to a treebird-chat session.
 This session is bridged over smalltoak — you join via the
 bridge, not a local file.

 1. Start the bridge on your machine:

    SMALLTOAK_TOKEN=<your-token> \\
    BIRDCHAT_AGENT=${agent} \\
    node ~/Dev/treebird-chat/bin/treebird-chat-bridge.mjs \\
      ${chatId} /tmp/${chatId}.md \\
      --smalltoak-url ${smalltoakUrl} \\
      --as ${agent}

 2. Then join the local mirror file it creates:

    corrwait /tmp/${chatId}.md --as ${agent} --timeout 540

 3. Reply with:

    printf '[%s ${agent}] your reply\\n' "$(date +%H:%M)" >> /tmp/${chatId}.md

${W}
`);
} else {
  // Local / same-machine invite
  process.stdout.write(`
${W}
 treebird-chat invite — ${agent}
${W}

 You've been invited to a treebird-chat session.
 File: ${filePath}

 Wait for messages (runs until woken):

   corrwait ${filePath} --as ${agent} --timeout 540

 When it wakes (prints JSON with reason: WAKE), reply:

   printf '[%s ${agent}] your reply\\n' "$(date +%H:%M)" >> ${filePath}

 Then run corrwait again to keep listening.
 Exit anytime — re-running corrwait picks up where you left off.

${W}
`);
}
