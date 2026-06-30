// Shared config loader — reads .env files and session registry.
// Priority: process.env > local .env > ~/.treebird-chat/.env
//
// This lets users without envoak set SMALLTOAK_TOKEN etc in a plain .env file.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, sep } from 'node:path';
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

export function userEnvPath() {
  return resolve(homedir(), '.treebird-chat', '.env');
}

// Upsert keys into ~/.treebird-chat/.env (0600, dir 0700). Order-preserving:
// existing lines (incl. comments + unrelated keys) are kept verbatim, a key
// present in `updates` has its value rewritten in place, and new keys are
// appended. Returns { path, written: [keys], skipped: [keys] }. Pass
// `overwrite:false` to keep an existing value instead of replacing it (used so
// `init` doesn't clobber a token the user already set unless asked).
export function upsertUserEnv(updates, { overwrite = true } = {}) {
  // Strip CR/LF from values before they become `KEY=value` lines. A newline in
  // a value would inject an extra .env line when the file is parsed back
  // (e.g. SMALLTOAK_TOKEN="abc\nFOO=bar" → a stray FOO). Values are
  // operator-supplied (flags/prompt/vault), so this is defense-in-depth, not a
  // remote exploit — but a pasted token with a trailing newline shouldn't
  // silently corrupt the file. Newlines are never valid in an env value.
  updates = Object.fromEntries(
    Object.entries(updates).map(([k, v]) => [k, v == null ? v : String(v).replace(/[\r\n]/g, '')])
  );
  const path = userEnvPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split('\n') : [];
  const seen = new Set();
  const written = [], skipped = [];
  const out = lines.map((line) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return line;
    const eq = t.indexOf('=');
    if (eq < 1) return line;
    const key = t.slice(0, eq).trim();
    if (!(key in updates)) return line;
    seen.add(key);
    if (!overwrite) { skipped.push(key); return line; }
    written.push(key);
    return `${key}=${updates[key]}`;
  });
  for (const [key, val] of Object.entries(updates)) {
    if (seen.has(key) || val == null) continue;
    out.push(`${key}=${val}`);
    written.push(key);
  }
  // Trailing newline, no double-blank at EOF.
  const content = out.join('\n').replace(/\n*$/, '\n');
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
  return { path, written, skipped };
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

// The mirror store: deterministic persistent home for a joiner's mirror file,
// sibling to locks/ under ~/.treebird-chat/. Replaces the old volatile /tmp
// orphan (reboot-wiped, canopy-detached — the 2026-05-20 nightjar incident).
export const MIRROR_STORE_DIR = resolve(homedir(), '.treebird-chat', 'rooms');

// chatId crosses a machine boundary (invite-sourced) before it becomes a path
// segment, so validate it as a safe single segment: no separators, no traversal.
// Basic guard now; sherlock's security pass (tb-d21.2) hardens + adversarial-tests.
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

function mirrorStorePath(chatId, storeDir) {
  if (typeof chatId !== 'string' || chatId === '.' || chatId === '..' || !SAFE_SEGMENT.test(chatId)) {
    throw new Error(`unsafe chatId for mirror store: ${JSON.stringify(chatId)}`);
  }
  return resolve(storeDir, `${chatId}.md`);
}

// Resolve the mirror file path treebird-chat-join should bridge against.
// Pure fn of (chatId, registry) — no writes, deterministic (same inputs → same
// path). A registered chat-id resolves to its canonical filePath; any other
// (a joiner that didn't host the room) resolves to a deterministic file in the
// mirror store rather than a /tmp orphan.
//
// Returns { mirrorFile, source, note }:
//   source='registered' — chat-id is in sessions.json with a filePath; note null
//   source='local'      — joiner's mirror in the store; note flags it as a
//                          mirror, not the host's canonical file.
//
// `sessions` injects a registry without disk reads; `storeDir` isolates tests.
export function resolveMirrorFile(chatId, { sessions = null, storeDir = MIRROR_STORE_DIR } = {}) {
  const registry = sessions ?? readSessions();
  const registered = registry[chatId];
  if (registered?.filePath) {
    return { mirrorFile: registered.filePath, source: 'registered', note: null };
  }
  return {
    mirrorFile: mirrorStorePath(chatId, storeDir),
    source: 'local',
    note: 'mirror; not host canonical',
  };
}

