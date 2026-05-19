// Wikilink resolver for treebird-chat.
//
// Parses [[target]] syntax and resolves targets to file paths, types, and
// live-session status. Used by the TUI (/sub, /link, /preview, /open),
// the mobile card preview layer, and corrwait wake metadata.
//
// Link syntax:
//   [[filename]]              any .md in workspace (doc or chat auto-detected)
//   [[filename#section]]      with anchor
//   [[sub:topic]]             sub-collab (sibling to current file)
//   [[task:P2.1]]             STATE.json task entry
//   [[mem:slug]]              memory file (~/.claude/…/memory/<slug>.md)

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { resolve as resolvePath, dirname, basename, extname, join, sep } from 'node:path';
import { homedir } from 'node:os';
import { FLAT_RE } from './watcher.mjs';

// ── Constants ─────────────────────────────────────────────────────────────────

// A file is considered "active" if its bridge-cursor was updated within this window.
const ACTIVE_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

// Lines sampled to classify a file as chat vs doc.
const CLASSIFY_SAMPLE = 30;

// Regex that matches [[target]] or [[target#anchor]].
// Captured groups: 1=target (with optional prefix), 2=anchor (optional, without #).
const WIKILINK_RE = /\[\[([^\]#|]+?)(?:#([^\]]+?))?\]\]/g;

// ── Workspace roots ───────────────────────────────────────────────────────────

// Default search roots. TREEBIRD_WORKSPACE (colon-separated) overrides/extends.
function defaultRoots() {
  const home = homedir();
  return [
    join(home, 'treebird-shared'),
    join(home, 'Dev', 'treebird'),
    join(home, 'Dev', 'treebird-internal'),
  ].filter(existsSync);
}

export function workspaceRoots() {
  const env = process.env.TREEBIRD_WORKSPACE;
  if (env) {
    return env.split(':').map(p => resolvePath(p)).filter(existsSync);
  }
  return defaultRoots();
}

// ── Parsing ───────────────────────────────────────────────────────────────────

// Extract all wikilinks from a text string.
// Returns [{raw, target, prefix, name, anchor}] preserving order.
export function parseLinks(text) {
  const links = [];
  let m;
  WIKILINK_RE.lastIndex = 0;
  while ((m = WIKILINK_RE.exec(text)) !== null) {
    const raw = m[0];
    const full = m[1].trim();
    const anchor = m[2]?.trim() ?? null;

    const colonIdx = full.indexOf(':');
    const prefix = colonIdx > 0 ? full.slice(0, colonIdx) : null;
    const name   = colonIdx > 0 ? full.slice(colonIdx + 1).trim() : full;

    links.push({ raw, target: full, prefix, name, anchor });
  }
  return links;
}

// ── Classification ────────────────────────────────────────────────────────────

// Detect whether a file is a live chat (has protocol lines) or a static doc.
export function classify(filePath) {
  if (!existsSync(filePath)) return 'missing';
  try {
    const content = readFileSync(filePath, 'utf8');
    const lines = content.split('\n').slice(0, CLASSIFY_SAMPLE);
    const isChat = lines.some(l => FLAT_RE.test(l));
    return isChat ? 'chat' : 'doc';
  } catch {
    return 'missing';
  }
}

// ── Active detection ──────────────────────────────────────────────────────────

// A file is "active" (has a live bridge/session) if:
//   - its .bridge-cursor.json sidecar exists and was updated within ACTIVE_WINDOW_MS, OR
//   - its .subs.json entry (if this is a sub) marks it active + recent
export function isActive(filePath) {
  const cursorPath = `${filePath}.bridge-cursor.json`;
  if (existsSync(cursorPath)) {
    try {
      const { updatedAt } = JSON.parse(readFileSync(cursorPath, 'utf8'));
      if (updatedAt && Date.now() - new Date(updatedAt).getTime() < ACTIVE_WINDOW_MS) {
        return true;
      }
    } catch { /* fall through */ }
  }

  // Check parent .subs.json for sub-chat status
  const subsPath = findParentSubsJson(filePath);
  if (subsPath && existsSync(subsPath)) {
    try {
      const { subs = [] } = JSON.parse(readFileSync(subsPath, 'utf8'));
      const entry = subs.find(s => resolvePath(s.file) === resolvePath(filePath));
      if (entry?.status === 'active') return true;
    } catch { /* fall through */ }
  }

  return false;
}

function findParentSubsJson(filePath) {
  // A sub file lives next to its parent; the parent's .subs.json is a sibling.
  // Pattern: parent is any .md in the same dir — scan for .subs.json files there.
  const dir = dirname(filePath);
  try {
    const sidecars = readdirSync(dir).filter(f => f.endsWith('.subs.json'));
    for (const s of sidecars) {
      return join(dir, s);
    }
  } catch { /* ignore */ }
  return null;
}

// ── Resolution ────────────────────────────────────────────────────────────────

// Resolve a wikilink target to { path, type, active, anchor }.
//
// opts:
//   from          — absolute path of the file containing the link (sets sibling dir)
//   workspaceRoots — additional search roots (default: workspaceRoots())
//
// type values: 'chat' | 'doc' | 'sub' | 'task' | 'mem' | 'missing'
export function resolveLink(target, opts = {}) {
  const links = parseLinks(`[[${target}]]`);
  if (!links.length) return { path: null, type: 'missing', active: false, anchor: null };
  return _resolve(links[0], opts);
}

// Resolve a parsed link object (from parseLinks).
export function resolveParsed(link, opts = {}) {
  return _resolve(link, opts);
}

function _resolve(link, opts) {
  const { prefix, name, anchor } = link;
  const from = opts.from ? resolvePath(opts.from) : null;
  const roots = opts.workspaceRoots ?? workspaceRoots();

  if (prefix === 'task') return resolveTask(name, anchor, from);
  if (prefix === 'mem')  return resolveMem(name, anchor);
  if (prefix === 'sub')  return resolveSub(name, anchor, from);

  // Plain [[filename]] — search sibling dir first, then workspace roots.
  const searchDirs = [
    from ? dirname(from) : null,
    ...roots,
  ].filter(Boolean);

  const path = findMarkdown(name, searchDirs);
  if (path) {
    const type = classify(path);
    return { path, type, active: isActive(path), anchor };
  }

  // Fallback: try as sub:<name> — handles "/open device-link" finding
  // "CONSORTIUM_..._sub_device-link_HHmm.md" without a prefix.
  const subFallback = resolveSub(name, anchor, from);
  if (subFallback.path && !subFallback.proposed && existsSync(subFallback.path)) {
    return subFallback;
  }

  return { path: null, type: 'missing', active: false, anchor };
}

// ── Type-specific resolvers ───────────────────────────────────────────────────

function resolveTask(name, anchor, from) {
  // Look for STATE.json in the repo root (walk up from `from`, or workspace roots).
  const stateFile = findFile('STATE.json', from);
  return {
    path: stateFile,
    type: 'task',
    active: false,
    anchor: name,   // task ID becomes the anchor
    taskId: name,
  };
}

function resolveMem(slug, anchor) {
  const home = homedir();
  // Memory directories. A `slug` containing ../ ([[mem:../../../etc/passwd]])
  // would escape them — guard every candidate with isContained().
  const memRoots = [
    join(home, '.claude', 'projects', '-Users-freedbird-Dev-memosan', 'memory'),
    join(home, '.claude', 'projects', '-Users-freedbird-Dev-Toak', 'memory'),
  ];
  const path = memRoots
    .map(root => join(root, `${slug}.md`))
    .filter(candidate => isContained(candidate, memRoots))
    .find(existsSync) ?? null;
  return { path, type: 'mem', active: false, anchor };
}

function resolveSub(topic, anchor, from) {
  if (!from) return { path: null, type: 'sub', active: false, anchor };

  const dir = dirname(from);
  const parentBase = basename(from, '.md');

  // Find existing sub: sibling file matching *_sub_<topic>* pattern.
  const safeTopic = topic.replace(/[^A-Za-z0-9_-]/g, '-');
  const existing = findSubFile(dir, safeTopic);

  if (existing) {
    return { path: existing, type: 'sub', active: isActive(existing), anchor, topic };
  }

  // Not found — return the canonical path it *would* be created at.
  const ts = formatTimestamp();
  const proposed = join(dir, `${parentBase}_sub_${safeTopic}_${ts}.md`);
  return { path: proposed, type: 'sub', active: false, anchor, topic, proposed: true };
}

function findSubFile(dir, topic) {
  try {
    const entries = readdirSync(dir);
    const re = new RegExp(`_sub_${escapeRe(topic)}`, 'i');
    const match = entries.find(f => f.endsWith('.md') && re.test(f));
    return match ? join(dir, match) : null;
  } catch {
    return null;
  }
}

// ── File search ───────────────────────────────────────────────────────────────

// Path-traversal guard. A wikilink target is untrusted text: [[../../../etc/passwd]]
// or [[mem:../../secret]] would otherwise resolve to a file OUTSIDE the intended
// directories. A candidate path is allowed only when it sits inside one of `roots`.
function isContained(candidate, roots) {
  const full = resolvePath(candidate);
  return roots.some(root => {
    const r = resolvePath(root);
    return full === r || full.startsWith(r + sep);
  });
}

// Find a .md file by name (with or without extension) in a list of directories.
// Tries exact name, then adds .md, then case-insensitive prefix match.
function findMarkdown(name, dirs) {
  const withExt = extname(name) ? name : `${name}.md`;

  for (const dir of dirs) {
    if (!existsSync(dir)) continue;

    // Exact match — reject a candidate that escapes `dirs` via ../ traversal.
    const exact = join(dir, withExt);
    if (isContained(exact, dirs) && existsSync(exact)) return exact;

    // Case-insensitive match in the directory (one level only)
    try {
      const lower = withExt.toLowerCase();
      const entries = readdirSync(dir);
      const match = entries.find(e => {
        if (e.toLowerCase() !== lower) return false;
        try { return statSync(join(dir, e)).isFile(); } catch { return false; }
      });
      if (match) return join(dir, match);
    } catch { /* skip unreadable dirs */ }
  }
  return null;
}

// Walk up from `from` (or check workspace roots) to find a file by name.
function findFile(name, from) {
  if (from) {
    let dir = dirname(from);
    for (let i = 0; i < 8; i++) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  for (const root of workspaceRoots()) {
    const candidate = join(root, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatTimestamp() {
  const now = new Date();
  return String(now.getHours()).padStart(2, '0') + String(now.getMinutes()).padStart(2, '0');
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
