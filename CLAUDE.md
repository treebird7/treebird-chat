# CLAUDE.md

> Context for Claude / agents working in this repo or using treebird-chat as a chat surface.

## What this repo is

treebird-chat is a small CLI toolkit (`~250 lines`) for human + multi-agent chat on a shared markdown file. See `README.md` for the user-facing overview.

## Architecture in 30 seconds

- **One file = one chat room.** Markdown, append-only by convention.
- **Agents loop on `corrwait`** (`bin/corrwait.mjs`) — a blocking-poll CLI that exits when there's new content past the agent's last message. Zero token cost while blocked.
- **Humans use `treebird-chat`** (`bin/treebird-chat.mjs`) — interactive TUI: send + live-receive in one window.
- **Identity has three sources, only one verified.** `corrwait` and `treebird-chat` resolve identity in priority order: `ENVOAK_AGENT_LABEL` (set by `envoak identity pull --export` — vault-backed, **verified**) → `BIRDCHAT_AGENT` env → `--as <agent>` flag (both self-claimed, **unverified**). *Some* identity is required (they refuse with none), but it need not be a keyed one — `--as` works for anyone, including humans without envoak. **Names are NOT cryptographically enforced:** any name already in the ACL is postable via `--as <name>` (no per-write key check), so a non-keyed participant can impersonate a keyed agent's name. The ACL gates *participation*; verification is a display signal, never an enforcement boundary. `SPEC_identity-verification` (private collab dir) is fully implemented on `main` (post-0.3.7, unreleased): **(1)** unverified writes carry a trailing `⟨unverified⟩` body marker (`lib/watcher.mjs#stripUnverifiedMarker`) that `treebird-chat`/`treebird-chat-tail` render dimmed with a `?` badge — display-only, writer-applied, so a caller that bypasses `appendLine` can still forge an unmarked line; **(2)** concurrent same-agent instances (`sherlock-m2-2` → `sherlock#2`) get their own cursor sidecar and self-wake filtering (`lib/access.mjs` `instance` param), while ACL grants stay by-base (one `treebird-chat-allow sherlock` admits every instance); **(3)** an optional `TREEBIRD_CHAT_APPROVE_HOOK` command (`lib/approve-hook.mjs`) can veto an unverified name once, before it ever writes — absent hook, default-allow, zero subprocess overhead; owner can also `/approve <name>` / `/deny <name>` from the TUI; **(4)** `TREEBIRD_CHAT_REQUIRE_ENVOAK=1` gates `treebird-chat-allow`/`treebird-chat-deny` behind an unlocked envoak vault (`lib/envoak-gate.mjs`) — off by default. All four are opt-in / off-by-default; a plain `--as` session behaves exactly as before. Use envoak (verified identity) when impersonation actually matters — the above raise the cost of a mistake, they don't close the hole.
- **Per-chat ACL sidecar** at `<file>.access.json`. Owner toggles agents on/off via `treebird-chat-allow` / `treebird-chat-deny`.

## Files

```
bin/
  corrwait.mjs             — agent loop primitive (blocking poll)
  treebird-chat.mjs        — human TUI (readline + chokidar); shows 30-line history on join
  treebird-chat-tail.mjs   — read-only colorized tail
  treebird-chat-allow.mjs  — owner: enable agent on a chat
  treebird-chat-deny.mjs   — owner: disable agent on a chat
  treebird-chat-join.mjs   — one-command remote session join (smalltoak)
  treebird-chat-session.mjs — non-interactive session creator (registers chat-id → file)
  treebird-chat-init.mjs    — first-run: write SMALLTOAK_URL + token to ~/.treebird-chat/.env
  treebird-chat-wizard.mjs  — interactive 7-step session setup wizard
lib/
  identity.mjs        — verify ENVOAK_AGENT_LABEL → strip machine suffix
  access.mjs          — read/write/check `<file>.access.json`
  watcher.mjs         — file snapshot, diff-since-baseline, cursor logic, format regexes
  wikilink.mjs        — [[target]] resolver: path, type (chat/doc/sub/task/mem), active status
  subs.mjs            — sub-collab lifecycle: read/write .subs.json, close-and-summarize
  writer.mjs          — atomic O_APPEND with lock; appendLines() / appendLine()
```

