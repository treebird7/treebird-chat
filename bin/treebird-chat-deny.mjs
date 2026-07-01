#!/usr/bin/env node
// treebird-chat-deny <CORR_file> <agent>
// Toggle an agent OFF for a chat channel. Their corrwait will exit REVOKED on next file change.

import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { setAllowed, aclPath } from '../lib/access.mjs';
import { isValidAgentName } from '../lib/identity.mjs';
import { requireEnvoakUnlock } from '../lib/envoak-gate.mjs';

const [file, agent] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!file || !agent) {
  process.stderr.write('usage: treebird-chat-deny <CORR_file> <agent>\n');
  process.exit(1);
}
if (!isValidAgentName(agent)) {
  process.stderr.write(`Invalid agent name "${agent}": letters/digits/hyphens/underscores, must start with a letter, max 64 chars.\n`);
  process.exit(1);
}

const filePath = resolve(file);
if (!existsSync(filePath)) {
  process.stderr.write(`File not found: ${filePath}\n`);
  process.exit(1);
}

const gate = await requireEnvoakUnlock({ action: 'treebird-chat-deny' });
if (!gate.ok) {
  process.stderr.write(`${gate.message}\n`);
  process.exit(1);
}

const acl = setAllowed(filePath, agent, false);
process.stdout.write(`🚫 ${agent} denied on ${file}\n`);
process.stdout.write(`   acl: ${aclPath(filePath)}\n`);
process.stdout.write(`   agents: ${JSON.stringify(acl.agents, null, 2)}\n`);
