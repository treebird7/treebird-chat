import { FLAT_RE } from './watcher.mjs';

function formatUtcHHMM(value) {
  if (typeof value === 'string' && /^\d{2}:\d{2}$/.test(value)) return value;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid message time: ${value}`);
  }
  return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
}

function sanitizeText(text) {
  return String(text ?? '').replace(/\r?\n/g, ' ').trimEnd();
}

export function encodeLine({ agent, time, text }) {
  if (!agent) throw new Error('Message agent is required');
  return `[${formatUtcHHMM(time)} ${agent}] ${sanitizeText(text)}`;
}

export function decodeLine(line) {
  const match = String(line).match(FLAT_RE);
  if (!match) return null;
  const [, time, agent, text] = match;
  return { agent, time, text };
}
