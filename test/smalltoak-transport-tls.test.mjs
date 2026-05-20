// Tests for the cert-pinning behavior of createSmalltoakTransport.
//
// These map 1:1 to the spec's "Security success criteria":
//   1. Mismatched cert → connection rejected (real cert mismatch, not asserted)
//   2. SMALLTOAK_TOKEN not transmitted before validation passes
//   3. Fail-closed: https:// + no pin → error, no silent fallback
//   4. (Option B trap — N/A: we picked Option A, this is the absence test)
//   5. Plain http:// still works with an "unencrypted" warning
//
// The pin trick: passing a server's self-signed cert as `ca` makes that cert
// its own trust root. A server presenting a DIFFERENT self-signed cert has
// no path to the trust anchor — handshake fails — node:https destroys the
// socket before any req.write() data leaves. The "token not transmitted"
// check below tests this empirically: we run a TLS-MITM and check the
// MITM never saw the bearer header.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createTcpServer, connect as tcpConnect } from 'node:net';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  createSmalltoakTransport,
  _resetUnencryptedWarnedForTests,
} from '../lib/smalltoak-transport.mjs';
import { fingerprintFromPem, validatePem, loadPin } from '../lib/smalltoak-pin.mjs';

// ── Cert generation ──────────────────────────────────────────────────────────
//
// Two self-signed certs in a temp dir at suite start. openssl is a hard
// dependency of this test — every dev box we run on has it (macOS bundles
// LibreSSL, Linux ships openssl) and committing static fixtures means a
// constant-time test setup but creates "the fixture cert expired" rot.

function generateSelfSignedCert(workDir, name, cn) {
  const keyPath = join(workDir, `${name}.key`);
  const certPath = join(workDir, `${name}.crt`);
  execFileSync('openssl', [
    'req', '-x509',
    '-newkey', 'rsa:2048',
    '-keyout', keyPath,
    '-out', certPath,
    '-days', '1',
    '-nodes',
    '-subj', `/CN=${cn}`,
  ], { stdio: ['ignore', 'ignore', 'ignore'] });
  return { keyPath, certPath, key: readFileSync(keyPath, 'utf8'), cert: readFileSync(certPath, 'utf8') };
}

const workDir = mkdtempSync(join(tmpdir(), 'smalltoak-tls-test-'));
const certA = generateSelfSignedCert(workDir, 'a', 'smalltoak-test-a');
const certB = generateSelfSignedCert(workDir, 'b', 'smalltoak-test-b');

test.after(() => {
  try { rmSync(workDir, { recursive: true, force: true }); } catch {}
});

