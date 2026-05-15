// Shared config loader — reads .env files and session registry.
// Priority: process.env > local .env > ~/.treebird-chat/.env
//
// This lets users without envoak set SMALLTOAK_TOKEN etc in a plain .env file.

import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';

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
