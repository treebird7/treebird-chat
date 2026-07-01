import { execFileSync } from 'node:child_process';

const LOCK_SIGNATURES = [
  /Not logged in/i,
  /needs_reauth/i,
];

function envoakGateEnabled(value = process.env.TREEBIRD_CHAT_REQUIRE_ENVOAK) {
  return ['1', 'true'].includes(String(value || '').trim().toLowerCase());
}

function outputFromError(error) {
  return [
    error?.stdout,
    error?.stderr,
    error?.message,
  ]
    .filter(Boolean)
    .map((part) => Buffer.isBuffer(part) ? part.toString('utf8') : String(part))
    .join('\n');
}

function isLockedOutput(output) {
  return LOCK_SIGNATURES.some((signature) => signature.test(output || ''));
}

function lockedMessage(action) {
  return `${action} requires an unlocked envoak vault. Run: envoak vault unlock`;
}

export async function requireEnvoakUnlock({
  action = 'this action',
  runVaultStatus = () => execFileSync('envoak', ['vault', 'status'], { encoding: 'utf8' }),
} = {}) {
  if (!envoakGateEnabled()) {
    return { ok: true };
  }

  try {
    const output = await runVaultStatus();
    if (isLockedOutput(output)) {
      return { ok: false, message: lockedMessage(action) };
    }
    return { ok: true };
  } catch (error) {
    const output = outputFromError(error);
    const suffix = isLockedOutput(output) || !output ? '' : ` (${output.trim().split('\n')[0]})`;
    return { ok: false, message: `${lockedMessage(action)}${suffix}` };
  }
}
