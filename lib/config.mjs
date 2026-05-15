// Shared config loader — reads .env files and session registry.
// Priority: process.env > local .env > ~/.treebird-chat/.env
//
// This lets users without envoak set SMALLTOAK_TOKEN etc in a plain .env file.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

const SESSIONS_FILE = resolve(homedir(), '.treebird-chat', 'sessions.json');

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
  writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2) + '\n');
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
