// Shared corrwait loop + reply machinery for @mention-driven agent bridges.
// Callers supply a callLLM(ctx) async function; this module handles everything
// else: identity setup, ACL check, corrwait subprocess, mention scan, reply posting,
// and supervisor restart.
//
// Usage:
//   import { runAgentBridge } from '../lib/bridge-agent-base.mjs';
//   runAgentBridge({ agentLabel, filePath, callLLM, corrwaitBin });
//
// callLLM receives { filePath, contextLines, mentions, question } and must
// return a reply string (or throw on hard failure).

import { readFileSync, existsSync } from 'node:fs';
import { appendLine, appendLines } from './writer.mjs';
import { isAllowed } from './access.mjs';
import { scanForMentions } from './mention-scanner.mjs';
import { supervise } from './corrwait-supervisor.mjs';

export function nowHHMM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function makeLog(label) {
  return (msg) => process.stderr.write(`[${nowHHMM()} ${label}] ${msg}\n`);
}

export function getContext(filePath, n) {
  const lines = readFileSync(filePath, 'utf8').split('\n').filter((l) => l.trim());
  return lines.slice(-n).join('\n');
}

export async function appendReply(filePath, agent, text) {
  const chunks = text
    .split('\n')
    .flatMap((line) => {
      if (line.length <= 200) return [line];
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
    .filter((l) => l.trim());

  await appendLines(filePath, agent, chunks);
}

export async function runAgentBridge({ agentLabel, filePath, contextLines = 30, callLLM, corrwaitBin, log }) {
  const logger = log ?? makeLog(agentLabel);

  if (!existsSync(filePath)) {
    process.stderr.write(`File not found: ${filePath}\n`);
    process.exit(1);
  }

  if (!isAllowed(filePath, agentLabel)) {
    process.stderr.write(
      `"${agentLabel}" not in ACL. Run: treebird-chat-allow ${filePath} ${agentLabel}\n`
    );
    process.exit(1);
  }

  // P3: shared supervisor. Replaces the prior inline `while (true)` loop with
  // the same panic-protected re-arm logic used by treebird-chat-join.
  const result = await supervise({
    corrwaitBin,
    filePath,
    agent: agentLabel,
    errorBackoffMs: 10_000,
    log: logger,
    onError: () => logger('corrwait exited with error — backing off 10s before retry'),
    onWake: async (payload) => {
      const newLines = (payload.newContent || '').split('\n');
      const { mentions } = scanForMentions(newLines, agentLabel, 0);
      if (mentions.length === 0) return;

      const question = mentions.map((m) => `[${m.time} ${m.author}] ${m.text}`).join('\n');
      const context = getContext(filePath, contextLines);

      logger(`@mention from ${mentions[0].author} — calling LLM`);
      try {
        const reply = await callLLM({ filePath, contextLines, mentions, question, context });
        await appendReply(filePath, agentLabel, reply);
        logger(`replied (${reply.length} chars)`);
      } catch (err) {
        logger(`LLM error: ${err.message}`);
        await appendLine(filePath, agentLabel, `(unavailable — ${err.message})`);
      }
    },
  });
  logger(`exiting: ${result.reason}`);
}

export async function supervisedBridge(runFn, log) {
  while (true) {
    try {
      await runFn();
      log('bridge exited normally');
      break;
    } catch (e) {
      log(`bridge crashed: ${e.stack || e.message} — restarting in 5s`);
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
}