// Is a chat file a joiner's mirror (lives in the mirror store) rather than the
// host's canonical room file? Pure path predicate — d21.3 surfaces this in the
// TUI header and status so a human knows when they're on a non-canonical mirror.
// `storeDir` injects for tests; defaults to the real mirror store.
export function isMirrorFile(file, storeDir = MIRROR_STORE_DIR) {
  const r = resolve(file);
  const base = resolve(storeDir);
  return r === base || r.startsWith(base + sep);
}

// ── Smalltoak URL canonicalization ────────────────────────────────────────────
//
// Closes issue #6 P1 — the 2026-05-20 nightjar incident where the wizard
// wrote a guessed `getLanIp():3000` URL (m5's Thunderbolt IP) when the actual
// smalltoak server lived on m2 at a different IP. Every join from that
// wizard run hit ECONNREFUSED.
//
// Resolution order (Treebird's decision recorded in [[project-p1-url-source]]):
//   1. `.env` / process env: SMALLTOAK_URL (canonical — matches the SMALLTOAK_TOKEN
//      prefix), or SMALLTOAK_SERVER_URL (back-compat alias) — works for any user
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

// A loopback URL points the client at *itself*. For a cross-machine server
// that's almost always a stale per-machine .env (the 2026-06-13 failure: m2's
// `SMALLTOAK_SERVER_URL=localhost:3000` silently beat the vault canonical URL).
// ponytail: simple host check, not full URL parse — covers the cases we hit.
function isLoopbackUrl(url) {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch { return false; }
}

// `namespace` + `key` injection lets tests target a guaranteed-empty
// vault entry, so a probe-miss test stays true even when the real
// vault has the production key set.
export function resolveSmalltoakUrl({
  env = process.env,
  namespace = VAULT_NAMESPACE,
  key = VAULT_KEY,
} = {}) {
  // SMALLTOAK_URL is canonical (matches SMALLTOAK_TOKEN); SMALLTOAK_SERVER_URL
  // is the historical name, still honoured so existing .env files keep working.
  const envUrl = env.SMALLTOAK_URL || env.SMALLTOAK_SERVER_URL;
  if (envUrl && !(envoakAvailable(env) && isLoopbackUrl(envUrl))) {
    return { url: envUrl, source: 'env' };
  }
  if (envUrl) {
    // loopback env on an envoak box — likely stale; prefer the vault canonical.
    console.warn(`[smalltoak] ignoring loopback env URL ${envUrl}; falling through to vault`);
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

// Best-effort vault read for an arbitrary treebird-chat key (e.g. the token).
// Returns the value string, or null on any miss (no envoak, missing key,
// timeout). Used by `treebird-chat-init --from-vault`.
export function vaultGet(namespace, key, { env = process.env, timeout = VAULT_TIMEOUT_MS } = {}) {
  if (!envoakAvailable(env)) return null;
  try {
    const { cmd, args } = envoakBin();
    const out = execFileSync(cmd, [...args, 'vault', 'get', namespace, key], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout,
    }).trim();
    // Some envoak versions print a header line; take the last non-bracketed line.
    const val = out.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('[')).pop();
    return val || null;
  } catch { return null; }
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

// ── Transport conflict detection ───────────────────────────────────────────────
//
// A chat file must have exactly ONE sync layer. Running a smalltoak bridge on a
// file that is ALSO git-synced (or vice versa) is the failure we hit on
// 2026-06-07: `git pull --autostash`/`checkout` atomic-renames the file out from
// under the bridge, desyncing its cursor. Detect the git case so the bridge can
// warn. Pure filesystem walk (no subprocess) — returns the repo root or null.
export function gitRepoRootFor(filePath) {
  let dir = dirname(resolve(filePath));
  while (true) {
    if (existsSync(resolve(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
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
