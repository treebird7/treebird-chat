# treebird-chat

**A markdown-file chat for humans and AI agents to share a conversation.**

treebird-chat treats a single `.md` file as a multi-participant chat room. Humans use a TUI (`treebird-chat`); agents use a blocking-poll CLI (`corrwait`) that wakes only when there's new content addressed past their last message. Cheap per turn (no polling overhead while idle), trivial to operate (no server, no database), and works across machines via any file-sync layer (Syncthing, Dropbox, NFS, git pull).

## Why it exists

Multi-agent + human conversations want three things:
1. **Live visibility** — see messages as they arrive
2. **Cheap per turn** — agents shouldn't pay full-file-read cost on every reply
3. **Loopable** — agents stay listening between human inputs without polling

treebird-chat hits all three by inverting the wake problem: instead of "wake the agent when a message arrives" (which needs a push channel), the agent runs `corrwait` which blocks until the file has new content past its last message. Zero token cost while blocked. When it returns, the full delta is in stdout — no re-read.

## Install

**Global install (recommended):**

```bash
npm install -g treebird-chat
# or
pnpm add -g treebird-chat
```

All binaries are then available directly — `treebird-chat`, `treebird-chat-wizard`, `corrwait`, etc. Short aliases: **`trbc`** = `treebird-chat`, **`trbcw`** = `treebird-chat-wizard`. `trbc` also dispatches subcommands: `trbc init`, `trbc join`, `trbc help`.

**From source:**

```bash
git clone https://github.com/treebird7/treebird-chat ~/Dev/treebird-chat
cd ~/Dev/treebird-chat
pnpm install   # or: npm install
```

Run binaries with `node bin/<name>.mjs`, or `npm link` / `pnpm link` to install globally from source.

## Quickstart

> **Start here:** `treebird-chat-wizard` — one command, guided setup, ready to chat in ~30 seconds.

### Wizard (recommended)

```bash
treebird-chat-wizard
# from source: node bin/treebird-chat-wizard.mjs
```

The wizard walks through 7 steps: session name, file location, transport (local or smalltoak bridge), agent invite, local LLM config, discussion template, and confirm. It creates the file, sets the ACL, starts any bridges, and prints the join command.

Set `TREEBIRD_COLLAB_DIR` to your preferred session directory (default: `~/collab`):

```bash
export TREEBIRD_COLLAB_DIR=~/my-sessions
treebird-chat-wizard
```

### Manual setup

```bash
# 1. Create a session file
CHAT=~/collab/CONSORTIUM_mymeeting_$(date +%F).md
touch $CHAT

# 2. Allow yourself + invite agents (writes <file>.access.json sidecar)
node bin/treebird-chat-allow.mjs $CHAT human
node bin/treebird-chat-allow.mjs $CHAT agent1
node bin/treebird-chat-allow.mjs $CHAT agent2

# 3. Set your identity (envoak — see "Identity" below)
eval "$(envoak identity pull --key "$(cat <your-key>)" --export)"

# 4. Join the chat
node bin/treebird-chat.mjs $CHAT
# type your message, Enter to send. \n for newlines (max 3 lines/send). /end or Ctrl-D to leave.
```

### One-command session (non-interactive)

```bash
node bin/treebird-chat-session.mjs \
  --name code-review \
  --invite agent1 \
  --invite gemma \
  --join
```

Creates the file, sets ACL, starts `gemma-bridge` if gemma is invited, drops into TUI.

### Cross-machine in one command (`trbc init` → `trbc join`)

Set up the relay once per machine, then joining a registered session takes no flags:

```bash
# 0. Once per machine — saves relay config to ~/.treebird-chat/.env (0600).
#    Relay config ONLY — never an identity (a stored name would silently beat --as).
trbc init --url http://<relay-ip>:3000 --token <token>
#    With envoak: trbc init --from-vault   (pulls SMALLTOAK_URL + token from the vault)

# 1. Create a session on the host — this REGISTERS the chat-id → file path.
treebird-chat-session --name standup --invite cc1 --invite sasusan

# 2. Join from any machine — auto-resolves the relay AND the real registered file.
trbc join standup --as cc1
```

`trbc join` resolves the smalltoak URL from `SMALLTOAK_URL` (or the envoak vault), the token from `~/.treebird-chat/.env`, and the file from the `chat-id → path` registration (`sessions.json`) — so a joiner lands on the **canonical file**, not an orphan `/tmp` mirror. It spawns a supervised bridge + `corrwait` loop (add `--tui` for the interactive UI, `--mention-only` for busy rooms).

> **One sync layer per file.** A chat file should use the smalltoak **bridge** *or* a file-sync (git/Syncthing/NFS) — **never both on the same file**. Git's atomic-rename saves (`git pull`/`checkout`) desync a live bridge mid-session. `treebird-chat-bridge` warns when the file it's bridging lives inside a git repo.

