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

// `instance` (optional): a concurrent second/third instance of the same base
// agent (e.g. `sherlock#2`, per SPEC_identity-verification §2) needs its own
// cursor — two instances sharing one sidecar would clobber each other's read
// position. ACL membership stays keyed by base `agent` (grant-by-base is the
// recommended granularity); only the cursor is instance-scoped.
export function cursorPath(corrPath, agent, instance = null) {
  // `agent` becomes a path component — reject anything that could traverse.
  assertAgentName(agent);
  const suffix = instance ? `-i${parseInt(instance, 10)}` : '';
  return `${corrPath}.cursor.${agent}${suffix}`;
}

// Persist "last seen line count" for an agent. Lets `corrwait` advance the
// baseline when an agent chose to stay quiet on the previous wake.
export function readCursor(corrPath, agent, instance = null) {
  const p = cursorPath(corrPath, agent, instance);
  if (!existsSync(p)) return 0;
  const n = parseInt(readFileSync(p, 'utf8').trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

// Mode 0o600 on the cursor + ACL. The cursor leaks an agent's read-position
// (timing oracle); the ACL leaks who has access. Neither is a secret, but
// neither should be world-readable on a multi-user box. Matches the
// `sessions.json` posture. (/ts-review permissions_hygiene #1.)
const SIDECAR_MODE = 0o600;

export function writeCursor(corrPath, agent, lineCount, instance = null) {
  const dest = cursorPath(corrPath, agent, instance);
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

// SPEC_identity-verification §3 (--as human-approval hook): once an
// unverified name has been approved (via the approve hook or an owner
// `/approve`), remember it on the ACL entry so the check is once-per-name,
// not once-per-message. Does NOT touch `allowed` — approval is an ADDITIONAL
// gate layered on top of ACL membership, never a substitute for it.
export function isApprovedUnverified(corrPath, agent) {
  const acl = readAcl(corrPath);
  return acl?.agents?.[agent]?.approved_unverified === true;
}

export function setApprovedUnverified(corrPath, agent, approved) {
  const acl = ensureAcl(corrPath);
  const entry = { ...(acl.agents[agent] || {}) };
  if (approved) {
    entry.approved_unverified = true;
    entry.approved_at = new Date().toISOString();
  } else {
    delete entry.approved_unverified;
    delete entry.approved_at;
  }
  acl.agents[agent] = entry;
  writeAcl(corrPath, acl);
  return acl;
}
