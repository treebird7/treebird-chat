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
import { readSubs, addSub, closeSubInParent } from '../lib/subs.mjs';
import { readInviterCert, composeRemoteInvite, composeLocalInvite } from '../lib/invite-block.mjs';
import { autoStageSub } from '../lib/sub-git.mjs';
import { spawnSubBridge } from '../lib/sub-bridge.mjs';

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

// args: <file> [--as <agent>] [--parent <parent-chat-file>]
let file = null;
let asArg = null;
let parentFile = null;
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--as') asArg = argv[++i];
    else if (argv[i] === '--parent') parentFile = argv[++i];
    else if (!argv[i].startsWith('--') && !file) file = argv[i];
  }
  if (parentFile) parentFile = resolve(parentFile);
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

// Print the last N protocol lines as history before entering tail mode.
{
  const HISTORY_LINES = 30;
  try {
    const raw = readFileSync(filePath, 'utf8');
    const all = raw.split('\n').filter(l => FLAT_RE.test(l));
    const recent = all.slice(-HISTORY_LINES);
    if (recent.length) {
      process.stdout.write(`${DIM}── history (last ${recent.length}) ──────────────────${RESET}\n`);
      for (const line of recent) {
        const m = line.match(FLAT_RE);
        if (!m) continue;
        const [, time, author, msg] = m;
        const c = colorFor(author);
        const cols = process.stdout.columns || 80;
        const prefixLen = time.length + 1 + author.length + 2;
        const maxMsg = Math.max(20, cols - prefixLen);
        const wrapped = highlightLinks(wordWrap(msg, maxMsg, ' '.repeat(prefixLen)));
        if (lastAuthor !== null && lastAuthor !== author) process.stdout.write('\n');
        lastAuthor = author;
        process.stdout.write(`${DIM}${time}${RESET} ${c}${author}${RESET}  ${wrapped}\n`);
      }
      process.stdout.write(`${DIM}── live ─────────────────────────────────────────${RESET}\n\n`);
      lastAuthor = null;
    }
  } catch { /* ignore — tail still works */ }
}

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
    const wrapped = highlightLinks(wordWrap(msg, maxMsg, ' '.repeat(prefixLen)));
    // Clear current input line, print message, restore prompt.
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
    process.stdout.write(`${sep}${DIM}${time}${RESET} ${c}${author}${RESET}  ${wrapped}\n`);
    rl.prompt(true);
  }
}

// Word-wrap PLAIN text only. highlightLinks() must be applied to the RESULT,
// never the input: wrapping text that already contains ANSI escapes miscounts
// the width (escape bytes inflate .length) and can slice through an escape
// sequence — the terminal then eats the malformed sequence plus the characters
// after it, which looks exactly like the message being truncated.
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

