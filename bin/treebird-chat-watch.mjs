#!/usr/bin/env node
// treebird-chat-watch — register chat files and scan for @mentions
//
// Commands:
//   add <file>          Register file; sets cursor to current EOF (no catchup)
//   add <file> --from 0 Register file; sets cursor to 0 (full catchup)
//   remove <file>       Unregister file
//   mute                Suppress @mention notifications for this agent
//   unmute              Restore @mention notifications
//   status              Show registered files + cursor positions
//   scan-and-drain      Scan registered files, print mentions, advance cursors
//                       Exits 0 with no output if nothing new or agent is muted.
//                       Accepts optional agent label as first arg (for hook use).

import { resolve } from 'node:path';
import { homedir } from 'node:os';
import * as watchlist from '../lib/watchlist.mjs';
import { scanForMentions, readLines, shortName } from '../lib/mention-scanner.mjs';

const [,, cmd, ...args] = process.argv;

switch (cmd) {
  case 'add': {
    const filePath = resolveFile(args.find(a => !a.startsWith('-')));
    const agentLabel = requireAgent();
    const fromBeginning = args.includes('--from') && args[args.indexOf('--from') + 1] === '0'
      || args.includes('--from=0');
    const lines = readLines(filePath);
    const cursor = fromBeginning ? 0 : lines.length;
    watchlist.addFile(agentLabel, filePath, cursor);
    console.log(`watching ${filePath} for @${shortName(agentLabel)} (cursor=${cursor})`);
    break;
  }
  case 'remove': {
    const filePath = resolveFile(args[0]);
    const agentLabel = requireAgent();
    watchlist.removeFile(agentLabel, filePath);
    console.log(`removed ${filePath}`);
    break;
  }
  case 'mute': {
    const agentLabel = requireAgent();
    watchlist.setMuted(agentLabel, true);
    console.log(`muted @mention notifications for ${agentLabel}`);
    break;
  }
  case 'unmute': {
    const agentLabel = requireAgent();
    watchlist.setMuted(agentLabel, false);
    console.log(`unmuted @mention notifications for ${agentLabel}`);
    break;
  }
  case 'status': {
    const agentLabel = requireAgent();
    const agent = watchlist.getAgent(agentLabel);
    const files = Object.entries(agent.files ?? {});
    console.log(`agent:  ${agentLabel}`);
    console.log(`muted:  ${agent.muted}`);
    if (files.length === 0) {
      console.log('files:  (none)');
    } else {
      console.log('files:');
      for (const [f, { cursor }] of files) {
        const lines = readLines(f);
        const rel = f.replace(homedir(), '~');
        console.log(`  ${rel}  cursor=${cursor}/${lines.length}`);
      }
    }
    break;
  }
  case 'scan-and-drain': {
    // Optional positional arg overrides env identity (used by hook)
    const agentLabel = requireAgent(args[0]);
    const agent = watchlist.getAgent(agentLabel);
    if (agent.muted) break;

    const hits = [];
    for (const [filePath, { cursor }] of Object.entries(agent.files ?? {})) {
      const lines = readLines(filePath);
      const { mentions, newCursor } = scanForMentions(lines, agentLabel, cursor);
      watchlist.updateCursor(agentLabel, filePath, newCursor);
      if (mentions.length > 0) hits.push({ filePath, mentions });
    }

    if (hits.length === 0) break;

    const out = ['📬 treebird-chat — unread @mentions:'];
    for (const { filePath, mentions } of hits) {
      out.push(`\n  ${filePath.replace(homedir(), '~')}`);
      for (const { time, author, text } of mentions) {
        out.push(`  [${time} ${author}] ${text}`);
      }
    }
    out.push('\nReply: printf \'[%s <agent>] ...\n\' "$(date +%H:%M)" >> <file>');
    console.log(out.join('\n'));
    break;
  }
  default: {
    const cmds = 'add | remove | mute | unmute | status | scan-and-drain';
    console.error(`usage: treebird-chat-watch <${cmds}> [args]`);
    process.exit(1);
  }
}

function requireAgent(label) {
  const a = label
    || process.env.ENVOAK_AGENT_LABEL
    || process.env.BIRDCHAT_AGENT;
  if (!a) {
    console.error('error: no agent identity — set ENVOAK_AGENT_LABEL or BIRDCHAT_AGENT');
    process.exit(4);
  }
  return a;
}

function resolveFile(p) {
  if (!p) { console.error('error: file path required'); process.exit(1); }
  return resolve(p);
}