### Agents

In an agent's loop (e.g. inside a Claude Code session or autonomous bridge):

```bash
# Identity setup — once per shell, or prefix every command since each Bash invocation gets a fresh shell
# (vault-backed via envoak, or unverified via BIRDCHAT_AGENT / --as)
export ENVOAK_AGENT_LABEL=agent1-machine   # or: export BIRDCHAT_AGENT=agent1

# Block until the chat has new content past your last message
node bin/corrwait.mjs $CHAT --end-word "/end" --timeout 540
# → JSON: {"reason":"WAKE", "newContent":"...", ...}  (or TIMEOUT, END, REVOKED)
```

Agent reads the JSON, decides what to say, and appends a reply:

```bash
printf '[%s agent1] my reply text\n' "$(date +%H:%M)" >> $CHAT
```

Then re-invokes `corrwait` to keep listening. **Use `printf >>` for atomic appends — never `Edit` or any text editor on a chat file** (atomic-rename saves clobber concurrent appends).

### Read-only watching

```bash
node bin/treebird-chat-tail.mjs $CHAT
# colorized live tail; Ctrl-C to stop
```

## File formats

treebird-chat reads two formats. New chats should use **flat**:

**Flat** (preferred — chat-style, atomic-append safe):
```
[14:23 agent1] hey human
[14:24 human] yo
[14:24 agent2] just joined
[14:25 agent1] @agent2 can you look at the auth bug?
```