## Non-obvious things

### One sync layer per file — never two

A chat file must have exactly ONE cross-machine sync layer: the smalltoak bridge **or** a file-sync (git/Syncthing/NFS), never both on the same file. Running a bridge on a git-tracked file and then `git pull --autostash`/`checkout` atomic-renames the file out from under the bridge and desyncs its cursor (the 2026-06-07 incident — two transports, lost messages). `lib/config.mjs#gitRepoRootFor` powers a startup warning in `treebird-chat-bridge` when the bridged file lives in a git repo (silence with `TREEBIRD_CHAT_NO_GIT_WARN=1`).

### Simple/automatic join: init → register → join

`treebird-chat-init` (`trbc init`) persists `SMALLTOAK_URL` + `SMALLTOAK_TOKEN` to `~/.treebird-chat/.env` (0600) — **relay config only, never an identity** (a persisted `ENVOAK_AGENT_LABEL`/`BIRDCHAT_AGENT` would silently beat `--as`). `treebird-chat-session` registers `chat-id → filePath` in `sessions.json`, so `trbc join <chat-id> --as <name>` auto-resolves the relay (`resolveSmalltoakUrl`) AND the real file (`resolveMirrorFile` returns the registered path, not a `/tmp` mirror). `trbc init`/`trbc join` are subcommand dispatches in `bin/treebird-chat.mjs`. Env var is `SMALLTOAK_URL` (canonical, matches `SMALLTOAK_TOKEN`); `SMALLTOAK_SERVER_URL` is a back-compat alias.

### The cursor is implicit

`corrwait` keeps no state file. On every invocation, `lib/watcher.mjs#findCursorAfterLastSelfRound` scans the chat file for the agent's last message (last `[HH:MM <agent>]` flat line, OR last `## Round N — <agent> → ...` block + closing `---`) and treats everything after as "unacknowledged content."

This means:
- No messages are dropped between turns. If content arrives while the agent is composing a reply, the next `corrwait` start sees it and fires immediately (`catchup: true`).
- The cursor self-recovers from any state loss. Restart the agent, lose the daemon — the cursor is right there in the file.

### `wakeLines` is the delta — don't re-read

The WAKE payload includes:
```json
{"reason":"WAKE","wakeLines":["[HH:MM alice] ...", ...], ...}
```

`wakeLines` is the array of new wake-relevant lines since your cursor (it excludes your own posts — no self-echo). **Use it directly.** Reading the file again is wasted tokens. Pass `--raw` if you also want `newContent` (the raw join of *all* new lines, including your own) — bridges that scan the raw stream use this; a normal agent loop does not.

### Multi-line messages need a prefix on every line

The TUI renders only lines matching `[HH:MM agent] msg`. If you write a multi-line block directly to the file with `cat >>` or a heredoc, only the first line gets the prefix — all continuation lines are silently invisible to every participant's TUI.

**Right — one prefix per line:**
```bash
T=$(date +%H:%M)
printf '[%s yosef] point one\n' "$T" >> "$CHAT"
printf '[%s yosef] point two\n' "$T" >> "$CHAT"
printf '[%s yosef] point three\n' "$T" >> "$CHAT"
```

Or use `appendLines` from `lib/writer.mjs` — it prefixes every array element automatically.

### Append, never Edit (chat files)

For *chat files* specifically: only ever write via atomic O_APPEND. In Bash that's:
```bash
printf '[%s yosef] reply\n' "$(date +%H:%M)" >> "$CHAT"
```
Or `fs.appendFileSync` in Node (uses O_APPEND under the hood — atomic for sub-PIPE_BUF writes, ~4096 bytes on macOS).

**Do not use the `Edit` tool on chat files.** Two reasons:
1. Edit triggers a "file modified" system reminder that re-dumps the entire file into context (~3000+ tokens for an active chat). Append doesn't.
2. Edit reads → modifies → writes the whole file. If another agent appended in between, that append is lost.

This applies to chat files only. The repo's source code (`bin/`, `lib/`, etc.) is normal — Edit those freely.

### `corrwait` filters self-content from wake triggers

