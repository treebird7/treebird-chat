// Read/write the per-channel access list sidecar `<CORR_file>.access.json`.
//
// Shape:
// {
//   "owner": "treebird",
//   "agents": {
//     "yosef":   { "allowed": true,  "joined_at": "<iso>" },
//     "watsan":  { "allowed": false }
//   }
// }
//
// The owner field is informational. Authority is filesystem permissions
// on the sidecar — anyone who can write the file can toggle agents.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { assertAgentName } from './identity.mjs';

export function aclPath(corrPath) {
  return `${corrPath}.access.json`;
}

export function cursorPath(corrPath, agent) {
  // `agent` becomes a path component — reject anything that could traverse.
  assertAgentName(agent);
  return `${corrPath}.cursor.${agent}`;
}

// Persist "last seen line count" for an agent. Lets `corrwait` advance the
// baseline when an agent chose to stay quiet on the previous wake.
export function readCursor(corrPath, agent) {
  const p = cursorPath(corrPath, agent);
  if (!existsSync(p)) return 0;
  const n = parseInt(readFileSync(p, 'utf8').trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

// Mode 0o600 on the cursor + ACL. The cursor leaks an agent's read-position
// (timing oracle); the ACL leaks who has access. Neither is a secret, but
// neither should be world-readable on a multi-user box. Matches the
// `sessions.json` posture. (/ts-review permissions_hygiene #1.)
const SIDECAR_MODE = 0o600;

export function writeCursor(corrPath, agent, lineCount) {
  const dest = cursorPath(corrPath, agent);
  const tmp = `${dest}.tmp.${process.pid}`;
  writeFileSync(tmp, String(lineCount) + '\n', { mode: SIDECAR_MODE });
  renameSync(tmp, dest);
}

export function readAcl(corrPath) {
  const p = aclPath(corrPath);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error(`Failed to parse ACL ${p}: ${e.message}`);
  }
}

export function writeAcl(corrPath, acl) {
  const dest = aclPath(corrPath);
  const tmp = `${dest}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(acl, null, 2) + '\n', { mode: SIDECAR_MODE });
  renameSync(tmp, dest);
}

// Default owner: caller-supplied → $USER/$USERNAME → 'owner'. The previous
// 'treebird' default was a person-name from this codebase's origin and was
// wrong for everyone else. (Rubber-duck #5.)
function defaultOwner() {
  return process.env.USER || process.env.USERNAME || 'owner';
}

export function ensureAcl(corrPath, owner = defaultOwner()) {
  const existing = readAcl(corrPath);
  if (existing) return existing;
  const fresh = { owner, agents: {} };
  writeAcl(corrPath, fresh);
  return fresh;
}

export function isAllowed(corrPath, agent) {
  const acl = readAcl(corrPath);
  if (!acl) return false;
  const entry = acl.agents?.[agent];
  return entry?.allowed === true;
}

export function setAllowed(corrPath, agent, allowed) {
  const acl = ensureAcl(corrPath);
  acl.agents[agent] = {
    ...(acl.agents[agent] || {}),
    allowed,
    ...(allowed ? { joined_at: new Date().toISOString() } : {}),
  };
  writeAcl(corrPath, acl);
  return acl;
}
