// Resolve the running agent's identity. Three sources, in priority order:
//   1. ENVOAK_AGENT_LABEL — set by `envoak identity pull --export`. Vault-backed.
//   2. BIRDCHAT_AGENT — plain env var. Standalone use, no vault.
//   3. `--as <agent>` CLI flag, passed in via `fallback` arg.
//
// Without envoak the identity is unverified — anyone can claim any name.
// The ACL still gates participation, so a wrong claim just gets rejected.
// Use envoak when you need spoofing prevention.

// Canonical agent-name shape: starts with a letter, then letters/digits/-/_,
// max 64 chars. Anchored — no path separators, whitespace, or newlines can
// pass, so a name is always safe as a filesystem path component and ACL key.
export const AGENT_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export function isValidAgentName(name) {
  return typeof name === 'string' && AGENT_NAME_RE.test(name);
}

export function assertAgentName(name) {
  if (!isValidAgentName(name)) {
    throw new Error(
      `Invalid agent name "${name}": must start with a letter and contain only ` +
      'letters, digits, hyphens, or underscores (max 64 chars).'
    );
  }
  return name;
}

// Parse an identity label into its parts. The canonical shape is
// `<agent>[-<machine>[-<instance>]]`, e.g.:
//   sasusan-m5      → { agent: 'sasusan',   machine: 'm5', instance: null }
//   sherlock-m2-2   → { agent: 'sherlock',  machine: 'm2', instance: 2 }   (2nd sherlock on m2)
//   ibn-yosef-m5    → { agent: 'ibn-yosef', machine: 'm5', instance: null } (hyphenated agent name)
//   cc2             → { agent: 'cc2',       machine: null, instance: null } (plain label, digit-suffixed name)
//
// Rules: a trailing pure-digit segment is the instance (only when ≥3 segments,
// so a digit-suffixed agent name like `cc2` is never mistaken for an instance);
// the next trailing segment is the machine (only when ≥2 segments remain).
// Everything before is the agent base name, hyphens and all.
export function parseLabel(label) {
  const parts = String(label).split('-');
  let instance = null;
  let machine = null;
  if (parts.length >= 3 && /^\d+$/.test(parts[parts.length - 1])) {
    instance = parseInt(parts.pop(), 10);
  }
  if (parts.length >= 2) {
    machine = parts.pop();
  }
  return { agent: parts.join('-'), machine, instance };
}

export function verifyAgentIdentity(fallback = null) {
  // Precedence: explicit --as (fallback) > BIRDCHAT_AGENT (chat-handle override)
  // > ENVOAK_AGENT_LABEL (machine identity, the derived default). An explicitly
  // chosen chat handle MUST win over the agent's machine label — otherwise a
  // colony-assigned instance handle (e.g. `sherlock2`) gets overridden back to
  // the base agent (`sherlocksan`), which is what caused the 2026-06 handle
  // confusion among concurrent instances. With neither override set, this is
  // identical to the old behavior (falls through to ENVOAK_AGENT_LABEL).
  const label = fallback || process.env.BIRDCHAT_AGENT || process.env.ENVOAK_AGENT_LABEL;
  if (!label) {
    throw new Error(
      'No identity. Pass --as <agent>, set BIRDCHAT_AGENT, or set ENVOAK_AGENT_LABEL ' +
      '(via `envoak identity pull --export`).'
    );
  }
  const parsed = parseLabel(label);
  const agent = parsed.agent;
  const machine = process.env.TREEBIRD_MACHINE || parsed.machine;
  const source = fallback ? 'cli'
    : process.env.BIRDCHAT_AGENT ? 'env'
    : 'envoak';
  assertAgentName(agent);
  // `verified` means the name is vault-backed (came from envoak identity pull).
  // env/cli labels are self-claimed and unverified — display-only signal, never
  // enforced: --as keeps working for everyone (humans without envoak included).
  return { agent, machine, instance: parsed.instance, label, source, verified: source === 'envoak' };
}

// Non-throwing variant: returns the identity, or null when no identity is set.
// Use where an identity is optional (e.g. defaulting a session owner) instead
// of forcing a try/catch around verifyAgentIdentity.
export function resolveIdentity(fallback = null) {
  try {
    return verifyAgentIdentity(fallback);
  } catch {
    return null;
  }
}