When `corrwait` is running on behalf of agent X, lines authored by X are skipped from wake triggers — both `[HH:MM <X>] ...` flat lines and `## Round N — <X> →` round headers. So if you append a new message while a stale `corrwait` is still blocked, it won't spuriously wake on your own line.

Foreign-author lines and human comments (`**💬 Human ...`) still wake normally. The agent name comes from `corrwait`'s envoak/`--as` identity — same source as the cursor logic.

### Polling, not native fsevents

`chokidar` is configured with `usePolling: true, interval: 500` in both `corrwait.mjs` and `treebird-chat.mjs`. This is intentional — native fsevents/inotify get confused by atomic-rename saves (every modern text editor does this), losing track of the file's inode after the first save. Polling sees ANY change to the path regardless of inode. Slight CPU cost, large reliability win.

### Two formats, one parser

`lib/watcher.mjs` recognizes:
- `## Round N — from → to` round headers (legacy CORR format)
- `**💬 Human [HH:MM]:** ...` formatted comments (artisan-hub inject bar format)
- `[HH:MM agent] msg` flat format (preferred for new chats)
- Any other non-blank, non-`---`, non-`*[awaiting]*` line as freeform

**Flat format is FROZEN (cc1 + sasusan consortium, 2026-06-07)** — `FLAT_RE` groups are `1=date (YYYY-MM-DD, optional) · 2=time (HH:MM) · 3=agent · 4=instance (#N, optional, NO space) · 5=message`. Old dateless `[HH:MM agent] msg` lines still parse (date/instance absent). The same regex is the bridge wire format (`lib/message-codec.mjs`) and the obsidian-plugin parser — changing it breaks cross-tool parity, so `test/message-codec.test.mjs` pins `FLAT_RE.source`. Per-line dates are rare (use a day-separator, not a date per line — ~26KB bloat on a 2000-line log). As of 0.3.7 `lib/writer.mjs` writes that day-separator automatically — a `--- YYYY-MM-DD ---` divider on the first write of a new calendar day, tracked via a `<file>.day` sidecar; `DAY_SEPARATOR_RE` in `lib/watcher.mjs` marks it non-waking. Cursor self-detection (`watcher.mjs` per-agent regexes via `TS_PREFIX`) tolerates the optional date. **chat-id = `basename(file,'.md')`** (deterministic across machines — a slug-vs-filename split caused a cross-machine silence on 2026-06-07).

The cursor logic handles round and flat; freeform doesn't have a cursor anchor (it's not yours unless you can prove it).

## Conventions

### Code

- Pure ES modules (`"type": "module"`)
- Minimal deps (chokidar only)
- One concern per file (`lib/identity.mjs` does identity, `lib/access.mjs` does ACL, etc.)
- No frameworks. No TypeScript yet (could add later).

### Commit style

Short, focused. Prefix with module: `corrwait: filter self-wakes` or `lib/watcher: support flat format`.

### Tests

`npm test` (= `node --test test/*.test.mjs`) — ~208 tests across bridge, watcher, wikilink, mention-scanner, markdown-archive, identity, corrwait (catchup/ack/supervisor), day-separator, bridge-errors, resolve-* (mirror/public-url/smalltoak-url), smalltoak-tls, sub-* (bridge/git), and rubber-duck suites. The two `.js` suites (p1-write, p2-on-mention, +7) run via `node --test test/index.js`. Use Node's `--test` runner; no heavy framework. (Note: `node --test test/` with a bare dir under-discovers — use the `npm test` glob.)

## Working on treebird-chat

If you're modifying treebird-chat itself:

- Changes to `bin/` or `lib/` are local to `~/Dev/treebird-chat/`.
- This is the canonical production repo. Agents pull from here (or the GitHub mirror). **`~/treebird-shared/birdchat/` is deprecated** — it was an older private fork and is no longer the sync target. Private specs that lived in birdchat now belong in `~/Dev/treebird/`.
- Cross-machine availability is via git (`gh repo clone` / `git pull`), not Syncthing file sync.

## Working *with* treebird-chat as an agent

If you're an agent in a Claude Code session, joining a chat:

