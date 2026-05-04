#!/usr/bin/env node
// treebird-chat-wizard — interactive session setup
//
// Walks through 7 steps:
//   1. Session name
//   2. File location
//   3. Transport (local file / + smalltoak bridge)
//   4. Agent invite (multi-select from known list or free-form)
//   5. Local LLM config (shown only when gemma/local selected)
//   6. Discussion template
//   7. Confirm + create

import { resolve, dirname } from 'node:path';
import { existsSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn, execSync } from 'node:child_process';
import readline from 'node:readline';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const ALLOW_BIN  = resolve(__dirname, 'treebird-chat-allow.mjs');
const CHAT_BIN   = resolve(__dirname, 'treebird-chat.mjs');
const GEMMA_BIN  = resolve(__dirname, 'gemma-bridge.mjs');
const BRIDGE_BIN = resolve(__dirname, 'treebird-chat-bridge.mjs');

const DEFAULT_DIR = resolve(process.env.HOME, 'treebird-shared/collab');

// ── Terminal helpers ───────────────────────────────────────────────────────────

const R = '\x1b[0m';
const B = '\x1b[1m';
const D = '\x1b[2m';
const C = '\x1b[36m';  // cyan
const G = '\x1b[32m';  // green
const Y = '\x1b[33m';  // yellow
const M = '\x1b[35m';  // magenta

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
const ask = (q) => new Promise(res => rl.question(q, res));

function header(n, title) {
  process.stdout.write(`\n${B}${C}Step ${n}/7 — ${title}${R}\n${D}${'─'.repeat(50)}${R}\n`);
}

function info(msg)    { process.stdout.write(`${D}  ${msg}${R}\n`); }
function ok(msg)      { process.stdout.write(`${G}  ✓ ${msg}${R}\n`); }
function warn(msg)    { process.stdout.write(`${Y}  ⚠ ${msg}${R}\n`); }
function section(msg) { process.stdout.write(`\n${B}${msg}${R}\n`); }

function today() { return new Date().toISOString().slice(0, 10); }
function nowHHMM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

async function askDefault(prompt, def) {
  const raw = await ask(`  ${prompt} ${D}[${def}]${R}: `);
  return raw.trim() || def;
}

async function askChoice(prompt, choices, def) {
  choices.forEach((c, i) => process.stdout.write(`  ${D}${i+1}.${R} ${c}\n`));
  const raw = await ask(`  ${prompt} ${D}[${def}]${R}: `);
  const trimmed = raw.trim();
  if (!trimmed) return def;
  const n = parseInt(trimmed, 10);
  if (!isNaN(n) && n >= 1 && n <= choices.length) return choices[n - 1];
  return trimmed;
}

// ── Known agents ──────────────────────────────────────────────────────────────

const KNOWN_AGENTS = [
  { name: 'yosef',       role: 'research / prototyping',       local: false },
  { name: 'watsan',      role: 'coordination / training data', local: false },
  { name: 'sherlocksan', role: 'code review / debugging',      local: false },
  { name: 'mappersan',   role: 'mapping / documentation',      local: false },
  { name: 'birdsan',     role: 'implementation',               local: false },
  { name: 'artisan',     role: 'architecture',                 local: false },
  { name: 'mycsan',      role: 'database / SQL',               local: false },
  { name: 'treesan',     role: 'integration',                  local: false },
  { name: 'sasusan',     role: 'security auditing',            local: false },
  { name: 'gemma',       role: 'local LLM — Gemma 4 (LM Studio)', local: true },
];

// ── Templates ─────────────────────────────────────────────────────────────────

