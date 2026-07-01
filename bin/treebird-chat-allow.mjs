#!/usr/bin/env node
// treebird-chat-allow <CORR_file> <agent> [--owner treebird]
// Toggle an agent ON for a chat channel. Creates the ACL sidecar if missing.

import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { ensureAcl, setAllowed, aclPath } from '../lib/access.mjs';
import { isValidAgentName } from '../lib/identity.mjs';
import { requireEnvoakUnlock } from '../lib/envoak-gate.mjs';

function parseArgs(argv) {
  const args = { file: null, agent: null, owner: 'treebird' };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--owner') args.owner = argv[++i];
    else if (!a.startsWith('--')) positional.push(a);
  }
  args.file = positional[0];
  args.agent = positional[1];
  return args;
}

const { file, agent, owner } = parseArgs(process.argv.slice(2));
if (!file || !agent) {
  process.stderr.write('usage: treebird-chat-allow <CORR_file> <agent> [--owner treebird]\n');
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

const gate = await requireEnvoakUnlock({ action: 'treebird-chat-allow' });
if (!gate.ok) {
  process.stderr.write(`${gate.message}\n`);
  process.exit(1);
}

ensureAcl(filePath, owner);
const acl = setAllowed(filePath, agent, true);
process.stdout.write(`✅ ${agent} allowed on ${file}\n`);
process.stdout.write(`   acl: ${aclPath(filePath)}\n`);
process.stdout.write(`   agents: ${JSON.stringify(acl.agents, null, 2)}\n`);
