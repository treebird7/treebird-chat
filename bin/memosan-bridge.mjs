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
// What makes memosan distinct from a generic LLM bridge: memosan retrieves
// from the flock's accumulated knowledge before answering. Use it when you
// want the librarian's voice, not just another chatbot.
//
// KNOWN ISSUES (2026-05-07, will be addressed in B's UX plan P2/P3):
//   - Mention parser fires on @-mentions inside backticks/quoted phrases;
//     a meta-discussion that *names* memosan re-triggers the bridge.
//     Fix: strip backtick spans + quoted strings before scanning. ~3 LOC.
//   - Long replies hard-cut at 200 chars (mid-word splits). Fix: wrap at
//     last space before column 200, hard-cut only as fallback. ~5 LOC.
//
// Options:
//   --memosan <url>     memosan base URL (default: $MEMOSAN_URL or http://localhost:7420)
//   --as <agent>        Identity to post as (default: memosan)
//   --context <n>       Lines of chat history to include as context (default: 30)
//   --timeout <ms>      Per-call timeout (default: 120000)

import { resolve, dirname } from 'node:path';
import { existsSync, appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { isAllowed } from '../lib/access.mjs';
import { scanForMentions } from '../lib/mention-scanner.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORRWAIT  = resolve(__dirname, 'corrwait.mjs');

// ── Args ──────────────────────────────────────────────────────────────────────

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
    if      (a === '--memosan')   args.memosan       = argv[++i];
    else if (a === '--as')        args.as            = argv[++i];
    else if (a === '--context')   args.contextLines  = parseInt(argv[++i], 10);
    else if (a === '--timeout')   args.timeoutMs     = parseInt(argv[++i], 10);
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
  process.stderr.write(`[${nowHHMM()} memosan-bridge] ${msg}\n`);
}

function getContext(filePath, n) {
  const lines = readFileSync(filePath, 'utf8').split('\n').filter(l => l.trim());
  return lines.slice(-n).join('\n');
}

function appendReply(filePath, agent, text) {
  const t = nowHHMM();
  const chunks = text
    .split('\n')
    .flatMap(line => {
      if (line.length <= 200) return [line];
      const parts = [];
      for (let i = 0; i < line.length; i += 200) parts.push(line.slice(i, i + 200));
      return parts;
    })
    .filter(l => l.trim());

  const out = chunks.map(l => `[${t} ${agent}] ${l}`).join('\n') + '\n';
  appendFileSync(filePath, out);
}

// ── memosan call ──────────────────────────────────────────────────────────────

// memosan does its own RAG (retrieval over its SQLite + memoak) inside
// chat_handler. The bridge wraps the chat context + the @mention into a
// single message. The "respond concisely" framing rides in the message
// itself since memosan builds its own system prompt server-side.

const TERSE_PREFIX =
  "You are participating in a live chat — respond concisely (2–4 sentences). " +
  "Use plain text, no markdown headers, no preamble. " +
  "If you have relevant retrieved context from prior flock work, ground your answer in it; " +
  "otherwise answer directly.\n\n";

// Pull the question out of the wrapped chat-mention text. The bridge feeds
// memosan a long context blob, but /recall wants a focused query string.
function extractQueryFromMention(question) {
  // Strip the leading "[HH:MM author] " prefix if present, take the rest.
  return question.replace(/^\[\d{2}:\d{2}\s+\S+\]\s*/, '').replace(/^@memosan\s*/i, '').trim();
}

