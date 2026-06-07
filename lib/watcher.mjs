// Snapshot CORR file content and detect new wake-worthy lines.
//
// Wake-worthy lines:
//   - `## Round N — <from> → <to>`     (new round from any agent)
//   - `**💬 Human [HH:MM]:** ...`       (human comment via inject bar)
//
// End markers:
//   - sidecar file `<CORR_file>.end` exists
//   - human comment matches end-word (case-insensitive substring)

import { readFileSync, existsSync } from 'node:fs';

const ROUND_RE = /^## Round \d+\s*[—\-–]/;
const HUMAN_RE = /^\*\*💬 Human \[\d{2}:\d{2}\]:\*\*/;
const SEPARATOR_RE = /^---\s*$/;
const AWAITING_RE = /^\*\[.+\]\*\s*$/;
// Flat chat-style line: `[12:34 yosef] message text`
// Agent name may carry a parallel-hand suffix: `yosef #2`, `birdsan #3`.
// Frozen line format (cc1 + sasusan consortium, 2026-06-07; aligns the obsidian
// plugin parser and the CLI). Groups: 1=date (YYYY-MM-DD, optional), 2=time
// (HH:MM), 3=agent, 4=instance (#N digits, optional, NO space), 5=message.
// Backward-compatible: old dateless `[HH:MM agent] msg` lines still parse (date
// + instance simply absent). Per sasusan #6, the date is optional and rare — use
// a day-separator line rather than a date on every line.
export const FLAT_RE = /^\[(?:(\d{4}-\d{2}-\d{2}) )?(\d{2}:\d{2}) ([^\]#]+?)(?:#(\d+))?\] ?(.*)$/;

// Timestamp prefix (optional date + time) shared by the per-agent self-detection
// regexes below, so dated lines don't break cursor/self-wake logic. Lenient on
// the inter-token whitespace (`\s+`) since it only matches our own written lines.
const TS_PREFIX = '\\[(?:\\d{4}-\\d{2}-\\d{2}\\s+)?\\d{2}:\\d{2}\\s+';

// A line counts as freeform content if it's not blank, not a `---` separator,
// and not a `*[awaiting...]*` placeholder. Lets humans + agents wake corrwait
// by writing prose directly into the file, without the formal patterns.
function isFreeformContent(line) {
  if (!line.trim()) return false;
  if (SEPARATOR_RE.test(line)) return false;
  if (AWAITING_RE.test(line)) return false;
  return true;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Remove inline code spans before mention-scanning so `@agent` inside
// backticks does not trigger a false wake.
export function stripInlineCode(s) {
  return s.replace(/``[^`]*``/g, '').replace(/`[^`]*`/g, '');
}

export function snapshot(filePath) {
  const content = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
  return {
    length: content.length,
    lines: content.split('\n'),
  };
}

// Implicit cursor: position just past this agent's last contribution.
// Handles both round format (`## Round N — yosef → ...` + body + `---`)
// and flat format (`[HH:MM yosef] msg`). Whichever appears later wins.
// If the agent has never posted, returns 0 (baseline = file start).
export function findCursorAfterLastSelfRound(lines, agent) {
  const roundRe = new RegExp(`^## Round \\d+\\s*[—\\-–]+\\s*${escapeRe(agent)}\\s*[→>\\-]`, 'i');
  const flatRe  = new RegExp(`^${TS_PREFIX}${escapeRe(agent)}(?:#\\d+)?\\]`, 'i');

  let lastRoundIdx = -1;
  let lastFlatIdx  = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lastFlatIdx === -1 && flatRe.test(lines[i])) lastFlatIdx = i;
    if (lastRoundIdx === -1 && roundRe.test(lines[i])) lastRoundIdx = i;
    if (lastFlatIdx !== -1 && lastRoundIdx !== -1) break;
  }

  // Flat-format: advance past any continuation lines (lines without a
  // [HH:MM author] header that follow the agent's last message).
  if (lastFlatIdx > lastRoundIdx) {
    const headerRe = new RegExp(`^${TS_PREFIX}\\S`);
    for (let i = lastFlatIdx + 1; i < lines.length; i++) {
      if (headerRe.test(lines[i])) return i;
    }
    return lines.length;
  }

  // Round-format: skip the body to the closing `---` separator.
  if (lastRoundIdx >= 0) {
    for (let i = lastRoundIdx + 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') return i + 1;
    }
    return lines.length;
  }
  return 0;
}

// Snapshot capped at the agent's implicit cursor, so diff-since-baseline
// surfaces every line written after the agent's last reply — even content
// that landed while corrwait was not running.
export function snapshotAtCursor(filePath, agent) {
  const full = snapshot(filePath);
  const cursor = findCursorAfterLastSelfRound(full.lines, agent);
  return {
    length: full.length,
    lines: full.lines.slice(0, cursor),
  };
}

export function endMarkerPath(filePath) {
  return `${filePath}.end`;
}

export function endMarkerExists(filePath) {
  return existsSync(endMarkerPath(filePath));
}

// Returns array of new wake-worthy lines + flags.
// `agent` (optional): when provided, lines authored by this agent are filtered
// out of wake triggers — round headers (`## Round N — <agent> →`) and flat lines
// (`[HH:MM <agent>] ...`). Suppresses self-wakes when a stale corrwait is still
// blocked at the moment the agent appends a new message. Pass null/'' to keep
// the un-filtered behavior.
export function diffSinceBaseline(filePath, baseline, endWord, agent = null, onMention = null) {
  const current = snapshot(filePath);
  const newLines = current.lines.slice(baseline.lines.length);

  let hasNewRound = false;
  let hasNewHuman = false;
  let hasNewFreeform = false;
  let endViaWord = false;
  const wakeLines = [];

  const endLower = endWord ? endWord.toLowerCase() : null;
  const selfFlatRe = agent ? new RegExp(`^${TS_PREFIX}${escapeRe(agent)}(?:#\\d+)?\\]`, 'i') : null;
  const selfRoundRe = agent ? new RegExp(`^## Round \\d+\\s*[—\\-–]+\\s*${escapeRe(agent)}\\s*[→>\\-]`, 'i') : null;
  const mentionRe = onMention
    ? new RegExp(`@${escapeRe(onMention)}(?![A-Za-z0-9_-])`, 'i')
    : null;

  for (const line of newLines) {
    if (ROUND_RE.test(line)) {
      if (selfRoundRe && selfRoundRe.test(line)) continue;
      hasNewRound = true;
      wakeLines.push(line);
    } else if (HUMAN_RE.test(line)) {
      // Human comments are external by definition — never the running agent.
      hasNewHuman = true;
      wakeLines.push(line);
      if (endLower && line.toLowerCase().includes(endLower)) {
        endViaWord = true;
      }
    } else if (isFreeformContent(line)) {
      if (endLower && line.toLowerCase().includes(endLower)) {
        endViaWord = true;
      }
      if (selfFlatRe && selfFlatRe.test(line)) continue;
      if (mentionRe && !mentionRe.test(stripInlineCode(line))) continue;
      hasNewFreeform = true;
      wakeLines.push(line);
    }
  }

  // Priority detection: scan wakeLines for @@/@@@ mention patterns.
  // @@agent / @@all → high priority; @@@agent / @@@all → urgent (halt everything).
  let priority = 'normal';
  if (agent && wakeLines.length > 0) {
    const shortAgent = agent.replace(/-[a-z0-9]+$/i, '');
    const priorityRe = new RegExp(
      `(@+)(all|${escapeRe(shortAgent)}|${escapeRe(agent)})(?![A-Za-z0-9_-])`, 'gi'
    );
    outer: for (const line of wakeLines) {
      const text = stripInlineCode(line);
      priorityRe.lastIndex = 0;
      let m;
      while ((m = priorityRe.exec(text)) !== null) {
        const atCount = m[1].length;
        if (atCount >= 3) { priority = 'urgent'; break outer; }
        if (atCount === 2) priority = 'high';
      }
    }
  }

  return {
    current,
    newLines,
    wakeLines,
    hasNewRound,
    hasNewHuman,
    hasNewFreeform,
    endViaWord,
    priority,
    woke: hasNewRound || hasNewHuman || hasNewFreeform,
  };
}
