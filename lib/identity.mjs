// Resolve the running agent's identity. Three sources, in priority order:
//   1. ENVOAK_AGENT_LABEL — set by `envoak identity pull --export`. Vault-backed.
//   2. BIRDCHAT_AGENT — plain env var. Standalone use, no vault.
//   3. `--as <agent>` CLI flag, passed in via `fallback` arg.
//
// Without envoak the identity is unverified — anyone can claim any name.
// The ACL still gates participation, so a wrong claim just gets rejected.
// Use envoak when you need spoofing prevention.

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
  return { agent, machine, label, source };
}
