#!/usr/bin/env node
// treebird-chat <file>
// Interactive chat TUI: sends and receives flat-format messages on a shared file.
// - Identity from envoak (ENVOAK_AGENT_LABEL)
// - ACL-gated (must be allowed in <file>.access.json)
// - Atomic O_APPEND writes (concurrent-writer safe for sub-PIPE_BUF lines)
// - Live tail of incoming messages from other participants
// - Max 3 lines per send (use \\n in input to add a newline; Enter sends)
// - Exit: Ctrl-C, Ctrl-D, or `/end`

import { resolve, basename, extname } from 'node:path';
import { existsSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { appendLines } from '../lib/writer.mjs';
import { open } from 'node:fs/promises';
import readline from 'node:readline';
import chokidar from 'chokidar';
import { verifyAgentIdentity, isValidAgentName } from '../lib/identity.mjs';
import { isAllowed, readAcl, aclPath, setAllowed } from '../lib/access.mjs';
import { FLAT_RE } from '../lib/watcher.mjs';
import { findSessionByPath, resolvePublicUrl } from '../lib/config.mjs';
import { resolveLink, parseLinks } from '../lib/wikilink.mjs';

const MAX_LINES = 3;
const COLORS = ['\x1b[36m', '\x1b[35m', '\x1b[33m', '\x1b[32m', '\x1b[34m', '\x1b[91m', '\x1b[95m'];
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const CYAN = '\x1b[36m';
const PREVIEW_LINES = 20;

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
process.stdout.write(`${DIM}Enter to send · \\n for newline (max ${MAX_LINES} lines) · /sub <topic> · /subs · /preview <target> · /open <target> · /invite <agent> · /end${RESET}\n\n`);

// ── tail (incoming) ────────────────────────────────────────────────────
let cursor = statSync(filePath).size;
let pump = Promise.resolve();

let lastAuthor = null;

// Highlight [[wikilinks]] in cyan in any message text.
function highlightLinks(text) {
  return text.replace(/\[\[([^\]]+?)\]\]/g, `${CYAN}[[$1]]${RESET}`);
}

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
    const wrapped = wordWrap(highlightLinks(msg), maxMsg, ' '.repeat(prefixLen));
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

// ── .subs.json sidecar helpers ─────────────────────────────────────────
function subsPath(chatFile) { return `${chatFile}.subs.json`; }

function readSubs(chatFile) {
  const p = subsPath(chatFile);
  if (!existsSync(p)) return [];
  try { return JSON.parse(readFileSync(p, 'utf8')).subs ?? []; }
  catch { return []; }
}

function writeSubs(chatFile, subs) {
  writeFileSync(subsPath(chatFile), JSON.stringify({ subs }, null, 2) + '\n');
}

function addSub(chatFile, entry) {
  const subs = readSubs(chatFile).filter(s => s.file !== entry.file);
  writeSubs(chatFile, [...subs, entry]);
}

