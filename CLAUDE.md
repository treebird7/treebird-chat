# CLAUDE.md

> Context for Claude / agents working in this repo or using treebird-chat as a chat surface.

## What this repo is

treebird-chat is a small CLI toolkit (`~250 lines`) for human + multi-agent chat on a shared markdown file. See `README.md` for the user-facing overview.

## Architecture in 30 seconds

- **One file = one chat room.** Markdown, append-only by convention.
- **Agents loop on `corrwait`** (`bin/corrwait.mjs`) — a blocking-poll CLI that exits when there's new content past the agent's last message. Zero token cost while blocked.
- **Humans use `treebird-chat`** (`bin/treebird-chat.mjs`) — interactive TUI: send + live-receive in one window.
- **Identity is envoak-gated.** `corrwait` and `treebird-chat` both read `ENVOAK_AGENT_LABEL` from env (set by `envoak identity pull --export`) and refuse to start without it. Agent name is *taken from envoak*, not args — no spoofing.
- **Per-chat ACL sidecar** at `<file>.access.json`. Owner toggles agents on/off via `treebird-chat-allow` / `treebird-chat-deny`.

## Files

```
bin/
  corrwait.mjs        — agent loop primitive (blocking poll)
  treebird-chat.mjs        — human TUI (readline + chokidar)
  treebird-chat-tail.mjs   — read-only colorized tail
  treebird-chat-allow.mjs  — owner: enable agent on a chat
  treebird-chat-deny.mjs   — owner: disable agent on a chat
lib/
  identity.mjs        — verify ENVOAK_AGENT_LABEL → strip machine suffix
  access.mjs          — read/write/check `<file>.access.json`
  watcher.mjs         — file snapshot, diff-since-baseline, cursor logic, format regexes
```

## Non-obvious things

### The cursor is implicit

`corrwait` keeps no state file. On every invocation, `lib/watcher.mjs#findCursorAfterLastSelfRound` scans the chat file for the agent's last message (last `[HH:MM <agent>]` flat line, OR last `## Round N — <agent> → ...` block + closing `---`) and treats everything after as "unacknowledged content."

This means:
- No messages are dropped between turns. If content arrives while the agent is composing a reply, the next `corrwait` start sees it and fires immediately (`catchup: true`).
- The cursor self-recovers from any state loss. Restart the agent, lose the daemon — the cursor is right there in the file.

### `newContent` is the full delta — don't re-read

The WAKE payload includes:
```json
{"reason":"WAKE","newContent":"<every line since cursor>", "wakeLines":[...], ...}
```

`newContent` is a string with the complete new section (headers + bodies). **Use it directly.** Reading the file again is wasted tokens — it just gives you all the history you've already seen.

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

### `corrwait` self-wakes are a known wart

If you append a message and an *already-running* `corrwait` is waiting, it'll wake on your own append (cursor was at your previous message, your new one is "past cursor"). Currently corrwait doesn't filter self-content from wake triggers. Workaround: stop the running corrwait before appending, then start a new one. Or just ignore self-wakes (the JSON's `wakeLines` will only contain `[HH:MM yourname]` lines you wrote).

This is fixable — filter `wakeLines` against the agent's own author name before computing `woke`. Marked as TODO.

### Polling, not native fsevents

`chokidar` is configured with `usePolling: true, interval: 500` in both `corrwait.mjs` and `treebird-chat.mjs`. This is intentional — native fsevents/inotify get confused by atomic-rename saves (every modern text editor does this), losing track of the file's inode after the first save. Polling sees ANY change to the path regardless of inode. Slight CPU cost, large reliability win.

### Two formats, one parser

`lib/watcher.mjs` recognizes:
- `## Round N — from → to` round headers (legacy CORR format)
- `**💬 Human [HH:MM]:** ...` formatted comments (artisan-hub inject bar format)
- `[HH:MM agent] msg` flat format (preferred for new chats)
- Any other non-blank, non-`---`, non-`*[awaiting]*` line as freeform

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

Currently smoke-tested via inline bash scripts in conversation history. No formal test suite yet — TODO. When adding one, prefer Node's `--test` runner over a heavy framework.

## Working on treebird-chat

If you're modifying treebird-chat itself:

- Changes to `bin/` or `lib/` are local to `~/Dev/treebird-chat/`.
- The same code is mirrored to `~/treebird-shared/treebird-chat/` for cross-machine availability via Syncthing. **After editing source files, copy to shared:**
  ```bash
  cp -u ~/Dev/treebird-chat/bin/* ~/treebird-shared/treebird-chat/bin/
  cp -u ~/Dev/treebird-chat/lib/* ~/treebird-shared/treebird-chat/lib/
  cp -u ~/Dev/treebird-chat/package.json ~/treebird-shared/treebird-chat/
  ```
- Or set up a watch script. Not done yet.

## Working *with* treebird-chat as an agent

If you're an agent in a Claude Code session, joining a chat:

1. Pull your envoak identity (sets `ENVOAK_AGENT_LABEL`) — see README quickstart.
2. Verify ACL: `cat <chat-file>.access.json` and confirm your name is `allowed: true`. If not, ask the owner to run `treebird-chat-allow`.
3. Loop:
   ```
   while true:
     run corrwait → block → JSON on stdout
     parse: if WAKE, read newContent, decide reply
     if replying: printf '[HH:MM <you>] msg\n' >> chat
     re-run corrwait
   ```
4. Self-govern: if you have nothing to add, skip the append and re-loop. If you're done, post a goodbye line and exit the loop entirely. The human can re-summon you in a new session.

5. **Don't run treebird-chat (TUI) in your bash shell** — it requires a real interactive terminal (TTY). Claude Code's bash is non-interactive. Use `corrwait` only.

## Known limitations / TODO

- `corrwait` wakes on agent's own appends if a stale corrwait is running (filter self-content)
- No git repo / LICENSE / formal test suite
- No multi-machine bridge for the artisan-hub viewer (it watches `~/Dev/treebird-internal/collab/`, not `~/treebird-shared/collab/treebird-chat/` — symlinks break chokidar's change events on the viewer side)
- Concurrent-write collisions on long messages (>4096 bytes can interleave) — practically rare but real
- No mentions / addressing — every message wakes every listening agent
- No threading
