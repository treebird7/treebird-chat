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
import { existsSync, readFileSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import os from 'node:os';
import readline from 'node:readline';
import { loadEnv, localIPv4s, saveSession, loadSession, spawnEnv } from '../lib/config.mjs';
import { loadPin, fingerprintFromPem } from '../lib/smalltoak-pin.mjs';

// Load .env / ~/.treebird-chat/.env before anything reads process.env
loadEnv();

const __dirname  = dirname(fileURLToPath(import.meta.url));
const ALLOW_BIN  = resolve(__dirname, 'treebird-chat-allow.mjs');
const INVITE_BIN = resolve(__dirname, 'treebird-chat-invite.mjs');
const CHAT_BIN   = resolve(__dirname, 'treebird-chat.mjs');
const GEMMA_BIN  = resolve(__dirname, 'gemma-bridge.mjs');
const BRIDGE_BIN = resolve(__dirname, 'treebird-chat-bridge.mjs');

const DEFAULT_DIR = process.env.TREEBIRD_COLLAB_DIR
  ? resolve(process.env.TREEBIRD_COLLAB_DIR)
  : resolve(process.env.HOME, 'collab');

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


// Strip path separators / traversal from a user-supplied name before it
// becomes part of a filename.
function safeFileSegment(s) {
  return String(s).replace(/[^\w.-]+/g, '_').replace(/^\.+/, '_') || 'session';
}
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

// Known agents: loaded from TREEBIRD_AGENTS_FILE (JSON array of {name, role, local?})
// if set, otherwise just the built-in local LLM entry.
// Format: [{"name":"myagent","role":"does stuff"},{"name":"gemma","local":true,"role":"local LLM"}]
const BUILTIN_LOCAL_AGENTS = [
  { name: 'gemma', role: 'local LLM — Gemma 4 (LM Studio)', local: true },
];

function loadKnownAgents() {
  const agentsFile = process.env.TREEBIRD_AGENTS_FILE;
  if (agentsFile && existsSync(agentsFile)) {
    try {
      const entries = JSON.parse(readFileSync(agentsFile, 'utf8'));
      if (Array.isArray(entries)) return entries;
    } catch { /* fall through */ }
  }
  return BUILTIN_LOCAL_AGENTS;
}

const KNOWN_AGENTS = loadKnownAgents();

// ── Templates ─────────────────────────────────────────────────────────────────

const TEMPLATES = {
  consortium: (name, agents, goal, facilitator) => `# Consortium: ${name} — ${today()}

**Facilitator:** ${facilitator}
**Goal:** ${goal || '[fill in]'}
**Started:** ${nowHHMM()}
**Closed:** —

## Participants

| Name | Role |
|------|------|
| ${facilitator} | facilitator / human |
${agents.map(a => `| ${a} | — |`).join('\n')}

## Agenda

1. [Item 1]
2. [Item 2]
3. [Item 3]

> Open each item: \`[HH:MM ${facilitator}] agenda item N: ...\`
> Close each item: \`[HH:MM ${facilitator}] item N closed\`

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

  adversarial: (name, agents, goal, facilitator) => `# Adversarial Review: ${name} — ${today()}

**Roles:**
- Proposer: ${agents[0] || 'TBD'} — argues FOR the proposal
- Critic: ${agents[1] || 'TBD'} — finds weaknesses, attack vectors
- Arbiter: ${agents[2] || facilitator} — calls the round, issues verdict

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

  // ── Your name ───────────────────────────────────────────────────────────────
  const defaultName = process.env.BIRDCHAT_AGENT || process.env.ENVOAK_AGENT_LABEL?.replace(/-[^-]+$/, '') || '';
  const humanName = await askDefault('Your name', defaultName || 'human');

  // ── Step 1: Name ────────────────────────────────────────────────────────────
  header(1, 'Session name');
  info('Used in the filename: CONSORTIUM_<name>_<date>.md');
  const name = await askDefault('Session name', today());

  // ── Step 2: Location ────────────────────────────────────────────────────────
  header(2, 'File location');
  info(`Default: ${DEFAULT_DIR}`);
  const dirRaw = await askDefault('Directory', DEFAULT_DIR);
  const dir = resolve(dirRaw.replace(/^~/, process.env.HOME));
  const fileName = `CONSORTIUM_${safeFileSegment(name)}_${today()}.md`;
  const filePath = resolve(dir, fileName);
  info(`→ ${filePath}`);

  // ── Step 3: Transport ───────────────────────────────────────────────────────
  header(3, 'Transport');
  info('Local: chat file only (Syncthing/Dropbox handles multi-machine sync).');
  info('Bridge: also start a smalltoak bridge for real-time remote access.');
  const defaultTransport = process.env.SMALLTOAK_SERVER_URL ? 'local + smalltoak bridge' : 'local';
  const transport = await askChoice('Transport', ['local', 'local + smalltoak bridge'], defaultTransport);

  let smalltoakUrl = null;
  let smalltoakToken = null;
  let smalltoakCertFile = null;
  let chatId = null;
  if (transport.includes('smalltoak')) {
    // Use env values silently if available; only prompt for missing ones.
    smalltoakUrl = process.env.SMALLTOAK_SERVER_URL || null;
    if (!smalltoakUrl) {
      const primaryIp = localIPv4s()[0] || '127.0.0.1';
      smalltoakUrl = await askDefault('Smalltoak URL', `http://${primaryIp}:3000`);
    } else {
      info(`Smalltoak URL: ${smalltoakUrl}`);
    }
    // Probe the URL — a 401 means smalltoak is alive and requires auth (expected).
    // Catches IP typos before the session is committed to sessions.json.
    try {
      const probeRes = await fetch(`${smalltoakUrl}/messages?to=probe`, {
        signal: AbortSignal.timeout(3_000),
      });
      if (probeRes.status === 401 || probeRes.status === 403) {
        ok(`Smalltoak reachable (HTTP ${probeRes.status})`);
      } else {
        warn(`Smalltoak probe: HTTP ${probeRes.status} — unexpected; verify URL`);
      }
    } catch (e) {
      const code = e.cause?.code ?? e.code ?? '';
      const hint = code === 'ECONNREFUSED' ? 'nothing listening at that address — check IP and port' :
        /ETIMEDOUT|ECONNRESET/.test(code) ? 'connection timed out — check IP/subnet' :
        (e.message ?? 'unreachable').split('\n')[0];
      warn(`Smalltoak probe failed: ${hint}`);
      warn('URL may be wrong — proceed with caution or Ctrl-C to fix');
    }
    smalltoakToken = process.env.SMALLTOAK_TOKEN || null;
    if (!smalltoakToken) {
      smalltoakToken = await askDefault('Smalltoak token', '');
    } else {
      info('Smalltoak token: (from env)');
    }

    // Cert pinning — required when URL is https://. Source priority:
    //   1. SMALLTOAK_CERT_FILE / SMALLTOAK_CERT env (host machine usually has this)
    //   2. ~/.treebird-chat/smalltoak.crt (persisted from a previous join)
    //   3. Prompt
    // Validate via loadPin so a bad cert fails here, not at bridge launch.
    if (smalltoakUrl.startsWith('https://')) {
      const DEFAULT_CERT = resolve(os.homedir(), '.treebird-chat', 'smalltoak.crt');
      let candidate = process.env.SMALLTOAK_CERT_FILE || process.env.SMALLTOAK_CERT || null;
      if (!candidate && existsSync(DEFAULT_CERT)) candidate = DEFAULT_CERT;
      if (candidate) {
        info(`Smalltoak cert: ${candidate}`);
      } else {
        candidate = (await askDefault('Smalltoak cert file (path to PEM)', '')) || null;
      }

      if (!candidate) {
        warn('https:// requires a pinned cert — bridge will refuse to start without one.');
      } else {
        try {
          const pem = loadPin(candidate);
          info(`Cert SHA-256: ${fingerprintFromPem(pem)}`);
          // Mirror to ~/.treebird-chat/smalltoak.crt (0600) so future re-joins
          // — and the bridge spawn below — find it without further prompting.
          const absSource = resolve(candidate);
          if (absSource !== DEFAULT_CERT) {
            mkdirSync(dirname(DEFAULT_CERT), { recursive: true, mode: 0o700 });
            writeFileSync(DEFAULT_CERT, pem, { mode: 0o600 });
            info(`Cert persisted to ${DEFAULT_CERT}`);
          }
          smalltoakCertFile = DEFAULT_CERT;
        } catch (e) {
          warn(`Cert load failed: ${e.message}`);
        }
      }
    }

    chatId = await askDefault('Chat ID', name.replace(/\s+/g, '-').toLowerCase());
  }

  // ── Step 4: Agents ──────────────────────────────────────────────────────────
  header(4, 'Invite agents');
  info('Enter numbers (comma-separated) or agent names. Empty = no agents.');
  KNOWN_AGENTS.forEach((a, i) => {
    const tag = a.local ? `${M}[local LLM]${R}` : '';
    process.stdout.write(`  ${D}${String(i+1).padStart(2)}.${R} ${B}${a.name}${R}  ${D}${a.role}${R} ${tag}\n`);
  });
  process.stdout.write(`  ${D}  0.${R} other — type a name below\n`);

  const agentRaw = await ask('  Agents (e.g. 1,3 or agent1,agent2,gemma): ');
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
  let lmModel = process.env.GEMMA_MODEL || 'mlx-community/gemma-4-26b-a4b-it-4bit';

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
  const templateContent = templateFn(name, invites, goal, humanName);

  // ── Step 7: Confirm ─────────────────────────────────────────────────────────
  header(7, 'Confirm');
  section('Summary:');
  process.stdout.write(`  You:       ${B}${humanName}${R}\n`);
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
  const allow = (agent) => {
    const result = spawnSync(
      process.execPath, [ALLOW_BIN, filePath, agent, '--owner', humanName],
      { stdio: 'pipe' }
    );
    if (result.status !== 0) {
      const detail = (result.stderr?.toString() || '').trim();
      warn(`ACL grant failed for ${agent}${detail ? ` — ${detail}` : ''}`);
      return false;
    }
    return true;
  };
  if (allow(humanName)) ok(`ACL: ${humanName} (you)`);
  for (const agent of invites) {
    if (allow(agent)) ok(`ACL: ${agent}`);
  }

  // Start gemma-bridge if needed
  if (hasGemma) {
    const child = spawn(
      process.execPath,
      [GEMMA_BIN, filePath, '--lm-studio', lmStudioUrl, '--model', lmModel],
      { stdio: ['ignore', 'ignore', 'inherit'], detached: true, env: spawnEnv() }
    );
    child.on('error', (err) => warn(`gemma-bridge failed to start: ${err.message}`));
    child.unref();
    ok(`gemma-bridge started (PID ${child.pid})`);
  }

  // Save session config for --join (includes cert path so re-joins repin).
  saveSession(chatId || humanName, {
    filePath, smalltoakUrl, smalltoakToken, smalltoakCertFile, humanName,
  });

  // Start smalltoak bridge if requested
  if (smalltoakUrl && smalltoakToken && chatId) {
    const env = spawnEnv({
      SMALLTOAK_TOKEN: smalltoakToken,
      TREEBIRD_MACHINE: process.env.TREEBIRD_MACHINE,
      BIRDCHAT_BRIDGE_POLL_MS: process.env.BIRDCHAT_BRIDGE_POLL_MS,
      ...(smalltoakCertFile ? { SMALLTOAK_CERT_FILE: smalltoakCertFile } : {}),
    });
    const bridgeArgs = [BRIDGE_BIN, chatId, filePath, '--smalltoak-url', smalltoakUrl];
    if (smalltoakCertFile) bridgeArgs.push('--cert-file', smalltoakCertFile);
    const child = spawn(
      process.execPath, bridgeArgs,
      { stdio: ['ignore', 'ignore', 'inherit'], detached: true, env }
    );
    child.on('error', (err) => warn(`smalltoak bridge failed to start: ${err.message}`));
    child.unref();
    ok(`smalltoak bridge started (PID ${child.pid})  chat-id: ${chatId}`);
  }

  // Post session-open message
  const agentList = invites.length ? invites.join(', ') : 'none';
  appendFileSync(filePath, `[${nowHHMM()} ${humanName}] session open — invited: ${agentList}\n`);

  // Print invite blocks for non-local agents (skip gemma — it's auto-started)
  const agentsToInvite = invites.filter(a => !KNOWN_AGENTS.find(k => k.name === a && k.local));
  if (agentsToInvite.length > 0) {
    section('Agent invites — copy-paste each to the agent\'s session:');
    // Surface the cert path to the invite subprocess so it knows to embed
    // the PEM + fingerprint in TLS-aware invite blocks. If we already had it
    // in env (host case), inheritance covers it; the explicit pass-through
    // covers the prompt-only case where env was empty.
    const inviteEnv = smalltoakCertFile
      ? { ...process.env, SMALLTOAK_CERT_FILE: smalltoakCertFile }
      : process.env;
    for (const agent of agentsToInvite) {
      const inviteArgs = [INVITE_BIN, filePath, agent];
      if (smalltoakUrl && chatId) inviteArgs.push('--smalltoak-url', smalltoakUrl, '--chat-id', chatId);
      const result = spawnSync(process.execPath, inviteArgs, { stdio: 'pipe', env: inviteEnv });
      process.stdout.write(result.stdout.toString());
    }
  }

  // Launch TUI
  section('Opening chat...');
  if (invites.includes('gemma') || invites.some(a => KNOWN_AGENTS.find(k => k.name === a && k.local))) {
    process.stdout.write(`  ${D}@gemma is listening — say ${R}${B}@gemma <question>${R}${D} to talk to it.${R}\n`);
  }
  if (smalltoakUrl) {
    process.stdout.write(`  ${D}Remote agents join via smalltoak chat-id:${R} ${B}${chatId}${R}\n`);
  }
  process.stdout.write('\n');

  rl.close();
  spawnSync(process.execPath, [CHAT_BIN, filePath, '--as', humanName], {
    stdio: 'inherit',
    env: { ...process.env, BIRDCHAT_AGENT: humanName },
  });
}

// ── --join <chat-id>: rejoin a saved session ──────────────────────────────────

async function joinSession(chatId) {
  const session = loadSession(chatId);
  if (!session) {
    process.stderr.write(`No saved session "${chatId}". Run the wizard without --join to create one.\n`);
    process.exit(1);
  }

  const { filePath, smalltoakUrl, smalltoakCertFile, humanName } = session;

  if (!existsSync(filePath)) {
    mkdirSync(resolve(filePath, '..'), { recursive: true });
    writeFileSync(filePath, '');
  }

  // Start smalltoak bridge if session uses it. Re-thread the pinned cert
  // recorded at session-create time — required for https:// URLs (the
  // bridge fail-closes without it). For http:// the value is unused.
  if (smalltoakUrl) {
    const env = spawnEnv({
      SMALLTOAK_TOKEN: process.env.SMALLTOAK_TOKEN || '',
      TREEBIRD_MACHINE: process.env.TREEBIRD_MACHINE,
      BIRDCHAT_BRIDGE_POLL_MS: process.env.BIRDCHAT_BRIDGE_POLL_MS,
      ...(smalltoakCertFile ? { SMALLTOAK_CERT_FILE: smalltoakCertFile } : {}),
    });
    const bridgeArgs = [BRIDGE_BIN, chatId, filePath, '--smalltoak-url', smalltoakUrl];
    if (smalltoakCertFile) bridgeArgs.push('--cert-file', smalltoakCertFile);
    const child = spawn(
      process.execPath, bridgeArgs,
      { stdio: ['ignore', 'ignore', 'inherit'], detached: true, env }
    );
    child.on('error', (err) => process.stderr.write(`bridge failed to start: ${err.message}\n`));
    child.unref();
    process.stdout.write(`bridge started (PID ${child.pid})  chat-id: ${chatId}\n`);
  }

  // Open TUI directly
  spawnSync(process.execPath, [CHAT_BIN, filePath, '--as', humanName || ''], {
    stdio: 'inherit',
    env: { ...process.env, BIRDCHAT_AGENT: humanName || '' },
  });
}

// ── Entry point ───────────────────────────────────────────────────────────────

const joinIdx = process.argv.indexOf('--join');
if (joinIdx !== -1) {
  const chatId = process.argv[joinIdx + 1];
  if (!chatId || chatId.startsWith('--')) {
    process.stderr.write('usage: treebird-chat-wizard --join <chat-id>\n');
    process.exit(1);
  }
  joinSession(chatId).catch(e => {
    process.stderr.write(`join error: ${e.stack || e.message}\n`);
    process.exit(1);
  });
} else {
  main().catch(e => {
    process.stderr.write(`wizard error: ${e.stack || e.message}\n`);
    rl.close();
    process.exit(1);
  });
}
