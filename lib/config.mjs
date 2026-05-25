// Shared config loader — reads .env files and session registry.
// Priority: process.env > local .env > ~/.treebird-chat/.env
//
// This lets users without envoak set SMALLTOAK_TOKEN etc in a plain .env file.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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
  const tmp = `${SESSIONS_FILE}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(sessions, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, SESSIONS_FILE);
  // renameSync atomically replaces the dest; re-assert mode in case umask narrowed it.
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
// Returns `{ chatId, ...session }` so callers can address smalltoak with the id
// the session is registered under. (The chatId is the registry key, not stored
// inside the value — saveSession() preserves that asymmetry.)
export function findSessionByPath(filePath) {
  // Normalize both sides via resolvePath so relative paths, symlinks, and
  // trailing-slash differences all match. Strict equality bit /sub auto-bridge
  // when the TUI was started with a relative path that became absolute through
  // the wizard. (Rubber-duck #1.)
  const target = resolve(filePath);
  const sessions = readSessions();
  const entry = Object.entries(sessions).find(([, s]) => s.filePath && resolve(s.filePath) === target);
  return entry ? { chatId: entry[0], ...entry[1] } : null;
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

// ── Smalltoak URL canonicalization ────────────────────────────────────────────
//
// Closes issue #6 P1 — the 2026-05-20 nightjar incident where the wizard
// wrote a guessed `getLanIp():3000` URL (m5's Thunderbolt IP) when the actual
// smalltoak server lived on m2 at a different IP. Every join from that
// wizard run hit ECONNREFUSED.
//
// Resolution order (Treebird's decision recorded in [[project-p1-url-source]]):
//   1. `.env` / process env: SMALLTOAK_SERVER_URL — works for any user
//   2. envoak vault: `treebird-chat/SMALLTOAK_SERVER_URL` — secure shared truth
//      when envoak is installed (today: only Treebird himself)
//   3. null — caller must prompt or error
//
// Envoak detection: ENVOAK_AGENT_LABEL in env means `envoak identity pull`
// was run, so the binary is on PATH and the vault is reachable. Without
// that signal we skip the vault probe entirely — vanilla users never pay
// the subprocess cost.
//
// Sync API: callers run this at startup once. The vault subprocess is
// bounded by `timeout`; on miss/timeout we silently fall through.

const VAULT_NAMESPACE = 'treebird-chat';
const VAULT_KEY = 'SMALLTOAK_SERVER_URL';
const VAULT_TIMEOUT_MS = 5000;

// `envoak` may be installed at a non-PATH location (Treebird's dev box has it
// at ~/Dev/Envoak/dist/bin/envoak.js). Check that path first; fall through
// to PATH lookup. We never throw — a missing envoak is a soft signal.
function envoakBin() {
  const devBuild = resolve(homedir(), 'Dev', 'Envoak', 'dist', 'bin', 'envoak.js');
  if (existsSync(devBuild)) return { cmd: 'node', args: [devBuild] };
  return { cmd: 'envoak', args: [] };
}

function envoakAvailable(env = process.env) {
  return Boolean(env.ENVOAK_AGENT_LABEL);
}

// `namespace` + `key` injection lets tests target a guaranteed-empty
// vault entry, so a probe-miss test stays true even when the real
// vault has the production key set.
export function resolveSmalltoakUrl({
  env = process.env,
  namespace = VAULT_NAMESPACE,
  key = VAULT_KEY,
} = {}) {
  if (env.SMALLTOAK_SERVER_URL) {
    return { url: env.SMALLTOAK_SERVER_URL, source: 'env' };
  }
  if (envoakAvailable(env)) {
    try {
      const { cmd, args } = envoakBin();
      const out = execFileSync(cmd, [...args, 'vault', 'get', namespace, key], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: VAULT_TIMEOUT_MS,
      }).trim();
      // envoak vault get prints the value on its own line; some versions add
      // headers. Strip anything that doesn't look like a URL.
      const url = out.split('\n').find((l) => /^https?:\/\//.test(l));
      if (url) return { url, source: 'vault' };
    } catch { /* envoak missing / vault entry missing / timeout — fall through */ }
  }
  return { url: null, source: null };
}

// Best-effort vault write — called by the wizard after a user-confirmed URL.
// Failures (no envoak, vault uninitialised, network issue) are returned as
// `{ written: false, reason }` and surfaced as a non-fatal warning. The
// canonical write to `.env` happens elsewhere and is unconditional.
export function saveSmalltoakUrl(url) {
  if (!envoakAvailable()) {
    return { written: false, reason: 'envoak not detected (ENVOAK_AGENT_LABEL not set)' };
  }
  try {
    const { cmd, args } = envoakBin();
    // `envoak vault set <ns> <key> <value>` is the documented add path.
    execFileSync(cmd, [...args, 'vault', 'set', VAULT_NAMESPACE, VAULT_KEY, url], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: VAULT_TIMEOUT_MS,
    });
    return { written: true };
  } catch (e) {
    return { written: false, reason: `envoak vault set failed: ${e.message.split('\n')[0]}` };
  }
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
//
// When the host is already a specific local IP (e.g. 192.168.100.1), the URL
// is kept as-is but alternates are populated from the machine's other interfaces
// — important when the smalltoak host has both Thunderbolt and WiFi addresses
// and the invitee is on a different subnet.
export function resolvePublicUrl(rawUrl) {
  let u;
  try { u = new URL(rawUrl); }
  catch { return { url: rawUrl, alternates: [] }; }

  const toUrl = (ip) => { const c = new URL(rawUrl); c.hostname = ip; return c.toString().replace(/\/$/, ''); };
  const ips = localIPv4s();
  const isLoopback = ['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(u.hostname);

  if (isLoopback) {
    if (ips.length === 0) return { url: rawUrl, alternates: [] };
    return { url: toUrl(ips[0]), alternates: ips.slice(1).map(toUrl) };
  }

  // Non-loopback. Only surface alternates when the URL's hostname is one of
  // *this* machine's interfaces — i.e. this code is running on the smalltoak
  // host. Without the guard, an invitee calling resolvePublicUrl on a URL that
  // points to another machine would get their own local IPs as "alternates",
  // which point to the wrong server. Currently latent because the only consumer
  // of `alternates` is the inviter-side invite block, but the function's
  // contract should be sound for any caller.
  const isLocal = ips.includes(u.hostname);
  if (!isLocal) return { url: rawUrl, alternates: [] };

  const otherIps = ips.filter((ip) => ip !== u.hostname);
  if (otherIps.length > 0) {
    return { url: rawUrl, alternates: otherIps.map(toUrl) };
  }

  return { url: rawUrl, alternates: [] };
}