const TEMPLATES = {
  consortium: (name, agents, goal) => `# Consortium: ${name} — ${today()}

**Facilitator:** treebird
**Goal:** ${goal || '[fill in]'}
**Started:** ${nowHHMM()}
**Closed:** —

## Participants

| Name | Role |
|------|------|
| treebird | facilitator / human |
${agents.map(a => `| ${a} | — |`).join('\n')}

## Agenda

1. [Item 1]
2. [Item 2]
3. [Item 3]

> Open each item: \`[HH:MM treebird] agenda item N: ...\`
> Close each item: \`[HH:MM treebird] item N closed\`

## Decisions

> Log inline as \`[HH:MM agent] [DECISION] ...\` — collect at close.

## Action Items

| Item | Owner | Status |
|------|-------|--------|
| — | — | open |

---

## Discussion

`,

  code_review: (name, agents) => `# Code Review: ${name} — ${today()}

**Reviewer(s):** ${agents.join(', ')}
**Scope:** [files / PR / diff link]
**Risk level:** [low | medium | high]

## Checklist

- [ ] Security regressions (auth, RLS, secrets exposure)
- [ ] Breaking API / CLI changes
- [ ] Large unreviewed diffs (>200 lines, no tests)
- [ ] Auth / migrations / key management changes
- [ ] Obvious bugs (null deref, missing await, wrong var)

## Instructions for agents

Review the diff listed above. For each issue:
\`[HH:MM agent] [RISK:<level>] <file>:<line> — <description>\`

If nothing flagged: \`[HH:MM agent] LGTM — no issues found.\`

---

## Discussion

`,

  adversarial: (name, agents) => `# Adversarial Review: ${name} — ${today()}

**Roles:**
- Proposer: ${agents[0] || 'TBD'} — argues FOR the proposal
- Critic: ${agents[1] || 'TBD'} — finds weaknesses, attack vectors
- Arbiter: ${agents[2] || 'treebird'} — calls the round, issues verdict

## Proposal

> [Describe the thing being reviewed — plan, code, architecture, decision]

## Rules

- Proposer opens each round with a case for the proposal.
- Critic responds with the strongest objection they can find.
- Arbiter calls: [SUSTAINED], [OVERRULED], or [DRAW] + rationale.
- 3 rounds minimum. Arbiter issues final verdict at close.

## Rounds

### Round 1

`,

  brainstorm: (name, agents) => `# Brainstorm: ${name} — ${today()}

**Participants:** ${agents.join(', ')}
**Topic:** [fill in]

## Ground rules

- Every idea gets aired, no immediate criticism.
- Tag promising ideas: \`[HH:MM agent] [IDEA] ...\`
- Tag concerns: \`[HH:MM agent] [CONCERN] ...\`
- Facilitator calls a vote when enough ideas are on the table.

---

## Ideas

`,

  blank: (name) => `# ${name} — ${today()}

`,
};

// ── LM Studio model probe ─────────────────────────────────────────────────────

async function probeModels(url) {
  try {
    const res = await fetch(`${url}/v1/models`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.data || []).map(m => m.id).filter(id => !id.includes('embed'));
  } catch { return []; }
}

// ── Main wizard ───────────────────────────────────────────────────────────────

