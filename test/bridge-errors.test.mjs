import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatBridgeError, hintFor } from '../lib/bridge-errors.mjs';
import { AuthError } from '../lib/smalltoak-transport.mjs';

// Helpers to fabricate the same error shapes Node's fetch + the transport throw.
function fetchError(code) {
  const outer = new Error('fetch failed');
  outer.cause = Object.assign(new Error(code), { code });
  return outer;
}

function transportError(message) {
  return new Error(message);
}

describe('hintFor — network codes', () => {
  it('ECONNREFUSED → lsof hint', () => {
    const h = hintFor(fetchError('ECONNREFUSED'));
    assert.match(h, /not listening|lsof/);
  });

  it('ENOTFOUND → DNS hint', () => {
    const h = hintFor(fetchError('ENOTFOUND'));
    assert.match(h, /DNS/);
  });

  it('ETIMEDOUT → reachability hint', () => {
    const h = hintFor(fetchError('ETIMEDOUT'));
    assert.match(h, /timed out|reachability/i);
  });

  it('EHOSTUNREACH → network hint', () => {
    const h = hintFor(fetchError('EHOSTUNREACH'));
    assert.match(h, /unreachable/);
  });
});

describe('hintFor — TLS', () => {
  it('CERT_HAS_EXPIRED → cert hint', () => {
    const h = hintFor(fetchError('CERT_HAS_EXPIRED'));
    assert.match(h, /cert/i);
  });

  it('plain "certificate" in message → cert hint', () => {
    const h = hintFor(new Error('certificate signature failure'));
    assert.match(h, /cert/i);
  });
});

describe('hintFor — HTTP status from transport messages', () => {
  it('401 in "smalltoak read failed: 401" → token hint', () => {
    const h = hintFor(transportError('smalltoak read failed: 401'));
    assert.match(h, /SMALLTOAK_TOKEN/);
  });

  it('403 → forbidden / tenant hint', () => {
    const h = hintFor(transportError('smalltoak read failed: 403'));
    assert.match(h, /forbidden|tenant/i);
  });

  it('404 → chat-id hint', () => {
    const h = hintFor(transportError('smalltoak read failed: 404'));
    assert.match(h, /chat-id|not found/i);
  });

  it('503 → 5xx server hint', () => {
    const h = hintFor(transportError('smalltoak read failed: 503'));
    assert.match(h, /5xx|server log/);
  });
});

describe('hintFor — semantic / fallback', () => {
  it('AuthError → token hint', () => {
    const h = hintFor(new AuthError());
    assert.match(h, /SMALLTOAK_TOKEN/);
  });

  it('non-array payload → malformed hint', () => {
    const h = hintFor(transportError('smalltoak read returned non-array payload'));
    assert.match(h, /malformed|non-smalltoak/i);
  });

  it('bare "fetch failed" without code → reachability fallback', () => {
    const h = hintFor(new Error('fetch failed'));
    assert.match(h, /curl|reachability/i);
  });

  it('unknown error returns null', () => {
    assert.equal(hintFor(new Error('something totally novel')), null);
  });
});

describe('formatBridgeError', () => {
  it('includes op, code, url, chatId, and hint on network failure', () => {
    const out = formatBridgeError({
      error: fetchError('ECONNREFUSED'),
      op: 'read',
      url: 'http://192.168.100.2:3000',
      chatId: 'nightjar',
    });
    assert.match(out, /\[bridge\] read failed: ECONNREFUSED/);
    assert.match(out, /url=http:\/\/192\.168\.100\.2:3000/);
    assert.match(out, /chatId=nightjar/);
    assert.match(out, /hint=.*lsof/);
  });

  it('extracts HTTP status into the summary line', () => {
    const out = formatBridgeError({
      error: transportError('smalltoak read failed: 404'),
      op: 'read',
      url: 'http://h:3000',
      chatId: 'c',
    });
    assert.match(out, /\[bridge\] read failed: HTTP 404/);
    assert.match(out, /hint=.*chat-id/);
  });

  it('handles AuthError (used by the runner exit-3 path)', () => {
    const out = formatBridgeError({
      error: new AuthError(),
      op: 'auth',
      url: 'http://h:3000',
      chatId: 'c',
    });
    // AuthError has code='AUTH' (more specific than the class name), which the
    // formatter prefers — both unambiguous, AUTH is the code.
    assert.match(out, /\[bridge\] auth failed: AUTH/);
    assert.match(out, /hint=.*SMALLTOAK_TOKEN/);
  });

  it('omits hint line when no hint matches', () => {
    const out = formatBridgeError({
      error: new Error('something totally novel'),
      op: 'read',
      url: 'http://h:3000',
      chatId: 'c',
    });
    assert.doesNotMatch(out, /hint=/);
    // The summary still carries the truncated message.
    assert.match(out, /something totally novel/);
  });

  it('drills through Node fetch cause chain to find the code', () => {
    // fetch failed → cause: undici socket error → cause: { code: 'ECONNREFUSED' }
    const inner = Object.assign(new Error('socket hang up'), { code: 'ECONNREFUSED' });
    const mid = Object.assign(new Error('socket error'), { cause: inner });
    const outer = Object.assign(new Error('fetch failed'), { cause: mid });
    const out = formatBridgeError({
      error: outer, op: 'read', url: 'http://h:3000', chatId: 'c',
    });
    assert.match(out, /ECONNREFUSED/);
    assert.match(out, /hint=.*lsof/);
  });

  it('handles missing url / chatId gracefully', () => {
    const out = formatBridgeError({
      error: fetchError('ECONNREFUSED'),
      op: 'read',
      url: null,
      chatId: null,
    });
    assert.match(out, /\[bridge\] read failed: ECONNREFUSED/);
    assert.doesNotMatch(out, /url=null/);
    assert.doesNotMatch(out, /chatId=null/);
  });
});
