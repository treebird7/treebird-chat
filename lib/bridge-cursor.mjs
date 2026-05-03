import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';

function uniqSortedNumbers(values) {
  return [...new Set(values.filter((value) => Number.isInteger(value) && value > 0))].sort((a, b) => a - b);
}

function normalizePendingPosts(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value
    .filter((entry) => Number.isInteger(entry?.lineNo) && entry.lineNo > 0 && typeof entry?.line === 'string')
    .sort((a, b) => a.lineNo - b.lineNo)
    .filter((entry) => {
      if (seen.has(entry.lineNo)) return false;
      seen.add(entry.lineNo);
      return true;
    })
    .map((entry) => ({ lineNo: entry.lineNo, line: entry.line }));
}

function normalizePostedMessages(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value
    .filter((entry) => Number.isInteger(entry?.id) && entry.id > 0 && typeof entry?.line === 'string')
    .sort((a, b) => a.id - b.id)
    .filter((entry) => {
      if (seen.has(entry.id)) return false;
      seen.add(entry.id);
      return true;
    })
    .map((entry) => ({ id: entry.id, line: entry.line }));
}

export function normalizeCursor(chatId, value = {}) {
  return {
    chatId,
    lastSmalltoakId: Number.isInteger(value.lastSmalltoakId) && value.lastSmalltoakId > 0 ? value.lastSmalltoakId : 0,
    lastFileLine: Number.isInteger(value.lastFileLine) && value.lastFileLine > 0 ? value.lastFileLine : 0,
    selfInsertedLines: uniqSortedNumbers(value.selfInsertedLines ?? []),
    pendingPosts: normalizePendingPosts(value.pendingPosts),
    postedMessages: normalizePostedMessages(value.postedMessages),
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
  };
}

export function createFileCursorStore(file) {
  const path = `${file}.bridge-cursor.json`;

  return {
    path,
    async load(chatId) {
      if (!existsSync(path)) return normalizeCursor(chatId);
      try {
        const raw = JSON.parse(await readFile(path, 'utf8'));
        return normalizeCursor(chatId, raw);
      } catch (error) {
        throw new Error(`Failed to parse cursor ${path}: ${error.message}`);
      }
    },
    async save(chatId, cursor) {
      const next = normalizeCursor(chatId, cursor);
      next.updatedAt = new Date().toISOString();
      await writeFile(path, JSON.stringify(next, null, 2) + '\n');
      return next;
    },
  };
}
