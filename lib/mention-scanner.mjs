import { readFileSync, existsSync } from 'node:fs';
import { FLAT_RE, stripInlineCode } from './watcher.mjs';

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Strip machine suffix from a label: "birdsan-m2" → "birdsan"
export function shortName(agentLabel) {
  return agentLabel.replace(/-[a-z0-9]+$/i, '');
}

// Scan `lines` from `fromLine` for @mentions of `agentLabel` or @all.
// Matches @shortname, @full-label, and @all (case-insensitive), not followed
// by word chars (prevents @birdsanother matching @birdsan).
// Prefix @@ = high priority, @@@ = urgent.
// Returns {mentions: [{lineNo, author, time, text, priority}], newCursor}.
export function scanForMentions(lines, agentLabel, fromLine) {
  const short = shortName(agentLabel);
  const pattern =
    `(@+)(all|${escapeRe(short)}|${escapeRe(agentLabel)})(?![A-Za-z0-9_-])`;
  const mentionRe = new RegExp(pattern, 'i');

  const selfShort = short.toLowerCase();
  const selfFull  = agentLabel.toLowerCase();

  const mentions = [];
  for (let i = fromLine; i < lines.length; i++) {
    const m = FLAT_RE.exec(lines[i]);
    if (!m) continue;
    const [, time, author, text] = m;
    const a = author.toLowerCase();
    if (a === selfShort || a === selfFull) continue;
    const match = mentionRe.exec(stripInlineCode(text));
    if (match) {
      const atCount = match[1].length;
      const priority = atCount >= 3 ? 'urgent' : atCount === 2 ? 'high' : 'normal';
      mentions.push({ lineNo: i, author, time, text: text.trim(), priority });
    }
  }
  return { mentions, newCursor: lines.length };
}

export function readLines(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8').split('\n');
}
