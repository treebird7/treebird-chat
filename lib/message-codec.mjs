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

export function encodeLine({ agent, time, text, instance = null, date = null }) {
  if (!agent) throw new Error('Message agent is required');
  // Frozen format: [<date >?HH:MM agent<#N>?] text. Date omitted by default (the
  // day-separator decision); instance is the no-space #N marker. Preserves a
  // round-trip: decodeLine(encodeLine(x)) keeps agent + instance + date.
  const datePart = date ? `${date} ` : '';
  const instPart = instance != null && instance !== '' ? `#${instance}` : '';
  return `[${datePart}${formatUtcHHMM(time)} ${agent}${instPart}] ${sanitizeText(text)}`;
}

export function decodeLine(line) {
  const match = String(line).match(FLAT_RE);
  if (!match) return null;
  const [, date, time, agent, instance, text] = match;
  return { agent: agent.trim(), time, text, instance: instance ?? null, date: date ?? null };
}
