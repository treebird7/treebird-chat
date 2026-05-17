#!/usr/bin/env node
// gemma-bridge.mjs <file> [options]
//
// Watches a treebird-chat file for @gemma mentions, calls LM Studio,
// and posts replies back in flat format. Runs as a background bridge —
// start it before or during a session.
//
// Options:
//   --lm-studio <url>   LM Studio base URL (default: $LM_STUDIO_URL or http://localhost:8082)
//   --model <id>        Model ID (default: $GEMMA_MODEL or mlx-community/gemma-4-26b-a4b-it-4bit)
//   --as <agent>        Identity to post as (default: gemma)
//   --context <n>       Lines of chat history to include as context (default: 30)

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgentBridge, supervisedBridge, makeLog } from '../lib/bridge-agent-base.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORRWAIT  = resolve(__dirname, 'corrwait.mjs');

function parseArgs(argv) {
  const args = {
    file:         null,
    lmStudio:     process.env.LM_STUDIO_URL || 'http://localhost:8082',
    model:        process.env.GEMMA_MODEL   || 'mlx-community/gemma-4-26b-a4b-it-4bit',
    as:           'gemma',
    contextLines: 30,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if      (a === '--lm-studio') args.lmStudio     = argv[++i];
    else if (a === '--model')     args.model         = argv[++i];
    else if (a === '--as')        args.as            = argv[++i];
    else if (a === '--context')   args.contextLines  = parseInt(argv[++i], 10);
    else if (!a.startsWith('--') && !args.file) args.file = a;
  }
  return args;
}

const SYSTEM_PROMPT =
  'You are Gemma, a local AI model participating in a treebird-chat session. ' +
  'You can see recent chat history for context. Respond directly and concisely — this is a live chat, ' +
  'not a document. Keep replies short (2–4 sentences) unless a technical question genuinely needs more. ' +
  'Use plain text. No markdown headers. No preamble like "Sure!" or "Of course!".';

function validateHttpUrl(raw, label) {
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error(`Invalid ${label}: ${raw}`); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`${label} must use http/https`);
  return parsed;
}

async function callGemma({ lmStudio, model, context, question }) {
  const base = validateHttpUrl(lmStudio, 'LM Studio URL');
  const userMsg = `Recent chat context:\n${context}\n\nMessage addressed to you:\n${question}`;
  const url = new URL('/v1/chat/completions', base).toString();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: userMsg }],
      temperature: 0.3,
      max_tokens: 512,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error(`Unexpected response: ${JSON.stringify(data)}`);
  return content.trim();
}

async function main() {
  const { file, lmStudio, model, as: agentLabel, contextLines } = parseArgs(process.argv.slice(2));

  if (!file) {
    process.stderr.write(
      'usage: gemma-bridge <file> [--lm-studio URL] [--model ID] [--as gemma] [--context 30]\n'
    );
    process.exit(1);
  }

  const filePath = resolve(file);
  const log = makeLog('gemma-bridge');

  log(`ready — file: ${file}`);
  log(`LM Studio: ${lmStudio}  model: ${model}`);

  await runAgentBridge({
    agentLabel,
    filePath,
    contextLines,
    corrwaitBin: CORRWAIT,
    log,
    callLLM: ({ context, question }) => callGemma({ lmStudio, model, context, question }),
  });
}

supervisedBridge(main, makeLog('gemma-bridge'));