// ── TUI output helpers ─────────────────────────────────────────────────
function printBox(lines) {
  const W = '─'.repeat(56);
  readline.cursorTo(process.stdout, 0);
  process.stdout.write(`\n${DIM}${W}${RESET}\n`);
  for (const l of lines) process.stdout.write(` ${l}\n`);
  process.stdout.write(`${DIM}${W}${RESET}\n\n`);
}

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
      const altNote = alternates.length ? `\n    # alt: ${alternates.join('  ')}` : '';
      process.stdout.write(`\n${W}\n treebird-chat invite — ${invitee}  [cross-machine]\n${W}\n\n One-time token setup (skip if already done):\n\n    mkdir -p ~/.treebird-chat && chmod 700 ~/.treebird-chat\n    printf 'SMALLTOAK_TOKEN=%s\\n' \\\n      "$(envoak vault get treebird-chat SMALLTOAK_TOKEN)" \\\n      >> ~/.treebird-chat/.env\n    chmod 600 ~/.treebird-chat/.env\n\n Join:\n\n    node ~/Dev/treebird-chat/bin/treebird-chat-join.mjs \\\n      ${chatId} \\\n      --smalltoak-url ${joinUrl} \\\n      --as ${invitee}${altNote}\n\n Add --tui for the interactive chat interface.\n\n${W}\n\n`);
    } else {
      process.stdout.write(`\n${W}\n treebird-chat invite — ${invitee}\n${W}\n\n File: ${filePath}\n\n Wait for messages:\n\n   corrwait ${filePath} --as ${invitee} --timeout 540\n\n When woken, reply:\n\n   printf '[%s ${invitee}] your reply\\n' "$(date +%H:%M)" >> ${filePath}\n\n${W}\n\n`);
    }
    rl.prompt();
    return;
  }

  // ── /sub <topic> [--invite agent1,agent2] ──────────────────────────
  if (text.startsWith('/sub ') || text === '/sub') {
    const parts = text.slice(5).trim();
    if (!parts) {
      process.stdout.write(`${DIM}usage: /sub <topic> [--invite agent1,agent2]${RESET}\n`);
      rl.prompt(); return;
    }
    // Parse optional --invite flag
    const inviteMatch = parts.match(/^(.*?)\s+--invite\s+(.+)$/);
    const topic = (inviteMatch ? inviteMatch[1] : parts).trim().replace(/\s+/g, '-');
    const extraAgents = inviteMatch ? inviteMatch[2].split(',').map(a => a.trim()).filter(Boolean) : [];

    const resolved = resolveLink(`sub:${topic}`, { from: filePath, workspaceRoots: [] });
    const subFile = resolved.path;

    if (!resolved.proposed && existsSync(subFile)) {
      // Sub already exists — post a join pointer and tell user how to open it
      const label = basename(subFile, extname(subFile));
      await appendLines(filePath, agent, [`joining [[${label}]]`]);
      printBox([
        `${BOLD}sub-chat${RESET}: ${DIM}${subFile}${RESET}`,
        `${DIM}already exists — open in a new pane:${RESET}`,
        `  treebird-chat ${subFile} --as ${agent}`,
      ]);
      rl.prompt(); return;
    }

    // Create sub file with parent pointer header
    const parentLabel = basename(filePath, extname(filePath));
    writeFileSync(subFile, `<!-- sub of: [[${parentLabel}]] -->\n`);

    // Inherit parent ACL + add extra invitees
    const parentAcl = readAcl(filePath);
    const acl = { owner: agent, agents: {} };
    if (parentAcl?.agents) {
      for (const [a, v] of Object.entries(parentAcl.agents)) {
        if (v.allowed) acl.agents[a] = { allowed: true, joined_at: new Date().toISOString() };
      }
    }
    acl.agents[agent] = { allowed: true, joined_at: new Date().toISOString() };
    for (const a of extraAgents) {
      if (isValidAgentName(a)) acl.agents[a] = { allowed: true, joined_at: new Date().toISOString() };
    }
    writeFileSync(`${subFile}.access.json`, JSON.stringify(acl, null, 2) + '\n');

    // Register in parent .subs.json
    addSub(filePath, {
      id: topic,
      file: subFile,
      topic,
      participants: Object.keys(acl.agents),
      openedAt: nowHHMM(),
      openedBy: agent,
      status: 'active',
    });

    // Post pointer into parent chat
    const subLabel = basename(subFile, extname(subFile));
    await appendLines(filePath, agent, [`/sub ${topic} → [[${subLabel}]]`]);

    printBox([
      `${BOLD}sub-chat created${RESET}: ${DIM}${subFile}${RESET}`,
      `${DIM}open in a new pane:${RESET}`,
      `  treebird-chat ${subFile} --as ${agent}`,
      ...(extraAgents.length ? [`${DIM}invited: ${extraAgents.join(', ')}${RESET}`] : []),
    ]);
    rl.prompt(); return;
  }

  // ── /subs ──────────────────────────────────────────────────────────
  if (text === '/subs') {
    const subs = readSubs(filePath);
    if (!subs.length) {
      process.stdout.write(`${DIM}no sub-chats for this session${RESET}\n`);
    } else {
      process.stdout.write(`\n`);
      for (const s of subs) {
        const active = s.status === 'active' ? `${CYAN}● active${RESET}` : `${DIM}○ closed${RESET}`;
        process.stdout.write(` ${active}  ${BOLD}${s.topic}${RESET}  ${DIM}${s.openedAt} by ${s.openedBy}${RESET}\n`);
        process.stdout.write(`        ${DIM}${s.file}${RESET}\n`);
      }
      process.stdout.write('\n');
    }
    rl.prompt(); return;
  }

  // ── /preview <target> ──────────────────────────────────────────────
  if (text.startsWith('/preview ')) {
    const target = text.slice(9).trim();
    const resolved = resolveLink(target, { from: filePath });
    if (!resolved.path || resolved.type === 'missing') {
      process.stdout.write(`${DIM}not found: ${target}${RESET}\n`);
      rl.prompt(); return;
    }
    try {
      const content = readFileSync(resolved.path, 'utf8');
      const lines = content.split('\n').slice(0, PREVIEW_LINES);
      const label = basename(resolved.path);
      const activeTag = resolved.active ? ` ${CYAN}● live${RESET}` : '';
      printBox([
        `${BOLD}${label}${RESET}${activeTag}  ${DIM}[${resolved.type}]${RESET}`,
        `${DIM}${'─'.repeat(52)}${RESET}`,
        ...lines.map(l => `${DIM}${highlightLinks(l)}${RESET}`),
        ...(content.split('\n').length > PREVIEW_LINES ? [`${DIM}… (${content.split('\n').length} lines total)${RESET}`] : []),
      ]);
    } catch {
      process.stdout.write(`${DIM}could not read: ${resolved.path}${RESET}\n`);
    }
    rl.prompt(); return;
  }

  // ── /open <target> ─────────────────────────────────────────────────
  if (text.startsWith('/open ')) {
    const target = text.slice(6).trim();
    const resolved = resolveLink(target, { from: filePath });
    if (!resolved.path || resolved.type === 'missing') {
      process.stdout.write(`${DIM}not found: ${target}${RESET}\n`);
      rl.prompt(); return;
    }
    const pager = process.env.PAGER || 'less';
    process.stdout.write(`${DIM}opening in ${pager} — q to return${RESET}\n`);
    rl.pause();
    const { spawn } = await import('node:child_process');
    const child = spawn(pager, [resolved.path], { stdio: 'inherit' });
    child.on('exit', () => { rl.resume(); rl.prompt(); });
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
