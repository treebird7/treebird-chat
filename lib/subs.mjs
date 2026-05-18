// Sub-collab lifecycle helpers — shared by treebird-chat.mjs (TUI) and
// treebird-chat-join.mjs (corrwait/bridge runner).

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { appendLines } from './writer.mjs';

export function subsPath(chatFile) {
  return `${chatFile}.subs.json`;
}

export function readSubs(chatFile) {
  const p = subsPath(chatFile);
  if (!existsSync(p)) return [];
  try { return JSON.parse(readFileSync(p, 'utf8')).subs ?? []; }
  catch { return []; }
}

export function writeSubs(chatFile, subs) {
  writeFileSync(subsPath(chatFile), JSON.stringify({ subs }, null, 2) + '\n');
}

export function addSub(chatFile, entry) {
  const subs = readSubs(chatFile).filter(s => s.file !== entry.file);
  writeSubs(chatFile, [...subs, entry]);
}

// Mark a sub as closed in the parent's .subs.json and post a [system] summary
// line into the parent chat file.
export async function closeSubInParent(parentFile, subFile, summary, agent) {
  if (!existsSync(parentFile)) return;

  const subs = readSubs(parentFile).map(s =>
    s.file === subFile ? { ...s, status: 'closed', closedAt: nowHHMM() } : s
  );
  writeSubs(parentFile, subs);

  const subLabel = basename(subFile, extname(subFile));
  const summaryText = summary?.trim() || autoSummary(subFile);
  const line = summaryText
    ? `/close [[${subLabel}]] — ${summaryText}`
    : `/close [[${subLabel}]]`;

  await appendLines(parentFile, agent ?? 'system', [line]);
}

// Read the last few protocol lines of a sub file and produce a terse summary.
function autoSummary(subFile) {
  if (!existsSync(subFile)) return '';
  try {
    const lines = readFileSync(subFile, 'utf8').split('\n').filter(Boolean);
    const FLAT_RE = /^\[(\d{2}:\d{2})\s+([A-Za-z][A-Za-z0-9_-]*)\]\s?(.*)$/;
    // Last 3 protocol lines, joined with " · "
    const protocol = lines.filter(l => FLAT_RE.test(l)).slice(-3);
    if (!protocol.length) return '';
    return protocol
      .map(l => { const m = FLAT_RE.exec(l); return m ? `${m[2]}: ${m[3].slice(0, 60)}` : ''; })
      .filter(Boolean)
      .join(' · ');
  } catch {
    return '';
  }
}

function nowHHMM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
