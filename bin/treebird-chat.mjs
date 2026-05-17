#!/usr/bin/env node
// treebird-chat <file>
// Interactive chat TUI: sends and receives flat-format messages on a shared file.
// - Identity from envoak (ENVOAK_AGENT_LABEL)
// - ACL-gated (must be allowed in <file>.access.json)
// - Atomic O_APPEND writes (concurrent-writer safe for sub-PIPE_BUF lines)
// - Live tail of incoming messages from other participants
// - Max 3 lines per send (use \\n in input to add a newline; Enter sends)
// - Exit: Ctrl-C, Ctrl-D, or `/end`

import { resolve } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { appendLines } from '../lib/writer.mjs';
import { open } from 'node:fs/promises';
import readline from 'node:readline';
import chokidar from 'chokidar';
import { verifyAgentIdentity, isValidAgentName } from '../lib/identity.mjs';
import { isAllowed, readAcl, aclPath, setAllowed } from '../lib/access.mjs';
import { FLAT_RE } from '../lib/watcher.mjs';
import { findSessionByPath, resolvePublicUrl } from '../lib/config.mjs';

const MAX_LINES = 3;
const COLORS = ['\x1b[36m', '\x1b[35m', '\x1b[33m', '\x1b[32m', '\x1b[34m', '\x1b[91m', '\x1b[95m'];
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

function colorFor(author) {
  let h = 0;
  for (let i = 0; i < author.length; i++) h = (h * 31 + author.charCodeAt(i)) | 0;
  return COLORS[Math.abs(h) % COLORS.length];
}

function nowHHMM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// args: <file> [--as <agent>]
let file = null;
let asArg = null;
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--as') asArg = argv[++i];
    else if (!argv[i].startsWith('--') && !file) file = argv[i];
  }
}
if (!file) {
  process.stderr.write('usage: treebird-chat <file> [--as <agent>]\n');
  process.exit(1);
}
const filePath = resolve(file);
if (!existsSync(filePath)) {
  process.stderr.write(`File not found: ${filePath}\n`);
  process.exit(1);
}

let identity;
try { identity = verifyAgentIdentity(asArg); }
catch (e) { process.stderr.write(`Identity check failed: ${e.message}\n`); process.exit(1); }
const { agent } = identity;

if (!readAcl(filePath)) {
  process.stderr.write(`No ACL at ${aclPath(filePath)}. Owner: treebird-chat-allow ${file} ${agent}\n`);
  process.exit(1);
}
if (!isAllowed(filePath, agent)) {
  process.stderr.write(`Agent "${agent}" not allowed on ${file}.\n`);
  process.exit(1);
}

const myColor = colorFor(agent);
process.stdout.write(`${BOLD}treebird-chat${RESET} — ${myColor}${agent}${RESET} on ${DIM}${file}${RESET}\n`);
process.stdout.write(`${DIM}Enter to send · \\n for newline (max ${MAX_LINES} lines) · /invite <agent> · /end or Ctrl-D to leave${RESET}\n\n`);

// ── tail (incoming) ────────────────────────────────────────────────────
let cursor = statSync(filePath).size;
let pump = Promise.resolve();

let lastAuthor = null;

function printLine(line) {
  const m = line.match(FLAT_RE);
  if (m) {
    const [, time, author, msg] = m;
    if (author === agent) { lastAuthor = author; return; } // suppress our own echo
    const c = colorFor(author);
    const cols = process.stdout.columns || 80;
    // Blank line between speaker changes for readability.
    const sep = (lastAuthor !== null && lastAuthor !== author) ? '\n' : '';
    lastAuthor = author;
    // Word-wrap long messages at terminal width (prefix = "HH:MM Author  ").
    const prefixLen = time.length + 1 + author.length + 2;
    const maxMsg = Math.max(20, cols - prefixLen);
    const wrapped = wordWrap(msg, maxMsg, ' '.repeat(prefixLen));
    // Clear current input line, print message, restore prompt.
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
    process.stdout.write(`${sep}${DIM}${time}${RESET} ${c}${author}${RESET}  ${wrapped}\n`);
    rl.prompt(true);
  }
}

function wordWrap(text, width, indent) {
  if (text.length <= width) return text;
  const parts = [];
  let remaining = text;
  while (remaining.length > width) {
    // Prefer breaking after a space or em-dash within the width limit.
    let cut = -1;
    for (let i = Math.min(width, remaining.length - 1); i > 0; i--) {
      const ch = remaining[i];
      if (ch === ' ' || ch === '—') { cut = i; break; }
    }
    if (cut !== -1) {
      parts.push(remaining.slice(0, cut).trimEnd());
      remaining = remaining.slice(cut).trimStart();
    } else {
      // No break point found — hard cut at width.
      parts.push(remaining.slice(0, width));
      remaining = remaining.slice(width);
    }
  }
  if (remaining) parts.push(remaining);
  return parts.join(`\n${indent}`);
}

