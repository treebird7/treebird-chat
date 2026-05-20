// Cert-pinning helpers for the smalltoak transport.
//
// Option A from collab/SPEC_smalltoak_tls_pinning.md — carry the server's
// self-signed cert as PEM and pass it as the TLS `ca` (with
// `checkServerIdentity: () => undefined` to skip hostname/IP-SAN matching
// that LAN-IP self-signed certs typically don't satisfy). Validation happens
// during the TLS handshake; if it fails the socket is destroyed before any
// application bytes — including the bearer token — leave the client.

import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';

const PEM_HEAD = '-----BEGIN CERTIFICATE-----';
const PEM_TAIL = '-----END CERTIFICATE-----';

// Validate a PEM string contains at least one well-formed CERTIFICATE block.
// X509Certificate parses the first block — that's the test we care about:
// "node:tls accepts this as a trust anchor". Anything it rejects we reject.
export function validatePem(pem, source = 'cert') {
  if (typeof pem !== 'string' || !pem.includes(PEM_HEAD) || !pem.includes(PEM_TAIL)) {
    throw new Error(`${source}: not a PEM certificate (missing BEGIN/END CERTIFICATE markers)`);
  }
  try {
    new X509Certificate(pem);
  } catch (e) {
    throw new Error(`${source}: PEM does not parse as an X.509 certificate (${e.message})`);
  }
}

// Read a cert PEM from disk and validate. Returns the PEM string ready to
// pass as `ca` to node:tls. Throws with the file path in the message — the
// caller surfaces that to the user so they can fix the wrong file.
export function loadPin(path) {
  let pem;
  try {
    pem = readFileSync(path, 'utf8');
  } catch (e) {
    throw new Error(`cert-file ${path}: ${e.message}`);
  }
  validatePem(pem, `cert-file ${path}`);
  return pem;
}

// SHA-256 fingerprint of a PEM cert, colon-separated uppercase hex. Used in
// the invite block as a human-verifiable checksum of the carried cert — the
// invitee can compare it against `openssl x509 -fingerprint -sha256 -noout`
// run on the server side to confirm no tampering in transit.
export function fingerprintFromPem(pem) {
  return new X509Certificate(pem).fingerprint256;
}