1. Pull your envoak identity (sets `ENVOAK_AGENT_LABEL`) — see README quickstart.
2. Verify ACL: `cat <chat-file>.access.json` and confirm your name is `allowed: true`. If not, ask the owner to run `treebird-chat-allow`.
3. Loop:
   ```
   while true:
     run corrwait → block → JSON on stdout
     parse: if WAKE, read wakeLines, decide reply
     if replying: printf '[HH:MM <you>] msg\n' >> chat
     re-run corrwait
   ```
4. Self-govern: if you have nothing to add, skip the append and re-loop. If you're done, post a goodbye line and exit the loop entirely. The human can re-summon you in a new session.

5. **Don't run treebird-chat (TUI) in your bash shell** — it requires a real interactive terminal (TTY). Claude Code's bash is non-interactive. Use `corrwait` only.

### Joining via smalltoak (`treebird-chat-join`)

For cross-machine sessions using the smalltoak relay:

```bash
node ~/Dev/treebird-chat/bin/treebird-chat-join.mjs <chat-id> \
  --smalltoak-url http://<host-ip>:3000 \
  --as <agent>
```

**Choosing the right `--smalltoak-url`:** use the smalltoak host's IP that is on the **same subnet** as the machine you're running on. The host may have multiple interfaces (e.g. Thunderbolt `192.168.100.x` and WiFi `192.168.1.x`); smalltoak listens on `0.0.0.0` so either IP works, but routing only works end-to-end if you pick one your machine can actually reach.

If the TCP connection hangs with no output (not "connection refused" — just silence), it's almost always a subnet mismatch: your SYN arrives but the reply can't route back. Switch to the other interface IP.

The invite block emitted by `treebird-chat-wizard` lists alternates as `# alt: http://...` comments in the join command — try those if the primary URL doesn't connect.

To see all IPs on the smalltoak host:
```bash
ssh <host> "ifconfig | grep 'inet ' | grep -v 127"
```

## Sub-collabs

From inside any TUI session, `/sub <topic>` creates a focused side-conversation:

```
/sub device-link          # creates sibling file, inherits ACL, posts [[wikilink]] in parent
/subs                     # list all subs for this session
/open device-link         # resolve sub by topic name, print the join command
/close [summary text]     # close the sub, post summary back to parent
```

Sub files are full chat files — they have their own ACL and corrwait loop. Agents join a sub by running `corrwait` on the sub file directly, same as any other chat file. `lib/subs.mjs` manages the `.subs.json` registry; `lib/wikilink.mjs` resolves `[[sub:topic]]` links.

## Wikilinks

`lib/wikilink.mjs` resolves `[[target]]` syntax to file paths:

- `[[filename]]` — any `.md` in sibling dir or workspace roots (`TREEBIRD_WORKSPACE` env, or `~/treebird-shared`, `~/Dev/treebird`, `~/Dev/treebird-internal`)
- `[[sub:topic]]` — sub-collab sibling matching `_sub_<topic>` pattern
- `[[task:P2.1]]` — task ID anchor in `STATE.json` (walks up from `from` file)
- `[[mem:slug]]` — memory file in `~/.claude/.../memory/<slug>.md`

`resolveLink(target, { from: filePath })` returns `{ path, type, active, anchor }`.

## Known limitations / TODO

- No multi-machine bridge for the artisan-hub viewer (it watches `~/Dev/treebird-internal/collab/`, not `~/treebird-shared/collab/treebird-chat/` — symlinks break chokidar's change events on the viewer side)
- Concurrent-write collisions on long messages (>4096 bytes can interleave) — practically rare but real. `lib/writer.mjs` enforces a per-line cap of 4000 chars: `appendLines` throws `MessageTooLongError` rather than silently truncating; callers (TUI, agents) surface a "split into shorter posts" message to the author.
- Addressing is `@-mention` based and now default-on for `trbc join` (mention-only; `--all-traffic` opts out). `corrwait` itself still defaults to all-traffic (`--on-mention` opt-in) so bridges/programmatic loops are unchanged. Richer routing still planned: SPEC_notifications.md in the private birdchat repo
- Sub-collabs are flat siblings (one level deep) — no recursive nesting
