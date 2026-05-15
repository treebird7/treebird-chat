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

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
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

export function writeCursor(corrPath, agent, lineCount) {
  writeFileSync(cursorPath(corrPath, agent), String(lineCount) + '\n');
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
  writeFileSync(aclPath(corrPath), JSON.stringify(acl, null, 2) + '\n');
}

export function ensureAcl(corrPath, owner = 'treebird') {
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