// Spin up a real https server that records every request it receives — used
// to detect (a) successful pinned connections and (b) whether the bearer
// token leaked despite a failed handshake.
function startHttpsServer(certPem, keyPem) {
  const received = [];
  const server = createHttpsServer({ cert: certPem, key: keyPem }, (req, res) => {
    received.push({ method: req.method, url: req.url, headers: req.headers });
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received[received.length - 1].body = body;
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      // The transport's .read() wants a JSON array.
      res.end('[]');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        received,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('https:// + no pin → throws fail-closed at construction', () => {
  assert.throws(
    () => createSmalltoakTransport({
      baseUrl: 'https://127.0.0.1:9999',
      token: 'secret-token',
      sender: 'test',
    }),
    /requires a pin/,
    'should refuse https without a pin'
  );
});

test('https:// + matching pin → request succeeds', async (t) => {
  const server = await startHttpsServer(certA.cert, certA.key);
  t.after(() => server.close());

  const transport = createSmalltoakTransport({
    baseUrl: `https://127.0.0.1:${server.port}`,
    token: 'secret-token',
    sender: 'test',
    pin: certA.cert,
  });

  const messages = await transport.read({ chatId: 'x', sinceId: 0 });
  assert.deepEqual(messages, []);
  assert.equal(server.received.length, 1, 'server should have received the request');
  assert.equal(
    server.received[0].headers.authorization,
    'Bearer secret-token',
    'auth header reached the (correct) server'
  );
});

test('https:// + mismatched pin → request rejected AND token not leaked', async (t) => {
  // Server presents cert B, client pins cert A — handshake must fail.
  const server = await startHttpsServer(certB.cert, certB.key);
  t.after(() => server.close());

  const transport = createSmalltoakTransport({
    baseUrl: `https://127.0.0.1:${server.port}`,
    token: 'secret-token',
    sender: 'test',
    pin: certA.cert,
  });

  await assert.rejects(
    () => transport.read({ chatId: 'x', sinceId: 0 }),
    (err) => {
      // node:tls failure surface — error code lives in `code`, message
      // contains "self-signed"/"unable to verify"/"certificate". Any of
      // those proves the handshake failed.
      const msg = String(err.message || err);
      const code = String(err.code || '');
      return (
        code.startsWith('UNABLE_TO_VERIFY') ||
        code === 'CERT_HAS_EXPIRED' ||
        code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
        code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
        /self[- ]signed/i.test(msg) ||
        /unable to (verify|get)/i.test(msg) ||
        /certificate/i.test(msg)
      );
    },
    'expected a TLS cert validation failure'
  );

  // The CRITICAL claim: even though the server was running, it must NEVER
  // have seen our Authorization header. If it did, the pin failed open and
  // the token leaked. Server-side request count is the empirical proof.
  assert.equal(
    server.received.length,
    0,
    `token leaked: server received ${server.received.length} request(s) despite failed pin`
  );
});

// In addition to the standard mismatch (where the server has a valid but
// different self-signed cert), verify a TLS-MITM — a different process
// answering on the same port with a different cert — is also rejected.
// This is the threat the pin actually defends against on a LAN.
test('https:// + MITM with substituted cert → rejected, token not leaked', async (t) => {
  // Pretend cert A is the "real" server cert; the MITM serves cert B.
  const mitm = await startHttpsServer(certB.cert, certB.key);
  t.after(() => mitm.close());

  const transport = createSmalltoakTransport({
    baseUrl: `https://127.0.0.1:${mitm.port}`,
    token: 'secret-token',
    sender: 'test',
    pin: certA.cert,
  });

  await assert.rejects(() => transport.post({
    chatId: 'x',
    agent: 'test',
    text: 'leak-check',
    time: '00:00',
  }));

  assert.equal(mitm.received.length, 0, 'MITM received a request despite pin mismatch');
});

test('http:// still works and emits an unencrypted warning', async (t) => {
  // Capture stderr writes for the duration of this test.
  _resetUnencryptedWarnedForTests();
  const origWrite = process.stderr.write.bind(process.stderr);
  let captured = '';
  process.stderr.write = (chunk, ...rest) => { captured += String(chunk); return true; };
  t.after(() => { process.stderr.write = origWrite; });

  const transport = createSmalltoakTransport({
    baseUrl: 'http://127.0.0.1:9999',
    token: 'secret-token',
    sender: 'test',
  });

  assert.ok(captured.includes('plain http://'), `expected unencrypted warning, got: ${captured}`);
  // We don't actually hit the http server; just confirm the warning fired
  // at construction and the transport is shaped right.
  assert.equal(typeof transport.read, 'function');
  assert.equal(typeof transport.post, 'function');
});

test('warning only fires once per process', async () => {
  _resetUnencryptedWarnedForTests();
  const origWrite = process.stderr.write.bind(process.stderr);
  let captured = '';
  process.stderr.write = (chunk) => { captured += String(chunk); return true; };

  try {
    createSmalltoakTransport({ baseUrl: 'http://127.0.0.1:9999', sender: 't' });
    createSmalltoakTransport({ baseUrl: 'http://127.0.0.1:9998', sender: 't' });
  } finally {
    process.stderr.write = origWrite;
  }

  const warnings = captured.split('\n').filter((l) => l.includes('plain http://'));
  assert.equal(warnings.length, 1, `expected exactly one warning, got ${warnings.length}`);
});

test('fetchImpl override bypasses pin enforcement (for tests)', () => {
  // Caller-supplied fetchImpl is the test injection point; it must work
  // even on an https:// URL without a pin, because the test caller is
  // wiring up its own transport (not making a real socket).
  const transport = createSmalltoakTransport({
    baseUrl: 'https://127.0.0.1:9999',
    token: 'secret-token',
    sender: 'test',
    fetchImpl: async () => ({ ok: true, status: 200, async json() { return []; } }),
  });
  assert.equal(typeof transport.read, 'function');
});

// ── Pin helpers ──────────────────────────────────────────────────────────────

test('validatePem accepts a real cert', () => {
  assert.doesNotThrow(() => validatePem(certA.cert));
});

test('validatePem rejects garbage', () => {
  assert.throws(() => validatePem('not a cert'), /not a PEM/);
  assert.throws(() => validatePem(''), /not a PEM/);
  assert.throws(() => validatePem(null), /not a PEM/);
});

test('validatePem rejects malformed PEM bodies', () => {
  const broken =
    '-----BEGIN CERTIFICATE-----\nnot-base64-garbage\n-----END CERTIFICATE-----\n';
  assert.throws(() => validatePem(broken), /does not parse/);
});

test('fingerprintFromPem is stable and differs per cert', () => {
  const fpA1 = fingerprintFromPem(certA.cert);
  const fpA2 = fingerprintFromPem(certA.cert);
  const fpB = fingerprintFromPem(certB.cert);
  assert.equal(fpA1, fpA2);
  assert.notEqual(fpA1, fpB);
  assert.match(fpA1, /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/, 'colon-separated SHA-256 hex');
});

test('loadPin reads + validates from disk', () => {
  const pem = loadPin(certA.certPath);
  assert.equal(pem, certA.cert);
});

test('loadPin throws with file path on missing file', () => {
  assert.throws(
    () => loadPin('/nonexistent/cert.pem'),
    /\/nonexistent\/cert.pem/,
    'error should name the file path'
  );
});
