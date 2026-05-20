// Structured error formatting for the smalltoak bridge.
//
// Today's bare `read error: fetch failed` gives an operator no signal whether
// it's a typo'd URL, a server down, a missing token, or a certificate mismatch.
// formatBridgeError() turns the same caught error into a 2-line block that
// names the URL, the op, and a one-line hint for the most common causes.

// Hint catalog. Each entry: a probe function over (message, code, status)
// returning a one-line operator hint, or null when the probe doesn't match.
// Order matters — first match wins, so put more specific probes first.
const HINTS = [
  // Node fetch / undici-wrapped network errors. The cause chain is where the
  // real code lives; Node surfaces a generic `fetch failed` on the outer error.
  {
    match: ({ code }) => code === 'ECONNREFUSED',
    hint: 'smalltoak server is not listening at that address — check the URL, or run `lsof -iTCP:3000` on the host',
  },
  {
    match: ({ code }) => code === 'ENOTFOUND' || code === 'EAI_AGAIN',
    hint: 'DNS lookup failed — the hostname does not resolve from this machine',
  },
  {
    match: ({ code }) => code === 'ETIMEDOUT' || code === 'ECONNRESET',
    hint: 'connection timed out / reset — check LAN reachability and any firewall between this machine and the host',
  },
  {
    match: ({ code }) => code === 'EHOSTUNREACH' || code === 'ENETUNREACH',
    hint: 'host/network unreachable — wrong subnet, VPN down, or interface flapped',
  },
  // TLS / cert pinning failures (PR #5).
  {
    match: ({ code, message }) =>
      code === 'CERT_HAS_EXPIRED' ||
      code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
      code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
      code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
      /certificate|\bTLS\b/i.test(message),
    hint: 'TLS handshake failed — the server cert does not match the pinned cert (--cert-file / SMALLTOAK_CERT_FILE). Re-fetch the cert from /invite output',
  },
  // HTTP status from the smalltoak server. The transport wraps these as
  // `smalltoak {read,post} failed: <status>` — extract the status.
  {
    match: ({ status }) => status === 401,
    hint: 'SMALLTOAK_TOKEN missing, stale, or revoked — re-fetch via `envoak vault get treebird-chat SMALLTOAK_TOKEN`',
  },
  {
    match: ({ status }) => status === 403,
    hint: 'authenticated but forbidden — token may belong to a different tenant',
  },
  {
    match: ({ status }) => status === 404,
    hint: 'smalltoak chat-id not found on this server — wrong server, or chat was never created here',
  },
  {
    match: ({ status }) => typeof status === 'number' && status >= 500,
    hint: 'smalltoak server returned 5xx — check the server log on the host',
  },
  // Schema / shape problems the transport caught itself.
  {
    match: ({ message }) => /non-array payload/.test(message),
    hint: 'smalltoak response was malformed (not a JSON array) — likely hit a non-smalltoak service on that URL',
  },
  // Authentication wrapper from the transport.
  {
    match: ({ name }) => name === 'AuthError',
    hint: 'SMALLTOAK_TOKEN missing, stale, or revoked — re-fetch via `envoak vault get treebird-chat SMALLTOAK_TOKEN`',
  },
  // Last-resort generic fetch failure with no code (some Node versions don't
  // bubble the code up). Better than nothing.
  {
    match: ({ message }) => /fetch failed/i.test(message),
    hint: 'network reachability problem — verify the URL with `curl -sS <url>/messages?to=<chat-id>` from this host',
  },
];

// Extract a status code from a transport error like "smalltoak read failed: 404".
// Returns NaN when the message doesn't carry one.
function extractStatus(error) {
  if (typeof error?.status === 'number') return error.status;
  const m = /failed:\s*(\d{3})\b/.exec(error?.message ?? '');
  return m ? Number(m[1]) : NaN;
}

// Drill through Node's `cause` chain to find the deepest code — fetch wraps
// the underlying ECONNREFUSED inside `error.cause` (sometimes 2 levels deep
// when undici → AbortSignal → socket).
function extractCode(error) {
  let cur = error;
  for (let i = 0; i < 4 && cur; i++) {
    if (cur.code) return cur.code;
    cur = cur.cause;
  }
  return undefined;
}

export function hintFor(error) {
  const probe = {
    code:    extractCode(error),
    status:  extractStatus(error),
    message: String(error?.message ?? ''),
    name:    error?.name ?? '',
  };
  for (const { match, hint } of HINTS) {
    if (match(probe)) return hint;
  }
  return null;
}

// Format a caught bridge error for stderr. Returns a single string with one
// or two newlines. Callers pass the operation, URL, and chatId — everything
// needed to make the error actionable without grepping logs for context.
export function formatBridgeError({ error, op, url, chatId }) {
  const code = extractCode(error);
  const status = extractStatus(error);
  // Prefer specific signals (code, status, named subclass) over the bare
  // message. `Error.name` of plain `new Error(...)` is just "Error" — skip
  // that and surface the message instead.
  const name = error?.name && error.name !== 'Error' ? error.name : null;
  const summary =
    code ||
    (Number.isInteger(status) ? `HTTP ${status}` : null) ||
    name ||
    (error?.message ? error.message.split('\n')[0].slice(0, 80) : 'unknown error');
  const hint = hintFor(error);

  const lines = [`[bridge] ${op} failed: ${summary}`];
  const ctx = [];
  if (url) ctx.push(`url=${url}`);
  if (chatId) ctx.push(`chatId=${chatId}`);
  if (ctx.length) lines.push(`  ${ctx.join('  ')}`);
  if (hint) lines.push(`  hint=${hint}`);
  return lines.join('\n');
}
