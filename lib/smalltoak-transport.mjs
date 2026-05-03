import { decodeLine, encodeLine } from './message-codec.mjs';

export class AuthError extends Error {
  constructor(message = 'smalltoak authentication failed') {
    super(message);
    this.name = 'AuthError';
    this.code = 'AUTH';
  }
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '');
}

function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function normalizeMessage(message) {
  const rawText = String(message?.text ?? '');
  const decoded = decodeLine(rawText);
  return {
    id: Number(message?.id),
    agent: decoded?.agent ?? String(message?.from ?? 'unknown'),
    text: decoded?.text ?? rawText,
    time: decoded?.time || message?.ts || message?.created_at || new Date().toISOString(),
    rawText,
    sender: message?.from ?? null,
    recipient: message?.to ?? null,
  };
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function createSmalltoakTransport({ baseUrl, token, sender, fetchImpl = globalThis.fetch }) {
  const root = normalizeBaseUrl(baseUrl);
  if (!root) throw new Error('smalltoak base URL is required');
  if (typeof fetchImpl !== 'function') throw new Error('global fetch is not available');

  return {
    sender,

    async read({ chatId, sinceId = 0 }) {
      const url = new URL(`${root}/messages`);
      url.searchParams.set('to', chatId);

      const response = await fetchImpl(url, {
        headers: {
          Accept: 'application/json',
          ...authHeaders(token),
        },
      });

      if (response.status === 401) throw new AuthError();
      if (!response.ok) {
        throw new Error(`smalltoak read failed: ${response.status}`);
      }

      const data = await readJson(response);
      if (!Array.isArray(data)) {
        throw new Error('smalltoak read returned non-array payload');
      }

      return data
        .map(normalizeMessage)
        .filter((message) => Number.isInteger(message.id) && message.id > sinceId)
        .sort((a, b) => a.id - b.id);
    },

    async post({ chatId, agent, text, time }) {
      const response = await fetchImpl(`${root}/messages`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...authHeaders(token),
        },
        body: JSON.stringify({
          from: sender,
          to: chatId,
          text: encodeLine({ agent, text, time }),
        }),
      });

      if (response.status === 401) throw new AuthError();
      if (!response.ok) {
        throw new Error(`smalltoak post failed: ${response.status}`);
      }

      const data = await readJson(response);
      return normalizeMessage(data);
    },
  };
}
