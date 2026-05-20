// Shared composer for the treebird-chat invite block. Used by:
//   - bin/treebird-chat-invite.mjs  (standalone CLI)
//   - bin/treebird-chat.mjs         (the /invite TUI command)
//
// Pulled into a library so the two callers can't drift apart on the
// security-critical bits (cert embed, fingerprint print, --cert-file step).

import { existsSync, readFileSync } from 'node:fs';
import { fingerprintFromPem } from './smalltoak-pin.mjs';

// Resolve the cert PEM from env. Returns null when the server isn't running
// TLS (i.e. no SMALLTOAK_CERT[_FILE] in the inviter's env). The host machine
// that started smalltoak with TLS has this in env automatically.
export function readInviterCert(env = process.env) {
  const path = env.SMALLTOAK_CERT_FILE || env.SMALLTOAK_CERT || null;
  if (!path || !existsSync(path)) return null;
  try {
    const pem = readFileSync(path, 'utf8');
    if (!pem.includes('-----BEGIN CERTIFICATE-----')) return null;
    return { path, pem, fingerprint: fingerprintFromPem(pem) };
  } catch {
    return null;
  }
}

// Compose the cross-machine invite block. When `cert` is non-null, the block
// embeds a heredoc that pins the cert at ~/.treebird-chat/smalltoak.crt and
// adds the --cert-file step to the join command. The fingerprint is printed
// so the invitee can verify the carried cert against an out-of-band channel
// (text the host the SHA-256, compare).
export function composeRemoteInvite({ chatId, joinUrl, invitee, alternates = [], cert = null }) {
  const W = '═'.repeat(56);
  const altNote = alternates.length ? `\n    # alt: ${alternates.join('  ')}` : '';
  const tlsTag = cert ? '  [cross-machine + TLS]' : '  [cross-machine]';

  if (!cert) {
    return `
${W}
 treebird-chat invite — ${invitee}${tlsTag}
${W}

 One-time token setup (skip if already done):

    mkdir -p ~/.treebird-chat && chmod 700 ~/.treebird-chat
    printf 'SMALLTOAK_TOKEN=%s\\n' \\
      "$(envoak vault get treebird-chat SMALLTOAK_TOKEN)" \\
      >> ~/.treebird-chat/.env
    chmod 600 ~/.treebird-chat/.env

 Join:

    node ~/Dev/treebird-chat/bin/treebird-chat-join.mjs \\
      ${chatId} \\
      --smalltoak-url ${joinUrl} \\
      --as ${invitee}${altNote}

 Add --tui for the interactive chat interface.

${W}
`;
  }

  // PEM gets embedded in a quoted heredoc (<<'EOF'), so $ and \\ pass through
  // unchanged. The cert is not secret — it's the server's public key cert —
  // but is still saved 0600 to match surrounding ~/.treebird-chat conventions.
  return `
${W}
 treebird-chat invite — ${invitee}${tlsTag}
${W}

 Server: ${joinUrl}
 Cert SHA-256: ${cert.fingerprint}
   ${'(verify out-of-band with the host before pasting below)'}

 One-time setup (skip if already done):

    mkdir -p ~/.treebird-chat && chmod 700 ~/.treebird-chat

    # token
    printf 'SMALLTOAK_TOKEN=%s\\n' \\
      "$(envoak vault get treebird-chat SMALLTOAK_TOKEN)" \\
      >> ~/.treebird-chat/.env
    chmod 600 ~/.treebird-chat/.env

    # pinned cert (server identity — verify fingerprint above)
    cat > ~/.treebird-chat/smalltoak.crt <<'CERT_EOF'
${cert.pem.trimEnd()}
CERT_EOF
    chmod 600 ~/.treebird-chat/smalltoak.crt

 Verify the cert you just pasted matches the fingerprint above:

    openssl x509 -in ~/.treebird-chat/smalltoak.crt -fingerprint -sha256 -noout

 Join (bridge auto-finds the pinned cert):

    node ~/Dev/treebird-chat/bin/treebird-chat-join.mjs \\
      ${chatId} \\
      --smalltoak-url ${joinUrl} \\
      --as ${invitee}${altNote}

 Add --tui for the interactive chat interface.

${W}
`;
}

export function composeLocalInvite({ invitee, filePath }) {
  const W = '═'.repeat(56);
  return `
${W}
 treebird-chat invite — ${invitee}
${W}

 You've been invited to a treebird-chat session.
 File: ${filePath}

 Wait for messages (runs until woken):

   corrwait ${filePath} --as ${invitee} --timeout 540

 When it wakes (prints JSON with reason: WAKE), reply:

   printf '[%s ${invitee}] your reply\\n' "$(date +%H:%M)" >> ${filePath}

 Then run corrwait again to keep listening.
 Exit anytime — re-running corrwait picks up where you left off.

${W}
`;
}
