// Shared config loader — reads .env files and session registry.
// Priority: process.env > local .env > ~/.treebird-chat/.env
//
// This lets users without envoak set SMALLTOAK_TOKEN etc in a plain .env file.

import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir, networkInterfaces } from 'node:os';

const SESSIONS_FILE = resolve(homedir(), '.treebird-chat', 'sessions.json');

// Base env vars safe to hand to any spawned child. Bridges are network-facing,
// so never spread process.env into them — that leaks vault keys, TOAK/OpenAI
// tokens, etc. Callers pass exactly the extra vars their bridge needs.
const SPAWN_ENV_BASE_KEYS = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR'];

export function spawnEnv(extras = {}) {
  const env = {};
  for (const key of SPAWN_ENV_BASE_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(extras)) {
    if (value !== undefined && value !== null) env[key] = String(value);
  }
  return env;
}

// Load a .env file into process.env (does not overwrite existing values).
function loadEnvFile(path) {
  if (!existsSync(path)) return;
  const lines = readFileSync(path, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = val;
  }
}

// Load env from local .env then ~/.treebird-chat/.env (neither overwrites existing).
export function loadEnv() {
  loadEnvFile(resolve(process.cwd(), '.env'));
  loadEnvFile(resolve(homedir(), '.treebird-chat', '.env'));
}

// ── Session registry ──────────────────────────────────────────────────────────

function readSessions() {
  if (!existsSync(SESSIONS_FILE)) return {};
  try { return JSON.parse(readFileSync(SESSIONS_FILE, 'utf8')); }
  catch { return {}; }
}

function writeSessions(sessions) {
  // 0o600 — the registry stores smalltoakToken; must not be world-readable.
  mkdirSync(dirname(SESSIONS_FILE), { recursive: true, mode: 0o700 });
  writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2) + '\n', { mode: 0o600 });
  // writeFileSync's mode only applies on creation — re-assert for pre-existing files.
  chmodSync(SESSIONS_FILE, 0o600);
}

export function saveSession(chatId, config) {
  const sessions = readSessions();
  sessions[chatId] = { ...config, updated_at: new Date().toISOString() };
  writeSessions(sessions);
}

export function loadSession(chatId) {
  return readSessions()[chatId] || null;
}

export function listSessions() {
  return readSessions();
}

// Find a session by its file path (for TUI /invite — TUI knows path not chat-id).
export function findSessionByPath(filePath) {
  const sessions = readSessions();
  return Object.entries(sessions).find(([, s]) => s.filePath === filePath)?.[1] || null;
}

// Resolve the mirror file path treebird-chat-join should bridge against.
// Closes issue #6 P2 — without this, join always created /tmp/<chatId>.md and
// the canonical canopy file the wizard registered was silently ignored (the
// 2026-05-20 nightjar incident).
//
// Returns { mirrorFile, source, warning }:
//   source='registered' — chat-id is in sessions.json with a filePath
//   source='tmp'         — fallback for unregistered chat-ids (remote invites,
//                          ad-hoc joins). warning is non-null in this case so
//                          the operator sees that they're in an orphan mirror.
//
// `sessions` arg lets tests inject a registry without writing to disk.
export function resolveMirrorFile(chatId, { sessions = null, tmpDir = '/tmp' } = {}) {
  const registry = sessions ?? readSessions();
  const registered = registry[chatId];
  if (registered?.filePath) {
    return { mirrorFile: registered.filePath, source: 'registered', warning: null };
  }
  return {
    mirrorFile: `${tmpDir}/${chatId}.md`,
    source: 'tmp',
    warning:
      `chat-id "${chatId}" not registered in ~/.treebird-chat/sessions.json — ` +
      `using a /tmp mirror. Messages posted to this file will sync to smalltoak ` +
      `via the bridge, but the file itself is orphan from any canonical canopy ` +
      `doc. Run \`treebird-chat-wizard\` on the host machine to register.`,
  };
}

// ── Cross-machine URL resolution ───────────────────────────────────────────────

// All non-internal, routable IPv4 addresses of this host. 169.254.x.x
// (link-local / APIPA) is excluded — it's a no-DHCP fallback, not reachable.
// The Treebird Thunderbolt link uses 192.168.100.x — listed first so it's
// the preferred (fastest) route.
export function localIPv4s() {
  const out = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) {
        out.push(a.address);
      }
    }
  }
  return out.sort((a, b) => {
    const tb = (ip) => (ip.startsWith('192.168.100.') ? 0 : 1);
    return tb(a) - tb(b);
  });
}

// A localhost URL is useless in a cross-machine invite — the invitee's
// "localhost" is their own box, not the server's. Rewrite the host to this
// machine's reachable IP. Returns { url, alternates } — url uses the primary
// (Thunderbolt-preferred) IP, alternates lists any other reachable URLs.
export function resolvePublicUrl(rawUrl) {
  let u;
  try { u = new URL(rawUrl); }
  catch { return { url: rawUrl, alternates: [] }; }

  const isLoopback = ['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(u.hostname);
  if (!isLoopback) return { url: rawUrl, alternates: [] };

  const ips = localIPv4s();
  if (ips.length === 0) return { url: rawUrl, alternates: [] };

  const toUrl = (ip) => { const c = new URL(rawUrl); c.hostname = ip; return c.toString().replace(/\/$/, ''); };
  return { url: toUrl(ips[0]), alternates: ips.slice(1).map(toUrl) };
}