// (subs management imported from ../lib/subs.mjs)

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

  // ── /close [summary] ───────────────────────────────────────────────
  if (text.startsWith('/close') && (text === '/close' || text[6] === ' ')) {
    const summary = text.slice(6).trim() || null;
    if (parentFile) {
      await closeSubInParent(parentFile, filePath, summary, agent);
      process.stdout.write(`${DIM}summary posted to parent — closing${RESET}\n`);
    } else {
      process.stdout.write(`${DIM}no --parent set; use /end to leave, or reopen with --parent <file>${RESET}\n`);
      rl.prompt(); return;
    }
    shutdown('sub closed');
    return;
  }

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

    const session = findSessionByPath(filePath);
    if (session?.smalltoakUrl && session?.chatId) {
      const { chatId, smalltoakUrl } = session;
      const { url: joinUrl, alternates } = resolvePublicUrl(smalltoakUrl);
      const cert = readInviterCert();
      if (joinUrl.startsWith('https://') && !cert) {
        // Same fail-closed reasoning as the standalone invite CLI — never
        // emit an https:// invite without a pin block.
        process.stdout.write(`${DIM}cannot emit https:// invite: no SMALLTOAK_CERT in env. ` +
          `Start treebird-chat with SMALLTOAK_CERT set to the server's cert path.${RESET}\n`);
      } else {
        process.stdout.write(composeRemoteInvite({
          chatId, joinUrl, invitee, alternates, cert,
        }));
        process.stdout.write('\n');
      }
    } else {
      process.stdout.write(composeLocalInvite({ invitee, filePath }));
      process.stdout.write('\n');
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
    const rawTopic = (inviteMatch ? inviteMatch[1] : parts).trim();
    const extraAgents = inviteMatch ? inviteMatch[2].split(',').map(a => a.trim()).filter(Boolean) : [];

    // Reject path-like args — user probably pasted a file path meaning /open
    if (rawTopic.includes('/') || rawTopic.startsWith('~') || rawTopic.startsWith('.') ||
        rawTopic.endsWith('.md') || rawTopic.length > 48) {
      process.stdout.write(`${BOLD}/sub${RESET} expects a short slug (e.g. "run-3"), not a path.\n`);
      process.stdout.write(`${DIM}To open an existing sub: /open <name>${RESET}\n`);
      rl.prompt(); return;
    }
    const topic = rawTopic.replace(/\s+/g, '-');

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
    // 0o600 on the ACL — leaks who has access to the sub. Matches the
    // access.mjs writeAcl posture. (/ts-review permissions_hygiene #2.)
    writeFileSync(`${subFile}.access.json`, JSON.stringify(acl, null, 2) + '\n', { mode: 0o600 });

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

    // P2.1: auto-stage the new sub + ACL. No commit, no push — explicit user
    // action. Best-effort: failure does not abort sub creation.
    const stage = autoStageSub(subFile);

    // P2.1: spawn the sub-↔-smalltoak bridge so peer machines can join the
    // sub via `treebird-chat-join <sub-chat-id> --as <agent>` immediately.
    const bridge = await spawnSubBridge({
      parentFile: filePath, subFile, subTopic: topic, agent,
    });

    // Announce the bridge state inside the sub file as a single line, so an
    // agent reading the sub knows whether they're in a relayed or local-only
    // room without grepping logs.
    if (bridge.spawned) {
      await appendLines(subFile, 'system', [
        `bridge live — chat-id=${bridge.chatId} pid=${bridge.pid}${bridge.attached ? ' (attached existing)' : ''}`,
      ]);
    }

    printBox([
      `${BOLD}sub-chat created${RESET}: ${DIM}${subFile}${RESET}`,
      `${DIM}git: ${stage.staged ? `staged ${stage.files?.length ?? 0} file(s)` : stage.reason}${RESET}`,
      `${DIM}bridge: ${bridge.spawned
        ? `${bridge.chatId} (pid ${bridge.pid}${bridge.attached ? ', attached' : ', new'})`
        : bridge.reason}${RESET}`,
      `${DIM}open in a new pane:${RESET}`,
      `  treebird-chat ${subFile} --as ${agent}`,
      ...(bridge.spawned ? [`${DIM}or from another machine:${RESET}`, `  treebird-chat-join ${bridge.chatId} --as <agent>`] : []),
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
    let resolved = resolveLink(target, { from: filePath });
    // Fallback: try sub:<target> if plain lookup misses (common case: /open device-link)
    if ((!resolved.path || resolved.type === 'missing') && !target.includes(':')) {
      resolved = resolveLink(`sub:${target}`, { from: filePath, workspaceRoots: [] });
    }
    if (!resolved.path || resolved.type === 'missing') {
      process.stdout.write(`${DIM}not found: ${target}${RESET}\n`);
      rl.prompt(); return;
    }
    // Sub-collabs: show join command instead of opening in a pager
    if (resolved.type === 'sub') {
      printBox([
        `${BOLD}sub-chat${RESET}: ${DIM}${resolved.path}${RESET}`,
        `${DIM}open in a new terminal pane:${RESET}`,
        `  treebird-chat ${resolved.path} --as ${agent}`,
      ]);
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
