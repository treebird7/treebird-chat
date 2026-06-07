// Shared CLI help: a single command index so a newcomer can discover the
// toolkit without reading source. Surfaced by `treebird-chat help` / `--help`.
//
// Friction this fixes: ~15 binaries on PATH with no map, and `--help` on some
// binaries silently doing real work instead of explaining itself.

export const COMMAND_INDEX = `treebird-chat — human + multi-agent chat on a shared markdown file

USAGE
  treebird-chat <file> [--as <agent>]      open the interactive TUI on a chat file
  treebird-chat help | --help              show this command index

TYPICAL FLOW  (create → invite → join)
  1. create   treebird-chat-session --name <topic> --owner <you> --invite <agent> ...
  2. join     treebird-chat <file>                     (human, interactive TUI)
              corrwait <file> --as <agent>             (agent loop primitive)
  3. remote   treebird-chat-bridge <id> <file> --smalltoak-url http://<host-ip>:3000   (host)
              treebird-chat-join <id> --smalltoak-url http://<host-ip>:3000 --as <agent>  (other machine)

COMMANDS
  treebird-chat            interactive human TUI (send + live-receive)
  treebird-chat-session    create a session file, set owner + ACL, print join commands
  treebird-chat-wizard     interactive 7-step session setup (incl. cross-machine invite block)
  treebird-chat-tail       read-only colorized live tail of a chat file
  corrwait                 agent loop primitive — block until new content, or --write / --catchup
  treebird-chat-allow      owner: enable an agent on a chat (writes the ACL sidecar)
  treebird-chat-deny       owner: disable an agent on a chat
  treebird-chat-invite     print an invite block for an agent
  treebird-chat-join       one-command remote join via the smalltoak relay
  treebird-chat-bridge     host: register a chat file with smalltoak under a chat-id
  treebird-chat-add-bridge attach an AI bridge (gemma | memosan | generic-http) to a chat

IDENTITY
  Verified  = ENVOAK_AGENT_LABEL from \`envoak identity pull --export\` (vault-backed).
  Unverified= BIRDCHAT_AGENT env or --as <name> (self-claimed; works for everyone,
              incl. humans without envoak, but displays as unverified).
  Precedence: ENVOAK_AGENT_LABEL > BIRDCHAT_AGENT > --as. A stale env label silently
  wins over --as — run with a clean env to use --as.

Run any command with --help for its own usage. Docs: README.md / CLAUDE.md.
`;

export function printCommandIndex(stream = process.stdout) {
  stream.write(COMMAND_INDEX);
}

// True when argv requests help (no consuming side effects). Lets each binary
// short-circuit BEFORE doing real work — so `<cmd> --help` never mutates state.
export function wantsHelp(argv) {
  return argv.some((a) => a === '--help' || a === '-h' || a === 'help');
}