async function main() {
  process.stdout.write(`\n${B}${M}treebird-chat wizard${R} — interactive session setup\n`);
  process.stdout.write(`${D}Press Enter to accept defaults shown in [brackets].${R}\n`);

  // ── Step 1: Name ────────────────────────────────────────────────────────────
  header(1, 'Session name');
  info('Used in the filename: CONSORTIUM_<name>_<date>.md');
  const name = await askDefault('Session name', today());

  // ── Step 2: Location ────────────────────────────────────────────────────────
  header(2, 'File location');
  info(`Default: ${DEFAULT_DIR}`);
  const dirRaw = await askDefault('Directory', DEFAULT_DIR);
  const dir = resolve(dirRaw.replace(/^~/, process.env.HOME));
  const fileName = `CONSORTIUM_${name}_${today()}.md`;
  const filePath = resolve(dir, fileName);
  info(`→ ${filePath}`);

  // ── Step 3: Transport ───────────────────────────────────────────────────────
  header(3, 'Transport');
  info('Local: chat file only (Syncthing/Dropbox handles multi-machine sync).');
  info('Bridge: also start a smalltoak bridge for real-time remote access.');
  const transport = await askChoice('Transport', ['local', 'local + smalltoak bridge'], 'local');

  let smalltoakUrl = null;
  let smalltoakToken = null;
  let chatId = null;
  if (transport.includes('smalltoak')) {
    smalltoakUrl   = await askDefault('Smalltoak URL', process.env.SMALLTOAK_SERVER_URL || 'http://localhost:3000');
    smalltoakToken = await askDefault('Smalltoak token', process.env.SMALLTOAK_TOKEN   || '');
    chatId         = await askDefault('Chat ID', name.replace(/\s+/g, '-').toLowerCase());
  }

  // ── Step 4: Agents ──────────────────────────────────────────────────────────
  header(4, 'Invite agents');
  info('Enter numbers (comma-separated) or agent names. Empty = no agents.');
  KNOWN_AGENTS.forEach((a, i) => {
    const tag = a.local ? `${M}[local LLM]${R}` : '';
    process.stdout.write(`  ${D}${String(i+1).padStart(2)}.${R} ${B}${a.name}${R}  ${D}${a.role}${R} ${tag}\n`);
  });
  process.stdout.write(`  ${D}  0.${R} other — type a name below\n`);

  const agentRaw = await ask('  Agents (e.g. 1,3,10 or yosef,watsan,gemma): ');
  const agentTokens = agentRaw.split(',').map(s => s.trim()).filter(Boolean);
  const invites = [];
  for (const tok of agentTokens) {
    const n = parseInt(tok, 10);
    if (!isNaN(n) && n >= 1 && n <= KNOWN_AGENTS.length) {
      invites.push(KNOWN_AGENTS[n - 1].name);
    } else if (!isNaN(n) && n === 0) {
      const custom = await ask('  Agent name: ');
      if (custom.trim()) invites.push(custom.trim());
    } else if (tok) {
      invites.push(tok);
    }
  }

  const hasGemma = invites.includes('gemma') ||
    invites.some(a => KNOWN_AGENTS.find(k => k.name === a && k.local));

  // ── Step 5: Local LLM config ────────────────────────────────────────────────
  let lmStudioUrl = 'http://localhost:8082';
  let lmModel = 'google/gemma-4-26b-a4b';

  if (hasGemma) {
    header(5, 'Local LLM config');
    lmStudioUrl = await askDefault('LM Studio URL', process.env.LM_STUDIO_URL || 'http://localhost:8082');

    // Probe for available models
    process.stdout.write(`  ${D}Probing ${lmStudioUrl} for loaded models...${R}\n`);
    const models = await probeModels(lmStudioUrl);
    if (models.length > 0) {
      info(`Found: ${models.join(', ')}`);
      const gemmaModels = models.filter(m => m.toLowerCase().includes('gemma'));
      const defaultModel = gemmaModels[0] || models[0];
      models.forEach((m, i) => process.stdout.write(`  ${D}${i+1}.${R} ${m}\n`));
      const modelRaw = await ask(`  Model ${D}[${defaultModel}]${R}: `);
      const modelN = parseInt(modelRaw.trim(), 10);
      if (!isNaN(modelN) && modelN >= 1 && modelN <= models.length) {
        lmModel = models[modelN - 1];
      } else {
        lmModel = modelRaw.trim() || defaultModel;
      }
    } else {
      warn(`LM Studio not reachable at ${lmStudioUrl} — bridge will retry at runtime.`);
      lmModel = await askDefault('Model ID', lmModel);
    }
  } else {
    // Skip step 5 visually
    process.stdout.write(`\n${D}Step 5/7 — Local LLM config ${R}${D}(skipped — no local LLM invited)${R}\n`);
  }

  // ── Step 6: Discussion template ─────────────────────────────────────────────
  header(6, 'Discussion template');
  const templateChoices = [
    'consortium  — agenda + decisions + action items',
    'code_review — structured diff review with risk checklist',
    'adversarial — proposer vs critic, arbiter calls rounds',
    'brainstorm  — open ideation, tag ideas and concerns',
    'blank       — just the header',
  ];
  process.stdout.write(`  ${D}Choose a starting structure for the chat file:${R}\n`);
  const templateKey = await askChoice('Template', templateChoices, 'consortium');
  const chosenTemplate = templateKey.split(/\s+/)[0]; // first word

  let goal = '';
  if (chosenTemplate === 'consortium') {
    goal = await ask(`  One-line goal for the session: `);
  }

  const templateFn = TEMPLATES[chosenTemplate] || TEMPLATES.blank;
  const templateContent = templateFn(name, invites, goal);

  // ── Step 7: Confirm ─────────────────────────────────────────────────────────
  header(7, 'Confirm');
  section('Summary:');
  process.stdout.write(`  File:      ${B}${filePath}${R}\n`);
  process.stdout.write(`  Transport: ${B}${transport}${R}\n`);
  if (smalltoakUrl) {
    process.stdout.write(`  Smalltoak: ${smalltoakUrl}  chat-id: ${chatId}\n`);
  }
  process.stdout.write(`  Agents:    ${B}${invites.length ? invites.join(', ') : '(none)'}${R}\n`);
  if (hasGemma) {
    process.stdout.write(`  LM Studio: ${lmStudioUrl}  model: ${lmModel}\n`);
  }
  process.stdout.write(`  Template:  ${B}${chosenTemplate}${R}\n`);

  const confirm = await ask(`\n  Create session? ${D}[Y/n]${R}: `);
  if (confirm.trim().toLowerCase() === 'n') {
    process.stdout.write('  Aborted.\n');
    rl.close();
    return;
  }

  // ── Create ──────────────────────────────────────────────────────────────────
  process.stdout.write('\n');
  mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, templateContent, 'utf8');
  ok(`Created ${filePath}`);

  // Allow owner + agents
  const allow = (agent) => spawnSync(
    process.execPath, [ALLOW_BIN, filePath, agent, '--owner', 'treebird'],
    { stdio: 'pipe' }
  );
  allow('treebird');
  for (const agent of invites) {
    allow(agent);
    ok(`ACL: ${agent}`);
  }

  // Start gemma-bridge if needed
  if (hasGemma) {
    const child = spawn(
      process.execPath,
      [GEMMA_BIN, filePath, '--lm-studio', lmStudioUrl, '--model', lmModel],
      { stdio: ['ignore', 'ignore', 'inherit'], detached: true }
    );
    child.unref();
    ok(`gemma-bridge started (PID ${child.pid})`);
  }

  // Start smalltoak bridge if requested
  if (smalltoakUrl && smalltoakToken && chatId) {
    const env = { ...process.env, SMALLTOAK_TOKEN: smalltoakToken };
    const child = spawn(
      process.execPath,
      [BRIDGE_BIN, chatId, filePath, '--smalltoak-url', smalltoakUrl],
      { stdio: ['ignore', 'ignore', 'inherit'], detached: true, env }
    );
    child.unref();
    ok(`smalltoak bridge started (PID ${child.pid})  chat-id: ${chatId}`);
  }

  // Post session-open message
  const agentList = invites.length ? invites.join(', ') : 'none';
  appendFileSync(filePath, `[${nowHHMM()} treebird] session open — invited: ${agentList}\n`);

  // Final instructions
  section('Ready:');
  process.stdout.write(`\n  ${B}export CHAT=${filePath}${R}\n`);
  process.stdout.write(`  node ${CHAT_BIN} $CHAT\n`);
  if (invites.includes('gemma')) {
    process.stdout.write(`\n  ${D}Gemma is listening. Say${R} ${B}@gemma <question>${R} ${D}to talk to it.${R}\n`);
  }
  if (smalltoakUrl) {
    process.stdout.write(`\n  ${D}Remote agents join via smalltoak chat-id:${R} ${B}${chatId}${R}\n`);
  }
  process.stdout.write('\n');

  rl.close();
}

main().catch(e => {
  process.stderr.write(`wizard error: ${e.stack || e.message}\n`);
  rl.close();
  process.exit(1);
});