const onChange = () => {
  pump = pump.then(async () => {
    const size = statSync(filePath).size;
    if (size < cursor) { cursor = size; return; }
    if (size === cursor) return;
    const fh = await open(filePath, 'r');
    const buf = Buffer.alloc(size - cursor);
    await fh.read(buf, 0, buf.length, cursor);
    await fh.close();
    cursor = size;
    const text = buf.toString('utf8');
    const lines = text.split('\n');
    // Last element may be partial; only print complete lines.
    for (const line of lines.slice(0, -1)) printLine(line);
  }).catch(err => {
    process.stderr.write(`[tui] tail read error: ${err.message}\n`);
    setTimeout(onChange, 250); // retry after short backoff
  });
};

const watcher = chokidar.watch(filePath, {
  usePolling: true,
  interval: 300,
  awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
});
watcher.on('add', onChange).on('change', onChange);

// ── send (outgoing) ────────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
rl.setPrompt(`${myColor}${agent}${RESET}> `);
rl.prompt();

const shutdown = async (msg) => {
  if (msg) process.stdout.write(`\n${DIM}${msg}${RESET}\n`);
  await watcher.close();
  rl.close();
  process.exit(0);
};

rl.on('line', async (raw) => {
 try {
  const text = raw.trim();
  if (!text) { rl.prompt(); return; }
  if (text === '/end') { shutdown('left chat'); return; }

  if (text.startsWith('/invite ')) {
    const invitee = text.slice(8).trim();
    if (!invitee) {
      process.stdout.write(`${DIM}usage: /invite <agent>${RESET}\n`);
      rl.prompt();
      return;
    }
    if (!isValidAgentName(invitee)) {
      process.stdout.write(`${DIM}invalid agent name "${invitee}" — letters/digits/hyphens/underscores, must start with a letter${RESET}\n`);
      rl.prompt();
      return;
    }
    setAllowed(filePath, invitee, true);
    await appendLines(filePath, agent, [`/invite ${invitee} — joined the chat`]);

    const W = '═'.repeat(56);
    const session = findSessionByPath(filePath);
    if (session?.smalltoakUrl && session?.chatId) {
      const { chatId, smalltoakUrl } = session;
      const { url: joinUrl, alternates } = resolvePublicUrl(smalltoakUrl);
      const altLine = alternates.length ? `\n    # alternates: ${alternates.join('  ')}` : '';
      process.stdout.write(`\n${W}\n treebird-chat invite — ${invitee}  [cross-machine via smalltoak]\n${W}\n\n One-time token setup (skip if already done):\n\n    mkdir -p ~/.treebird-chat\n    echo 'SMALLTOAK_TOKEN=<get from vault>' >> ~/.treebird-chat/.env\n    chmod 600 ~/.treebird-chat/.env\n\n 1. Start the bridge on your machine:\n\n    touch /tmp/${chatId}.md\n    BIRDCHAT_AGENT=${invitee} \\\n    node ~/Dev/treebird-chat/bin/treebird-chat-bridge.mjs \\\n      ${chatId} /tmp/${chatId}.md \\\n      --smalltoak-url ${joinUrl} \\\n      --as ${invitee}${altLine}\n\n 2. Watch for messages:\n\n    node ~/Dev/treebird-chat/bin/corrwait.mjs /tmp/${chatId}.md --as ${invitee} --timeout 540\n\n 3. Reply with:\n\n    printf '[%s ${invitee}] your reply\\n' "$(date +%H:%M)" >> /tmp/${chatId}.md\n\n${W}\n\n`);
    } else {
      process.stdout.write(`\n${W}\n treebird-chat invite — ${invitee}\n${W}\n\n File: ${filePath}\n\n Wait for messages:\n\n   corrwait ${filePath} --as ${invitee} --timeout 540\n\n When woken, reply:\n\n   printf '[%s ${invitee}] your reply\\n' "$(date +%H:%M)" >> ${filePath}\n\n${W}\n\n`);
    }
    rl.prompt();
    return;
  }

  // \n in input → real newlines. Enforce 3-line max.
  const lines = text.replace(/\\n/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length > MAX_LINES) {
    process.stdout.write(`${DIM}message exceeds ${MAX_LINES} lines — not sent${RESET}\n`);
    rl.prompt();
    return;
  }

  await appendLines(filePath, agent, lines);
  rl.prompt();
 } catch (err) {
  process.stderr.write(`[tui] send error: ${err.message}\n`);
  rl.prompt();
 }
});

rl.on('close', () => shutdown('left chat'));
process.on('SIGINT', () => shutdown('left chat'));
