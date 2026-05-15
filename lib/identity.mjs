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

export function verifyAgentIdentity(fallback = null) {
  const label = process.env.ENVOAK_AGENT_LABEL || process.env.BIRDCHAT_AGENT || fallback;
  if (!label) {
    throw new Error(
      'No identity. Set ENVOAK_AGENT_LABEL (via `envoak identity pull --export`), ' +
      'set BIRDCHAT_AGENT env var, or pass --as <agent>.'
    );
  }
  // Envoak labels look like `<agent>-<machine>` (e.g. yosef-m5). Strip the
  // machine suffix when present. Plain labels (BIRDCHAT_AGENT/--as) usually
  // don't have one and pass through unchanged.
  const agent = label.includes('-') ? label.replace(/-[^-]+$/, '') : label;
  const machine = process.env.TREEBIRD_MACHINE || (label !== agent ? label.slice(agent.length + 1) : null);
  const source = process.env.ENVOAK_AGENT_LABEL ? 'envoak'
    : process.env.BIRDCHAT_AGENT ? 'env'
    : 'cli';
  assertAgentName(agent);
  return { agent, machine, label, source };
}
