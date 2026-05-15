#!/usr/bin/env node
// treebird-chat-session — create and join a new treebird-chat session
//
// Usage:
//   treebird-chat-session                          # new session, no agents
//   treebird-chat-session --invite yosef --invite gemma
//   treebird-chat-session --name review --invite watsan
//   treebird-chat-session --join                   # create + open TUI immediately
//   treebird-chat-session --dir /path/to/dir       # override default location
//
// Default dir: $TREEBIRD_COLLAB_DIR or ~/collab
// File name:   CONSORTIUM_<name>_<YYYY-MM-DD>.md
// Owner:       treebird (override with --owner)
//
// If --invite gemma is given, starts gemma-bridge as a detached subprocess.

import { resolve, dirname } from 'node:path';
import { existsSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import { spawnEnv } from '../lib/config.mjs';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const ALLOW_BIN  = resolve(__dirname, 'treebird-chat-allow.mjs');
const CHAT_BIN   = resolve(__dirname, 'treebird-chat.mjs');
const GEMMA_BIN  = resolve(__dirname, 'gemma-bridge.mjs');
const DEFAULT_DIR = process.env.TREEBIRD_COLLAB_DIR
  ? resolve(process.env.TREEBIRD_COLLAB_DIR)
  : resolve(process.env.HOME, 'collab');

// ── Args ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { name: null, invites: [], owner: 'treebird', dir: DEFAULT_DIR, join: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if      (a === '--name')    args.name  = argv[++i];
    else if (a === '--invite')  args.invites.push(argv[++i]);
    else if (a === '--owner')   args.owner = argv[++i];
    else if (a === '--dir')     args.dir   = resolve(argv[++i]);
    else if (a === '--join')    args.join  = true;
  }
  return args;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function today() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function nowHHMM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function allow(filePath, agent, owner) {
  const result = spawnSync(process.execPath, [ALLOW_BIN, filePath, agent, '--owner', owner], {
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    process.stderr.write(`  ⚠️  allow failed for ${agent}\n`);
  }
}

function startGemmaBridge(filePath) {
  const child = spawn(process.execPath, [GEMMA_BIN, filePath], {
    stdio: ['ignore', 'ignore', 'inherit'],
    detached: true,
    env: spawnEnv(),
  });
  child.on('error', (err) => process.stderr.write(`  ⚠️  gemma-bridge failed to start: ${err.message}\n`));
  child.unref();
  return child.pid;
}

// Strip path separators / traversal from a user-supplied name before it
// becomes part of a filename.
function safeFileSegment(s) {
  return String(s).replace(/[^\w.-]+/g, '_').replace(/^\.+/, '_') || 'session';
}

// ── Main ──────────────────────────────────────────────────────────────────────

const { name, invites, owner, dir, join } = parseArgs(process.argv.slice(2));

const sessionName = name || today();
const fileName    = `CONSORTIUM_${safeFileSegment(sessionName)}_${today()}.md`;
const filePath    = resolve(dir, fileName);

// Create dir + file
mkdirSync(dir, { recursive: true });
if (!existsSync(filePath)) {
  writeFileSync(filePath, `# ${fileName.replace('.md', '')}\n\n`, 'utf8');
}

process.stdout.write(`\n📄 Session: ${filePath}\n\n`);

// Allow owner
allow(filePath, owner, owner);

// Allow + optionally start bridge for each invited agent
let gemmaStarted = false;
for (const agent of invites) {
  allow(filePath, agent, owner);
  if (agent === 'gemma' && !gemmaStarted) {
    const pid = startGemmaBridge(filePath);
    process.stdout.write(`🤖 gemma-bridge started (PID ${pid})\n`);
    gemmaStarted = true;
  }
}

// Post session-open message
const agentList = invites.length ? invites.join(', ') : 'none';
appendFileSync(
  filePath,
  `[${nowHHMM()} ${owner}] session open — invited: ${agentList}\n`
);

// Print the export for easy copy-paste
process.stdout.write(`\nexport CHAT=${filePath}\n`);
process.stdout.write(`\nJoin:  node ${CHAT_BIN} $CHAT\n`);
if (invites.includes('gemma')) {
  process.stdout.write(`Gemma: already running. Say @gemma in chat to talk to it.\n`);
}
process.stdout.write('\n');

// Optionally exec into TUI
if (join) {
  process.stdout.write('Opening TUI...\n\n');
  const result = spawnSync(process.execPath, [CHAT_BIN, filePath], { stdio: 'inherit' });
  process.exit(result.status ?? 0);
}
