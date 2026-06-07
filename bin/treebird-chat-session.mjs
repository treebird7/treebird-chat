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
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import { spawnEnv, saveSession } from '../lib/config.mjs';
import { resolveIdentity } from '../lib/identity.mjs';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const ALLOW_BIN  = resolve(__dirname, 'treebird-chat-allow.mjs');
const CHAT_BIN   = resolve(__dirname, 'treebird-chat.mjs');
const GEMMA_BIN  = resolve(__dirname, 'gemma-bridge.mjs');
const DEFAULT_DIR = process.env.TREEBIRD_COLLAB_DIR
  ? resolve(process.env.TREEBIRD_COLLAB_DIR)
  : resolve(process.env.HOME, 'collab');

// ── Args ──────────────────────────────────────────────────────────────────────

const USAGE = `treebird-chat-session — create a session file, set owner + ACL, print join commands

usage: treebird-chat-session [--name <topic>] [--owner <agent>] [--dir <path>]
                             [--invite <agent>]... [--join]

  --name <topic>    session topic (default: today's date). File: CONSORTIUM_<name>_<date>.md
  --owner <agent>   room owner (default: your envoak identity, else 'treebird')
  --dir <path>      output dir (default: $TREEBIRD_COLLAB_DIR or ~/collab)
  --invite <agent>  allow an agent in the ACL (repeatable)
  --join            open the TUI immediately after creating
  --help, -h        show this help
`;

function parseArgs(argv) {
  if (argv.some((a) => a === '--help' || a === '-h')) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  const args = { name: null, invites: [], owner: null, dir: DEFAULT_DIR, join: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if      (a === '--name')    args.name  = argv[++i];
    else if (a === '--invite')  args.invites.push(argv[++i]);
    else if (a === '--owner')   args.owner = argv[++i];
    else if (a === '--dir')     args.dir   = resolve(argv[++i]);
    else if (a === '--join')    args.join  = true;
    else {
      // Reject unknown flags instead of silently ignoring them — previously
      // `treebird-chat-session --help` (and any typo'd flag) fell through and
      // created a real session.
      process.stderr.write(`unknown argument: ${a}\n\n${USAGE}`);
      process.exit(2);
    }
  }
  return args;
}

// Resolve the room owner. Prefer an explicit --owner; otherwise derive from the
// running envoak identity so a room isn't silently owned by a phantom default.
// Falls back to 'treebird' only when no identity is set at all (the historical
// default). Returns { owner, verified } so the caller can warn on unverified.
function resolveOwner(explicit) {
  if (explicit) return { owner: explicit, verified: false, explicit: true };
  const id = resolveIdentity();
  if (id) return { owner: id.agent, verified: id.verified, explicit: false };
  return { owner: 'treebird', verified: false, explicit: false };
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

// Best-effort primary LAN IPv4, for the cross-machine join hint. Skips
// link-local (169.254.x, self-assigned — not routable) and prefers a real
// private-range address so a remote machine has a host it can actually reach.
function lanIps() {
  const candidates = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) {
        candidates.push(a.address);
      }
    }
  }
  const isPrivate = (ip) =>
    ip.startsWith('192.168.') || ip.startsWith('10.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
  // Private addresses first (more likely the LAN the remote shares), then rest.
  const ordered = [...candidates.filter(isPrivate), ...candidates.filter(ip => !isPrivate(ip))];
  return ordered.length ? ordered : ['<this-host-ip>'];
}

// Strip path separators / traversal from a user-supplied name before it
// becomes part of a filename.
function safeFileSegment(s) {
  return String(s).replace(/[^\w.-]+/g, '_').replace(/^\.+/, '_') || 'session';
}

// ── Main ──────────────────────────────────────────────────────────────────────

const { name, invites, owner: ownerArg, dir, join } = parseArgs(process.argv.slice(2));

const { owner, verified: ownerVerified, explicit: ownerExplicit } = resolveOwner(ownerArg);

const sessionName = name || today();
const fileName    = `CONSORTIUM_${safeFileSegment(sessionName)}_${today()}.md`;
const filePath    = resolve(dir, fileName);
// chat-id = filename without `.md` — DETERMINISTIC from the file, so every
// machine derives the SAME id. A slug-vs-filename split (slug `flow-carte-blanche`
// vs filename `FLOW_carte-blanche_2026-06-07`) caused a cross-machine silence on
// 2026-06-07; deriving from the filename matches what a filename-keyed client
// (e.g. the obsidian plugin) computes, so the two can't drift.
const chatId      = fileName.replace(/\.md$/, '');

// Create dir + file
mkdirSync(dir, { recursive: true });
if (!existsSync(filePath)) {
  writeFileSync(filePath, `# ${fileName.replace('.md', '')}\n\n`, 'utf8');
}

// Register chat-id → file path so `treebird-chat-join <chat-id>` (and the bridge)
// resolve THIS file instead of an orphan /tmp mirror. The chat-id is the same
// safeFileSegment used for the bridge + remote-join hint below, so a remote
// joiner who runs `trbc join <chat-id>` lands on the real registered file.
saveSession(chatId, { filePath });

process.stdout.write(`\n📄 Session: ${filePath}\n`);
process.stdout.write(`   chat-id: ${chatId}  (registered → join with: trbc join ${chatId} --as <name>)\n`);
process.stdout.write(`   Owner: ${owner}${ownerVerified ? ' (envoak-verified)' : ' (unverified)'}\n\n`);
if (!ownerVerified) {
  process.stdout.write(
    ownerExplicit
      ? `⚠️  Owner "${owner}" was set explicitly and is not envoak-verified. Names are unverified and impersonable; the ACL is the only gate.\n\n`
      : `⚠️  No envoak identity found — owner defaulted to "${owner}" (unverified). Run \`envoak identity pull --export\` first for a verified owner.\n\n`
  );
}

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
process.stdout.write(`\nJoin (this machine):  node ${CHAT_BIN} $CHAT\n`);
if (invites.includes('gemma')) {
  process.stdout.write(`Gemma: already running. Say @gemma in chat to talk to it.\n`);
}

// Cross-machine: creating a session does NOT auto-register it with smalltoak.
// Surface the two-step bridge → remote-join flow so it isn't a hidden gotcha.
const ips = lanIps();
const hostUrl = `http://${ips[0]}:3000`;
process.stdout.write(
  `\nJoin from ANOTHER machine (e.g. an agent on m2):\n` +
  `  1. here (host):    treebird-chat-bridge ${chatId} $CHAT --smalltoak-url ${hostUrl}\n` +
  `  2. there (remote): treebird-chat-join ${chatId} --smalltoak-url ${hostUrl} --as <agent>\n`
);
if (ips.length > 1) {
  process.stdout.write(`  # if the remote can't connect, try an alt host IP (same-subnet): ${ips.slice(1).map(ip => `http://${ip}:3000`).join('  ')}\n`);
}
process.stdout.write('\n');

// Optionally exec into TUI
if (join) {
  process.stdout.write('Opening TUI...\n\n');
  const result = spawnSync(process.execPath, [CHAT_BIN, filePath], { stdio: 'inherit' });
  process.exit(result.status ?? 0);
}