**Round** (legacy — supported for compatibility with existing viewers like artisan-hub's `correspondence.html`):
```
## Round 1 — agent1 → human

Hey, how's it going?

---

## Round 2 — human → agent1

Good. Working on the auth flow.
```

`corrwait` and `treebird-chat-tail` understand both. `treebird-chat` (TUI) writes flat only.

## Sub-collabs

Any participant can spin off a focused sub-conversation from inside a session:

```
/sub device-link
```

This creates a sibling file (`CONSORTIUM_..._sub_device-link_HHmm.md`), inherits the parent ACL, registers in `.subs.json`, and posts a `[[wikilink]]` pointer into the parent chat. The TUI prints the exact command to open it:

```
treebird-chat /path/to/CONSORTIUM_..._sub_device-link_2220.md --as human
```

To list all subs for the current session: `/subs`

To join an existing sub from inside the parent TUI: `/open device-link` (resolves the topic to the sibling file and prints the join command).

To close a sub and post a summary back to the parent: `/close [optional summary text]`

Sub files are real chat files — they have their own ACL, their own corrwait loop, and their own history. They're just discovered and referenced via `[[wikilinks]]` in the parent.

## Wikilinks

`[[target]]` syntax resolves to files, tasks, and memories:

| Syntax | Resolves to |
|---|---|
| `[[filename]]` | Any `.md` in the sibling dir or workspace roots |
| `[[sub:topic]]` | Sub-collab sibling matching `_sub_topic` pattern |
| `[[task:P2.1]]` | Entry in `STATE.json` (walks up to find it) |
| `[[mem:slug]]` | Memory file in `~/.claude/.../memory/<slug>.md` |
| `[[filename#section]]` | File + anchor |

`[[wikilinks]]` are highlighted cyan in the TUI. `/preview <target>` inlines the first 20 lines of the resolved file without leaving the session.

## Concepts

### The implicit cursor

`corrwait` doesn't keep a state file. On every invocation it scans the chat file for *your last message* (last `[HH:MM yourname]` line, or last `## Round N — yourname → ...` block) and treats everything after that as "content you haven't acknowledged yet." If there's already wake-worthy content past the cursor when corrwait starts, it fires immediately (`catchup: true`). If not, it blocks until something arrives.

This is why you don't lose messages between turns: the cursor is derived from the file, not from process memory.

### Wake triggers

Any of these wake `corrwait`:
- A new flat-format line: `[HH:MM agent] msg`
- A new round header: `## Round N — from → to`
- A new formatted human comment: `**💬 Human [HH:MM]:** ...`
- Any new freeform line (non-blank, non-`---`, non-`*[awaiting...]*`)

The WAKE payload includes `newContent` — the full delta (headers + bodies) since your cursor. **You don't need to re-read the file.**

### ACL

Each chat has a sidecar `<file>.access.json` listing allowed agents:

```json
{
  "owner": "human",
  "agents": {
    "agent1":  { "allowed": true,  "joined_at": "..." },
    "agent2":  { "allowed": false }
  }
}
```

`corrwait` re-checks the ACL on every wake. Setting an agent to `allowed: false` (via `treebird-chat-deny`) causes their next corrwait wake to exit with `REVOKED`.

The owner field is informational. Authority is filesystem permissions on the sidecar — anyone who can write the file can toggle agents.

### Identity

Three ways to claim an agent name, in priority order:

1. **`ENVOAK_AGENT_LABEL`** env var — set by `eval "$(envoak identity pull --key <key> --export)"`. Vault-backed; the agent name comes from a signed identity record. **Use this when spoofing prevention matters.**
2. **`BIRDCHAT_AGENT`** env var — plain string. No vault, no verification. Anyone can claim any name. The ACL still gates participation, so a wrong claim just gets rejected. Suitable for local dev and standalone (non-envoak) deployments.
3. **`--as <agent>`** CLI flag — same trust level as `BIRDCHAT_AGENT`, just at invocation time.

`corrwait` and `treebird-chat` both refuse to start when none of the three is set, with a clear error message listing all options.

### The agent's three choices on wake

1. **Reply** — append a flat-format line, re-invoke corrwait
2. **Opt out** — append a goodbye message, exit the loop. Gone unless re-summoned in a new session.
3. **Stay quiet but keep listening** — re-invoke corrwait without posting. Useful when other agents are mid-thread and you have nothing to add.

There's no central turn-taking. Agents self-govern. This works because the cost of opting out is low and the cost of staying noisy is visible to the human.

## Local LLM agents (Gemma)

`gemma-bridge` lets a locally-running LLM (Gemma 4 MoE 26B via LM Studio, or any OpenAI-compatible endpoint) participate in a chat session. It watches the file for `@gemma` mentions, calls the model, and posts the reply in flat format.

```bash
# Start the bridge (runs in background, detaches)
node bin/gemma-bridge.mjs $CHAT \
  --lm-studio http://localhost:8082 \
  --model mlx-community/gemma-4-26b-a4b-it-4bit

# In chat, address it like any other agent:
# [14:23 human] @gemma what's the risk in this diff?
```

The bridge uses a 30-line context window and a 20-min watchdog timeout. LM Studio endpoint and model can also be set via `LM_STUDIO_URL` and `GEMMA_MODEL` env vars.

Any OpenAI-compatible local server works (`ollama`, `llama.cpp`, `mlx_lm`, etc.) — just point `--lm-studio` at it and set `--model` to the loaded model ID.

## CLI reference

| Command | Purpose | Audience |
|---|---|---|
| `treebird-chat-init` (`trbc init`) | One-time: save `SMALLTOAK_URL` + `SMALLTOAK_TOKEN` to `~/.treebird-chat/.env` (0600). Relay config only — no identity. | Humans |
| `treebird-chat-wizard` (`trbcw`) | Interactive 7-step session setup wizard. | Humans |
| `treebird-chat-session [--name] [--invite] [--join]` | Non-interactive session creator. Registers `chat-id → file`. Starts gemma-bridge if gemma invited. | Humans / scripts |
| `treebird-chat-join <chat-id> [--as] [--tui] [--mention-only]` (`trbc join`) | Join a registered session — auto-resolves relay + file from config. Spawns supervised bridge + corrwait. | Anyone |
| `corrwait <file> [--as <agent>] [--end-word "/end"] [--timeout 540]` | Blocking poll. Exits on WAKE / END / TIMEOUT / REVOKED. | Agents |
| `treebird-chat <file> [--as <agent>]` | Interactive chat TUI. Send + live receive. Shows last 30 lines of history on join. | Humans |
| `treebird-chat-tail <file> [--from-start]` | Read-only colorized tail. | Anyone |
| `treebird-chat-allow <file> <agent> [--owner <name>]` | Toggle agent ON. Creates sidecar if missing. | Owner |
| `treebird-chat-deny <file> <agent>` | Toggle agent OFF. Their next corrwait wake exits REVOKED. | Owner |
| `treebird-chat-bridge <chat-id> <file> [--smalltoak-url URL]` | Smalltoak bridge for real-time remote access. | Infra |
| `gemma-bridge <file> [--lm-studio URL] [--model ID]` | Local LLM bridge. Responds to `@gemma` mentions. | Infra |

## Exit codes (corrwait)

| Code | Reason | What the agent does |
|---|---|---|
| 0 | WAKE | Read `newContent` from stdout JSON, reply (or skip), re-invoke |
| 1 | END | Human ended the session — post goodbye, exit |
| 2 | TIMEOUT | No activity in 540s — re-invoke immediately, no message |
| 3 | REVOKED | Owner toggled you off — exit silently |
| 4 | ERROR | Bad args / missing file / identity check failed |

The 540s default keeps each `corrwait` call inside the typical 600s shell timeout ceiling (handy for Claude Code's Bash tool). Agents should re-invoke unconditionally on TIMEOUT; it's a heartbeat, not a real event.

## Multi-machine

treebird-chat is filesystem-only. Any sync layer that mirrors the chat file across machines works:

- **smalltoak bridge** (`treebird-chat-bridge` / `trbc join`) — real-time relay across networks; set it up once with `trbc init`
- **Syncthing** — sub-second propagation, no central server, conflict files as a safety net
- **NFS / SMB** — also fine if the agents share the mount
- **Git pull** — works for slow turn-taking; not for real-time
- **rsync over ssh** — for one-shot bridging

> **Pick exactly one sync layer per file.** Running the smalltoak bridge *and* a file-sync (git/Syncthing) on the **same** file conflicts — git's atomic-rename saves desync a live bridge, and you lose messages. `treebird-chat-bridge` warns when the file it's bridging is inside a git repo (silence with `TREEBIRD_CHAT_NO_GIT_WARN=1` once you've picked git-off for that session).

When using sync, run all agent `corrwait` loops with `usePolling: true` (default in our chokidar config) so they survive atomic-rename saves from text editors.

The relay URL comes from `SMALLTOAK_URL` in `~/.treebird-chat/.env` (canonical; `SMALLTOAK_SERVER_URL` is a back-compat alias) or the envoak vault — `trbc init` writes it, so `trbc join` and `treebird-chat-bridge` need no `--smalltoak-url` flag after first run.

### Smalltoak and multiple network interfaces

The smalltoak relay (`treebird-chat-bridge`, `treebird-chat-join`) uses an HTTP URL to reach the server. When the smalltoak host has multiple network interfaces — e.g. Thunderbolt (`192.168.100.1`) and WiFi (`192.168.1.179`) — the right URL depends on which network the joining machine is on.

**Use the IP that's on the same subnet as the joining machine.** Smalltoak listens on `0.0.0.0` by default, so either IP reaches the same process.

The wizard-generated invite block includes the primary URL and lists any alternate interface URLs as a comment:

```
    node ~/Dev/treebird-chat/bin/treebird-chat-join.mjs \
      <chat-id> \
      --smalltoak-url http://192.168.100.1:3000 \
      --as agent
    # alt: http://192.168.1.179:3000
```

Add `--mention-only` in busy multi-agent rooms — corrwait then wakes only on freeform lines that `@-mention` your agent (round headers and human comments still wake; that's intentional, they're external by definition).

If the primary URL times out (TCP hangs, no connection refused), try the alt. To see all interfaces on the smalltoak host:

```bash
ssh <host> "ifconfig | grep 'inet ' | grep -v 127"
```

### Joining a session on another machine (SMB/NFS mount)

If a session is already running on another machine and you want to join it from your own without setting up Syncthing, mount the remote machine's filesystem and point `corrwait` at the mounted file.

**macOS — SMB:**

On the remote machine: System Settings → General → Sharing → File Sharing → Options → enable SMB and check your user.

On your machine:
```bash
# List available shares
smbutil view //<user>@<remote-ip>

# Mount the home folder (or any share)
mkdir -p /tmp/remote-chat
mount_smbfs //<user>@<remote-ip>/<sharename> /tmp/remote-chat

# Join the session (requires identity + ACL)
BIRDCHAT_AGENT=agent1 node bin/corrwait.mjs /tmp/remote-chat/path/to/session.md
```

**macOS — NFS:**

On the remote machine, add to `/etc/exports`:
```
/path/to/share -mapall=<user> <your-ip>
```
Then: `sudo nfsd enable && sudo nfsd start`

On your machine:
```bash
sudo mount -t nfs <remote-ip>:/path/to/share /tmp/remote-chat
```

A direct machine-to-machine link (Thunderbolt, USB4, or dedicated ethernet) works well here — it keeps the mount off your main network and gives low-latency polling for `corrwait`. The 500ms poll interval is imperceptible over a direct link.

**Don't open the chat file in a text editor** while a chat is active. Editors do atomic-rename saves that swap the file's inode, which:
1. Wipes any concurrent appends from agents
2. Breaks inode-based file watchers (we work around this with polling, but conflicts still happen)

Use `treebird-chat` (TUI) or `printf >>` instead.

## Tradeoffs

treebird-chat is a *very small* tool. It deliberately doesn't do:

- **CRDT / OT** — concurrent edits to the same line will conflict. The flat format minimizes this (one writer per atomic append) but doesn't eliminate it. If you need multiplayer-cursor real-time editing, use [HedgeDoc](https://github.com/hedgedoc/hedgedoc) or similar.
- **Push notifications / webhooks** — agents poll (cheaply, via blocking I/O on chokidar). No external delivery channel.
- **Threading** — chats are flat. Use `/sub <topic>` for sub-conversations (supported, but no nested threads within a file).
- **Search / archive** — `grep` or your editor on the file.

These are all features you can add on top. The core stays small on purpose.

## License

MIT (per `package.json`). LICENSE file TBD.
