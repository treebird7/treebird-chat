import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { decodeLine, encodeLine } from './message-codec.mjs';
import { validatePem } from './smalltoak-pin.mjs';

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

// Build a fetch-shaped impl backed by node:https with the server cert pinned
// as a trust anchor. The TLS handshake is part of socket setup — if cert
// validation fails the socket is destroyed before the bearer token (which
// lives in `init.body` or `Authorization` headers) is flushed onto the wire.
//
// Why not undici's `dispatcher`? It would require either depending on
// undici as a separate package (Node's bundled copy isn't an importable
// module) or relying on undocumented internals. node:https is built-in,
// stable, and the only-once-per-connection cost of constructing a Request/
// Response shim is negligible against the network round-trip.
function createPinnedHttpsFetch(pin) {
  const agent = new HttpsAgent({
    keepAlive: true,
    ca: pin,
    // The pin IS the trust root. rejectUnauthorized stays true so a server
    // presenting a different cert fails the handshake.
    rejectUnauthorized: true,
    // Skip hostname/IP-SAN matching. LAN self-signed certs typically don't
    // carry the IP they're served from in a SAN; the pin's chain-of-one
    // already proves identity ("this is THE cert we trust").
    checkServerIdentity: () => undefined,
  });

  return function pinnedFetch(input, init = {}) {
    return new Promise((resolve, reject) => {
      let url;
      try {
        url = typeof input === 'string' ? new URL(input) : new URL(input.toString());
      } catch (e) {
        reject(e);
        return;
      }
      if (url.protocol !== 'https:') {
        reject(new Error(`pinned fetch refuses non-https URL ${url}`));
        return;
      }

      const headers = { ...(init.headers || {}) };
      // Body length must match Content-Length on POSTs; node:http(s) computes
      // it from the body buffer when we write+end, but only if we don't set a
      // bogus Content-Length ourselves. We don't — fetch callers in the
      // transport pass headers without Content-Length.
      const body = init.body ?? null;
      if (body && !('Content-Length' in headers) && !('content-length' in headers)) {
        headers['Content-Length'] = Buffer.byteLength(body).toString();
      }

      const req = httpsRequest({
        method: init.method || 'GET',
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        headers,
        agent,
      });

      req.on('response', (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          const text = buffer.toString('utf8');
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            statusText: res.statusMessage || '',
            headers: res.headers,
            async json() { return JSON.parse(text); },
            async text() { return text; },
          });
        });
        res.on('error', reject);
      });

      req.on('error', reject);

      if (body !== null) req.write(body);
      req.end();
    });
  };
}

// One-time stderr nudge when running unencrypted. The bridge is a long-lived
// process; emit once at construction (not per request) so an active session
// isn't spammed but operators still see the warning at startup.
let unencryptedWarned = false;
function warnUnencrypted(baseUrl) {
  if (unencryptedWarned) return;
  unencryptedWarned = true;
  process.stderr.write(
    `[smalltoak] WARNING: ${baseUrl} is plain http:// — token sent unencrypted, ` +
    `MITM-vulnerable on shared networks. Configure TLS + cert pinning for production.\n`
  );
}

// Reset for tests — each test instance should observe the warning independently.
export function _resetUnencryptedWarnedForTests() {
  unencryptedWarned = false;
}

export function createSmalltoakTransport({
  baseUrl,
  token,
  sender,
  pin,
  fetchImpl,
}) {
  const root = normalizeBaseUrl(baseUrl);
  if (!root) throw new Error('smalltoak base URL is required');

  let parsed;
  try { parsed = new URL(root); }
  catch { throw new Error(`smalltoak base URL is not a valid URL: ${baseUrl}`); }

  // Fail-closed: an https:// URL with no pin would silently fall back to
  // the OS trust store, which doesn't trust the LAN self-signed cert — but
  // a determined attacker could install one that does. Refusing outright is
  // the only safe answer when the pin was forgotten.
  if (parsed.protocol === 'https:' && !pin && !fetchImpl) {
    throw new Error(
      'smalltoak https:// URL requires a pin (cert PEM). Pass --cert-file ' +
      'or set SMALLTOAK_CERT_FILE; refusing to connect without a pinned cert.'
    );
  }

  // Validate pin shape at construction (before any network activity) so a
  // wrong-format cert errors at startup, not on the first poll.
  if (pin && !fetchImpl) {
    validatePem(pin, 'smalltoak pin');
  }

  // Resolve the actual fetch impl. Caller-supplied wins (tests inject), then
  // pinned-https for https:// URLs, then global fetch for http://.
  let actualFetch;
  if (fetchImpl) {
    actualFetch = fetchImpl;
  } else if (parsed.protocol === 'https:') {
    actualFetch = createPinnedHttpsFetch(pin);
  } else {
    warnUnencrypted(root);
    if (typeof globalThis.fetch !== 'function') {
      throw new Error('global fetch is not available');
    }
    actualFetch = globalThis.fetch;
  }

  return {
    sender,
    // Exposed so the bridge can include the URL in error messages (issue #6 P4).
    baseUrl: root,

    async read({ chatId, sinceId = 0 }) {
      const url = new URL(`${root}/messages`);
      url.searchParams.set('to', chatId);

      const response = await actualFetch(url, {
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
      const response = await actualFetch(`${root}/messages`, {
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
