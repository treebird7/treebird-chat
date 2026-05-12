#!/usr/bin/env node
// memosan-bridge.mjs <file> [options]
//
// Watches a treebird-chat file for @memosan mentions, calls memosan's
// /chat endpoint (which performs its own RAG over its SQLite + memoak),
// and posts replies back in flat format. Mirrors gemma-bridge.mjs.
//
// Falls back to /recall when /chat returns empty (LLM backend offline) —
// memosan-the-librarian still has value as a retrieval voice without its
// generation backend.
//
// Options:
//   --memosan <url>     memosan base URL (default: $MEMOSAN_URL or http://localhost:7420)
//   --as <agent>        Identity to post as (default: memosan)
//   --context <n>       Lines of chat history to include as context (default: 30)
//   --timeout <ms>      Per-call timeout (default: 120000)

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgentBridge, supervisedBridge, makeLog } from '../lib/bridge-agent-base.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORRWAIT  = resolve(__dirname, 'corrwait.mjs');

function parseArgs(argv) {
  const args = {
    file:         null,
    memosan:      process.env.MEMOSAN_URL || 'http://localhost:7420',
    as:           'memosan',
    contextLines: 30,
    timeoutMs:    120_000,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if      (a === '--memosan')   args.memosan      = argv[++i];
    else if (a === '--as')        args.as           = argv[++i];
    else if (a === '--context')   args.contextLines = parseInt(argv[++i], 10);
    else if (a === '--timeout')   args.timeoutMs    = parseInt(argv[++i], 10);
    else if (!a.startsWith('--') && !args.file) args.file = a;
  }
  return args;
}

const TERSE_PREFIX =
  'You are participating in a live chat — respond concisely (2–4 sentences). ' +
  'Use plain text, no markdown headers, no preamble. ' +
  'If you have relevant retrieved context from prior flock work, ground your answer in it; ' +
  'otherwise answer directly.\n\n';

function extractQueryFromMention(question) {
  return question.replace(/^\[\d{2}:\d{2}\s+\S+\]\s*/, '').replace(/^@memosan\s*/i, '').trim();
}

function validateHttpUrl(raw, label) {
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error(`Invalid ${label}: ${raw}`); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`${label} must use http/https`);
  return parsed;
}

async function callMemosanRecall(memosanUrl, queryText, timeoutMs) {
  const url = new URL(`/recall?q=${encodeURIComponent(queryText)}`, memosanUrl).toString();
  const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const docs = data.documents || [];
  if (docs.length === 0) return `(librarian: nothing in memory for "${queryText.slice(0, 80)}")`;
  const top = docs.slice(0, 3);
  const lines = [
    `librarian found ${docs.length} relevant ${docs.length === 1 ? 'entry' : 'entries'} (LLM offline, retrieval only):`,
  ];
  for (const d of top) {
    const title = (d.title || `entry-${d.id}`).slice(0, 80);
    const snippet = (d.body || '').replace(/\s+/g, ' ').slice(0, 160).trim();
    lines.push(`  → "${title}" — ${snippet}${snippet.length >= 160 ? '…' : ''}`);
  }
  return lines.join('\n');
}

async function callMemosan({ memosanUrl, timeoutMs, context, question }) {
  const base = validateHttpUrl(memosanUrl, 'memosan URL');
  const message = TERSE_PREFIX + `Recent chat context:\n${context}\n\nMessage addressed to you:\n${question}`;
  const url = new URL('/chat', base).toString();

  let chatFailed = false;
  let chatErr = null;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      chatFailed = true;
      chatErr = `HTTP ${res.status}`;
    } else {
      const data = await res.json();
      if (data.reply && data.reply.trim()) return data.reply.trim();
      chatFailed = true;
      chatErr = `empty reply (intent=${data.intent || 'unknown'}, LLM backend likely offline)`;
    }
  } catch (err) {
    chatFailed = true;
    chatErr = err.message;
  }

  if (chatFailed) {
    process.stderr.write(`[memosan-bridge] /chat failed (${chatErr}); falling back to /recall\n`);
    const queryText = extractQueryFromMention(question);
    if (!queryText) throw new Error(`/chat failed and no query to recall: ${chatErr}`);
    return callMemosanRecall(memosanUrl, queryText, timeoutMs);
  }
  throw new Error('unreachable');
}

async function main() {
  const { file, memosan: memosanUrl, as: agentLabel, contextLines, timeoutMs } =
    parseArgs(process.argv.slice(2));

  if (!file) {
    process.stderr.write(
      'usage: memosan-bridge <file> [--memosan URL] [--as memosan] [--context 30] [--timeout 120000]\n'
    );
    process.exit(1);
  }

  const filePath = resolve(file);
  const log = makeLog('memosan-bridge');

  let memosanBase;
  try {
    memosanBase = validateHttpUrl(memosanUrl, 'memosan URL');
    const health = await fetch(new URL('/health', memosanBase).toString(), {
      signal: AbortSignal.timeout(5_000),
    });
    if (!health.ok) throw new Error(`HTTP ${health.status}`);
  } catch (err) {
    process.stderr.write(`memosan not reachable at ${memosanUrl}: ${err.message}\n`);
    process.exit(1);
  }

  log(`ready — file: ${file}`);
  log(`memosan: ${memosanUrl}  as: ${agentLabel}`);

  await runAgentBridge({
    agentLabel,
    filePath,
    contextLines,
    corrwaitBin: CORRWAIT,
    log,
    callLLM: ({ context, question }) => callMemosan({ memosanUrl, timeoutMs, context, question }),
  });
}

supervisedBridge(main, makeLog('memosan-bridge'));