// Fallback: format /recall results as a librarian-voice response.
async function callMemosanRecall(memosanUrl, queryText, timeoutMs) {
  const url = new URL(`/recall?q=${encodeURIComponent(queryText)}`, memosanUrl).toString();
  const res = await fetch(url, {
    method: 'GET',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const docs = data.documents || [];
  if (docs.length === 0) {
    return `(librarian: nothing in memory for "${queryText.slice(0, 80)}")`;
  }
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

async function callMemosan(memosanUrl, context, question, timeoutMs) {
  const message =
    TERSE_PREFIX +
    `Recent chat context:\n${context}\n\n` +
    `Message addressed to you:\n${question}`;

  const url = new URL('/chat', memosanUrl).toString();
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
      if (data.reply && data.reply.trim()) {
        return data.reply.trim();
      }
      chatFailed = true;
      chatErr = `empty reply (intent=${data.intent || 'unknown'}, LLM backend likely offline)`;
    }
  } catch (err) {
    chatFailed = true;
    chatErr = err.message;
  }

  // Graceful degradation: /chat failed, fall back to /recall (no LLM needed).
  // memosan-the-librarian still has value as a retrieval voice even when its
  // generation backend is down.
  if (chatFailed) {
    process.stderr.write(`[memosan-bridge] /chat failed (${chatErr}); falling back to /recall\n`);
    const queryText = extractQueryFromMention(question);
    if (!queryText) throw new Error(`/chat failed and no query to recall: ${chatErr}`);
    return await callMemosanRecall(memosanUrl, queryText, timeoutMs);
  }
  throw new Error('unreachable');
}

// ── corrwait subprocess ───────────────────────────────────────────────────────

function runCorrwait(filePath, agent) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CORRWAIT, filePath, '--as', agent, '--timeout', '540'], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
    child.stdout.on('data', d => { out += d.toString(); });
    child.on('close', () => {
      try   { resolve(JSON.parse(out.trim())); }
      catch { resolve({ reason: 'ERROR' }); }
    });
  });
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function main() {
  const { file, memosan: memosanUrl, as: agent, contextLines, timeoutMs } =
    parseArgs(process.argv.slice(2));

  if (!file) {
    process.stderr.write(
      'usage: memosan-bridge <file> [--memosan URL] [--as memosan] [--context 30] [--timeout 120000]\n'
    );
    process.exit(1);
  }

  const filePath = resolve(file);
  if (!existsSync(filePath)) {
    process.stderr.write(`File not found: ${filePath}\n`);
    process.exit(1);
  }

  // Identity: memosan is a local model, not envoak-backed. Use BIRDCHAT_AGENT
  // (same pattern as gemma-bridge).
  process.env.BIRDCHAT_AGENT = agent;

  if (!isAllowed(filePath, agent)) {
    process.stderr.write(
      `"${agent}" not in ACL. Run: treebird-chat-allow ${file} ${agent}\n`
    );
    process.exit(1);
  }

  // Pre-flight: confirm memosan is up.
  try {
    const health = await fetch(new URL('/health', memosanUrl).toString(), {
      signal: AbortSignal.timeout(5_000),
    });
    if (!health.ok) throw new Error(`HTTP ${health.status}`);
  } catch (err) {
    process.stderr.write(`memosan not reachable at ${memosanUrl}: ${err.message}\n`);
    process.exit(1);
  }

  log(`ready — file: ${file}`);
  log(`memosan: ${memosanUrl}  as: ${agent}`);

  while (true) {
    const result = await runCorrwait(filePath, agent);

    if (result.reason === 'END' || result.reason === 'REVOKED') {
      log(`exiting: ${result.reason}`);
      break;
    }

    if (result.reason === 'TIMEOUT') continue;

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

      log(`@mention from ${mentions[0].author} — querying memosan`);
      try {
        const reply = await callMemosan(memosanUrl, context, question, timeoutMs);
        appendReply(filePath, agent, reply);
        log(`replied (${reply.length} chars)`);
      } catch (err) {
        log(`memosan error: ${err.message}`);
        appendFileSync(filePath, `[${nowHHMM()} ${agent}] (unavailable — ${err.message})\n`);
      }
    }
  }
}

main().catch(e => {
  process.stderr.write(`memosan-bridge fatal: ${e.stack || e.message}\n`);
  process.exit(1);
});
