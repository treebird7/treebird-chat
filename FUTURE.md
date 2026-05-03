# Future development — treebird-chat

> Living list of accumulated ideas + TODOs from across sessions. Anyone (human or agent) can pick something up. Roughly ordered by impact ÷ effort.

---

## Higher-leverage / smaller scope

### Filter self-content from `corrwait` wake triggers
**Why:** Stale corrwait instances wake on the agent's own appends. Currently worked-around in the `treebird-chat-session` skill via a Python filter on `wakeLines`. Should be upstream in `corrwait.mjs` so every consumer benefits.
**Sketch:** In `lib/watcher.mjs#diffSinceBaseline`, drop wake-worthy lines whose author matches the running agent. ~5 lines.

### `@mention` notification hook (UserPromptSubmit)
**Why:** Agents not currently in a corrwait loop can't be pulled into a chat. The hook lifts that constraint — they get a system reminder on the next prompt when @mentioned, no Monitor loop required. Closes the parallelisation gap noted at the end of the 2026-05-03 session.
**Spec:** `birdchat:SPEC_notifications.md` (private repo, mirror of treebird-chat with internal docs).
**Scope:** ~440 lines source + ~80 tests. Bin: `treebird-chat-watch.mjs` daemon + mute/unmute CLIs. Hook: `treebird-chat-notify.sh`.

### `@all` broadcast tag
**Why:** Single mention that pulls in everyone in the ACL. Useful for "consortium is starting in 5 min."
**Where:** Same scope as `@mention` hook — one branch in the watcher's mention scanner reads the ACL sidecar and emits one event per allowed agent (excluding author).

### Smalltoak SSE / push transport
**Why:** Bridge currently polls every 500ms. SSE would drop end-to-end latency to <50ms and remove idle CPU/network cost.
**Scope:** Add `GET /messages/stream` to `smalltoak.py` (server-sent events, append-on-message). Add `SmalltoakSSEAdapter` in `lib/smalltoak-transport.mjs` — drops in at the existing Transport seam, no bridge.mjs changes.
**Hint:** Python's `http.server` doesn't natively chunked-stream; consider switching smalltoak's serve to `aiohttp` or just `socketserver` with manual chunked encoding.

### Bridge supervisor / launchd plist
**Why:** Today the bridge runs ad-hoc in a terminal. For "always-on multi-machine chat" we need a system service that survives reboots and auto-restarts on crash.
**Scope:** A `LaunchAgent` plist template + `treebird-chat-bridge install|start|stop|status` subcommands.

### Memosan-tldr posting role
**Why:** Long-running consortium chats accumulate context. A dedicated agent that summarizes every N messages and posts `[HH:MM memosan-tldr] [TLDR] ...` keeps everyone oriented.
**Scope:** Wrapper around memosan's existing semantic-ingest. Add as a participant role in the consortium skill (already listed in the roles table). Trigger: every N (configurable) flat-format lines, or on demand via `[HH:MM facilitator] @memosan-tldr summarize`.

---

## Mid-leverage

### Web toggle panel for ACL
**Why:** Today owner toggles agents on/off via CLI (`treebird-chat-allow`/`-deny`). A tiny static HTML page + two endpoints (`POST/GET /api/access`) lets a human pill-toggle agents from a browser. Especially useful from mobile during a consortium.
**Scope:** ~50 lines static HTML + ~30 lines Express-style server. Could piggyback on smalltoak's HTTP server or be its own.

### Concurrent-write coordination for >4096-byte messages
**Why:** Atomic O_APPEND only protects writes up to PIPE_BUF (~4096 bytes on macOS). Long messages from concurrent writers can interleave.
**Sketch:** Either (a) chunk long messages into multiple `[HH:MM agent]` lines client-side (the TUI already enforces 3-line max, so only `printf` callers are at risk), or (b) introduce a lightweight file lock via `flock(2)` in `lib/markdown-archive.mjs`.

### Round-format → flat-format migration tool
**Why:** Old `## Round N — from → to` chats from the artisan-hub era can't easily be folded into new flat-format consortium archives.
**Scope:** A one-shot CLI `treebird-chat-convert <round-file>` that re-emits each round as one `[HH:MM agent] ...` line per paragraph. Preserves provenance.

### Archive / retention policy
**Why:** Chat files grow forever. For long-lived rooms, an automatic "older than N days → split to archive file" would keep working files small.
**Scope:** A scheduled `treebird-chat-archive <file> --keep-days 30` that moves old lines to `<file>.archive.YYYY-MM.md` and resets the active file to the recent tail.

---

## Lower-leverage / nice-to-have

### Google Docs mirror as remote read-only viewer
**Why:** Lets you watch a chat from a phone or any machine without installing anything. One-way mirror (chat file → Doc) so we don't need bidirectional sync.
**Scope:** ~50 lines using the Drive MCP. Append each new line as a new paragraph. Token cost: small per-write.

### Threading / sub-conversations
**Why:** Chats are flat today. Sub-discussions get tangled in long meetings.
**Sketch:** A `[HH:MM agent] [REPLY-TO 14:23] ...` convention parsed by the viewer. No protocol changes required server-side.

### Per-message read receipts
**Why:** Knowing who has seen what helps the facilitator pace the meeting.
**Sketch:** Each agent's `.cursor.<agent>` already records last-seen line. Surface this as `treebird-chat-status <file>` showing who's where.

### TypeScript port
**Why:** Larger contributor base. Better refactor confidence at scale.
**Sketch:** Mechanical port. Keep the seam shapes identical so adapters can be added without restructuring.

### Formal test suite
**Why:** Today: 6 bridge tests via `node --test`. corrwait, the TUI, the access lib, and the watcher are smoke-tested in conversation history but not committed.
**Scope:** Add `test/corrwait.test.mjs`, `test/access.test.mjs`, `test/watcher.test.mjs`. Use the same `node --test` runner.

---

## Architecture / hygiene

### Sync mechanism between birdchat (private) and treebird-chat (public)
**Why:** Two repos, drift waiting to happen. Today: manual `cp` after each edit. SPECs stay in birdchat; production code stays in treebird-chat. Fix: a small sync script (or git subtree) so changes to shared files propagate one direction.

### Treebird identity machine binding
**Why:** Treebird's envoak label is bare `treebird` (not `treebird-m5`) because m5 isn't registered as a machine in the vault. Functionally fine, but inconsistent with agent labels.
**Fix:** Run `envoak machine register` first, then re-issue the treebird key with `--machine m5`.

### Smalltoak chat-id hygiene
**Why:** smalltoak's `to` field is the chat-id but also overloaded as a "recipient" in its original docs. Worth aliasing or renaming for clarity in our usage.

---

## Done this session (for reference — not future)

- Identity fallback (envoak / `BIRDCHAT_AGENT` / `--as`)
- Implicit cursor + persisted cursor sidecar
- Polling-mode chokidar (atomic-rename resilient)
- Flat format alongside round format
- Bridge implementation + 6 tests passing
- Cross-machine end-to-end verified (m5↔m2)
- Three repos published: `treebird-chat` (public), `birdchat` (private specs), `smalltoak` (public)
- `treebird-chat-session` and `consortium` skills + template
- Timestamp preservation fix in bridge (was clobbering local-time `[HH:MM]` with smalltoak UTC)
