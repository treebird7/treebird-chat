#!/usr/bin/env node
// gemma-bridge.mjs <file> [options]
//
// Watches a treebird-chat file for @gemma mentions, calls LM Studio,
// and posts replies back in flat format. Runs as a background bridge —
// start it before or during a session.
//
// Options:
//   --lm-studio <url>   LM Studio base URL (default: $LM_STUDIO_URL or http://localhost:8082)
//   --model <id>        Model ID (default: $GEMMA_MODEL or google/gemma-4-26b-a4b)
//   --as <agent>        Identity to post as (default: gemma)
//   --context <n>       Lines of chat history to include as context (default: 30)

import { resolve, dirname } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { appendLine, appendLines } from '../lib/writer.mjs';
import { verifyAgentIdentity } from '../lib/identity.mjs';
import { isAllowed } from '../lib/access.mjs';
import { scanForMentions } from '../lib/mention-scanner.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORRWAIT  = resolve(__dirname, 'corrwait.mjs');

// ── Args ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    file:        null,
    lmStudio:    process.env.LM_STUDIO_URL  || 'http://localhost:8082',
    model:       process.env.GEMMA_MODEL    || 'google/gemma-4-26b-a4b',
    as:          'gemma',
    contextLines: 30,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if      (a === '--lm-studio') args.lmStudio    = argv[++i];
    else if (a === '--model')     args.model        = argv[++i];
    else if (a === '--as')        args.as           = argv[++i];
    else if (a === '--context')   args.contextLines = parseInt(argv[++i], 10);
    else if (!a.startsWith('--') && !args.file) args.file = a;
  }
  return args;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function nowHHMM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function log(msg) {
  process.stderr.write(`[${nowHHMM()} gemma-bridge] ${msg}\n`);
}

function getContext(filePath, n) {
  const lines = readFileSync(filePath, 'utf8').split('\n').filter(l => l.trim());
  return lines.slice(-n).join('\n');
}

async function appendReply(filePath, agent, text) {
  const chunks = text
    .split('\n')
    .flatMap(line => {
      if (line.length <= 200) return [line];
      // Wrap at word boundaries; fall back to hard cut for unbreakable runs.
      const parts = [];
      let remaining = line;
      while (remaining.length > 200) {
        const cut = remaining.lastIndexOf(' ', 200);
        const pos = cut > 0 ? cut : 200;
        parts.push(remaining.slice(0, pos));
        remaining = remaining.slice(pos).trimStart();
      }
      if (remaining) parts.push(remaining);
      return parts;
    })
    .filter(l => l.trim());

  await appendLines(filePath, agent, chunks);
}

// ── LM Studio call ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Gemma, a local AI model participating in a treebird-chat session. \
You can see recent chat history for context. Respond directly and concisely — this is a live chat, \
not a document. Keep replies short (2–4 sentences) unless a technical question genuinely needs more. \
Use plain text. No markdown headers. No preamble like "Sure!" or "Of course!".`;

async function callGemma(lmStudio, model, context, question) {
  const userMsg = `Recent chat context:\n${context}\n\nMessage addressed to you:\n${question}`;
  const payload = JSON.stringify({
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: userMsg },
    ],
    temperature: 0.3,
    max_tokens:  512,
  });

  const url = new URL('/v1/chat/completions', lmStudio).toString();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data.choices[0].message.content.trim();
}

// ── corrwait subprocess ───────────────────────────────────────────────────────

function runCorrwait(filePath, agent) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CORRWAIT, filePath, '--as', agent, '--timeout', '540'], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
    child.stdout.on('data', d => { out += d.toString(); });
    child.on('error', () => resolve({ reason: 'ERROR' }));
    child.on('close', () => {
      try   { resolve(JSON.parse(out.trim())); }
      catch { resolve({ reason: 'ERROR' }); }
    });
  });
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function main() {
  const { file, lmStudio, model, as: agent, contextLines } = parseArgs(process.argv.slice(2));

  if (!file) {
    process.stderr.write(
      'usage: gemma-bridge <file> [--lm-studio URL] [--model ID] [--as gemma] [--context 30]\n'
    );
    process.exit(1);
  }

  const filePath = resolve(file);
  if (!existsSync(filePath)) {
    process.stderr.write(`File not found: ${filePath}\n`);
    process.exit(1);
  }

  // Identity: gemma is a local model, not envoak-backed. Use BIRDCHAT_AGENT.
  process.env.BIRDCHAT_AGENT = agent;

  if (!isAllowed(filePath, agent)) {
    process.stderr.write(
      `"${agent}" not in ACL. Run: treebird-chat-allow ${file} ${agent}\n`
    );
    process.exit(1);
  }

  log(`ready — file: ${file}`);
  log(`LM Studio: ${lmStudio}  model: ${model}`);

  while (true) {
    const result = await runCorrwait(filePath, agent);

    if (result.reason === 'END' || result.reason === 'REVOKED') {
      log(`exiting: ${result.reason}`);
      break;
    }

    if (result.reason === 'TIMEOUT') continue; // corrwait self-resets

    if (result.reason === 'ERROR') {
      log('corrwait exited with error — backing off 10s before retry');
      await new Promise(r => setTimeout(r, 10_000));
      continue;
    }

    if (result.reason === 'WAKE') {
      const newLines = (result.newContent || '').split('\n');
      const { mentions } = scanForMentions(newLines, agent, 0);
      if (mentions.length === 0) continue;

      const question = mentions.map(m => `[${m.time} ${m.author}] ${m.text}`).join('\n');
      const context  = getContext(filePath, contextLines);

      log(`@mention from ${mentions[0].author} — querying LM Studio`);
      try {
        const reply = await callGemma(lmStudio, model, context, question);
        await appendReply(filePath, agent, reply);
        log(`replied (${reply.length} chars)`);
      } catch (err) {
        log(`LM Studio error: ${err.message}`);
        await appendLine(filePath, agent, `(unavailable — ${err.message})`);
      }
      continue;
    }

    log(`unexpected corrwait reason: ${result.reason} — continuing`);
  }
}

async function supervisor() {
  while (true) {
    try {
      await main();
      log('bridge exited normally');
      break;
    } catch (e) {
      log(`bridge crashed: ${e.stack || e.message} — restarting in 5s`);
      await new Promise(r => setTimeout(r, 5_000));
    }
  }
}
supervisor();
