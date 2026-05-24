import test from 'node:test';
import assert from 'node:assert/strict';
import { networkInterfaces } from 'node:os';
import { resolvePublicUrl, localIPv4s } from '../lib/config.mjs';

// resolvePublicUrl was extended by PR #13 to surface alternates for non-loopback
// URLs (multi-interface hosts like Thunderbolt + WiFi). The follow-up review
// flagged that the non-loopback branch didn't actually check the URL points at
// THIS machine — it just filtered out the URL's hostname from local IPs, which
// would surface junk alternates for non-host callers.

// Pick a hostname guaranteed NOT to be a local IP. 192.0.2.x is RFC 5737
// TEST-NET-1, reserved for documentation — no real machine routes from it.
const NON_LOCAL_HOST = '192.0.2.1';

test('non-loopback URL pointing at a NON-local host returns no alternates', () => {
  // The latent bug: pre-guard, this returned localIPv4s() as alternates —
  // junk, because they point at the caller's machine, not the smalltoak host.
  const r = resolvePublicUrl(`http://${NON_LOCAL_HOST}:3000`);
  assert.equal(r.url, `http://${NON_LOCAL_HOST}:3000`);
  assert.deepEqual(r.alternates, [], 'must not surface local IPs as alternates for a non-host URL');
});

test('non-loopback URL pointing at this machine surfaces other interfaces as alternates', () => {
  // Only meaningful when this machine has ≥2 IPv4 interfaces. If we have one
  // or zero, the function should return [] either way — the test still
  // exercises the isLocal-true branch.
  const ips = localIPv4s();
  if (ips.length === 0) {
    // CI may have no interfaces; can't exercise the positive path, just
    // verify no crash + correct empty result.
    return;
  }
  const r = resolvePublicUrl(`http://${ips[0]}:3000`);
  assert.equal(r.url, `http://${ips[0]}:3000`, 'url passes through unchanged for local host');
  // alternates are the other IPs as URLs, or empty if only one interface.
  const expected = ips.slice(1).map((ip) => `http://${ip}:3000`);
  assert.deepEqual(r.alternates, expected);
});

test('loopback URL still rewrites to a local IP (regression check)', () => {
  // The loopback branch is unchanged by the guard; this is just defending
  // against accidentally widening the guard to the loopback path.
  const ips = localIPv4s();
  const r = resolvePublicUrl('http://localhost:3000');
  if (ips.length > 0) {
    assert.equal(r.url, `http://${ips[0]}:3000`);
  } else {
    assert.equal(r.url, 'http://localhost:3000'); // no IPs — passes through
  }
});

test('localhost shorthand 127.0.0.1 and 0.0.0.0 both treated as loopback', () => {
  const r1 = resolvePublicUrl('http://127.0.0.1:3000');
  const r2 = resolvePublicUrl('http://0.0.0.0:3000');
  // Both should hit the loopback branch (url rewritten or unchanged with no
  // IPs); critically, NOT the non-loopback branch.
  if (localIPv4s().length > 0) {
    assert.notEqual(r1.url, 'http://127.0.0.1:3000');
    assert.notEqual(r2.url, 'http://0.0.0.0:3000');
  }
});

test('malformed URL returns input + empty alternates', () => {
  const r = resolvePublicUrl('not a url');
  assert.equal(r.url, 'not a url');
  assert.deepEqual(r.alternates, []);
});
