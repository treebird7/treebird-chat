import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const STATE_DIR = join(homedir(), '.treebird-chat');
const WATCHLIST_PATH = join(STATE_DIR, 'watchlist.json');

function ensureDir() {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
}

function load() {
  ensureDir();
  if (!existsSync(WATCHLIST_PATH)) return { version: 1, agents: {} };
  try {
    return JSON.parse(readFileSync(WATCHLIST_PATH, 'utf8'));
  } catch {
    return { version: 1, agents: {} };
  }
}

function save(state) {
  ensureDir();
  writeFileSync(WATCHLIST_PATH, JSON.stringify(state, null, 2) + '\n');
}

export function getAgent(agentLabel) {
  const state = load();
  return state.agents[agentLabel] ?? { muted: false, files: {} };
}

export function addFile(agentLabel, filePath, cursor = 0) {
  const state = load();
  if (!state.agents[agentLabel]) {
    state.agents[agentLabel] = { muted: false, files: {} };
  }
  const existing = state.agents[agentLabel].files[filePath];
  state.agents[agentLabel].files[filePath] = { cursor: existing?.cursor ?? cursor };
  save(state);
}

export function removeFile(agentLabel, filePath) {
  const state = load();
  if (state.agents[agentLabel]?.files) {
    delete state.agents[agentLabel].files[filePath];
  }
  save(state);
}

export function setMuted(agentLabel, muted) {
  const state = load();
  if (!state.agents[agentLabel]) {
    state.agents[agentLabel] = { muted, files: {} };
  } else {
    state.agents[agentLabel].muted = muted;
  }
  save(state);
}

export function updateCursor(agentLabel, filePath, cursor) {
  const state = load();
  if (state.agents[agentLabel]?.files?.[filePath] !== undefined) {
    state.agents[agentLabel].files[filePath].cursor = cursor;
    save(state);
  }
}
