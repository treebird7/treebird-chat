# Changelog

## Unreleased

### Security

- **Path traversal via `--as` flag** (`treebird-chat-add-bridge`) — agent name passed to `resolve()` without validation allowed directory traversal. Fixed with `AGENT_RE = /^[a-z0-9_-]+$/i` allowlist enforced before any path use.
- **Newline injection in writer** (`lib/writer.mjs`) — agent name embedded in flat-format chat line `[HH:MM agent] msg`; a `\r\n` in the name split the line header. Sanitized at write time with `.replace(/[\r\n]/g, '')`.
- **Newline injection in `--write` message** (`bin/corrwait.mjs`) — `\r\n` in the message payload split the header line in structured output. Stripped at write time.
- **Missing `child.on('error')` on spawned children** (`bin/gemma-bridge.mjs`, `bin/treebird-chat-add-bridge.mjs`) — unhandled ENOENT on `spawn()` emits a synchronous EventEmitter error, not a promise rejection, so `async try/catch` cannot catch it. Added `child.on('error')` handlers on both spawned processes.
- **Bridge inherits agent-process secrets** (`treebird-chat-add-bridge`) — detached bridge child inherited full `process.env` including `ENVOAK_*` and `SUPABASE_*` credentials. Applied denylist filter (`/^ENVOAK_|^SUPABASE_/`) before spawning bridge process.
- **Lockfile and pidPath created world-readable** — `writer.mjs` lockfile created without explicit mode; `treebird-chat-add-bridge` pidPath written without mode. Fixed: lockfile `0o600`, pidPath `0o644`.

### Added

- **`treebird-chat-wizard`** — interactive 7-step session setup: name, location, transport (local / +smalltoak bridge), agent invite (numbered list of known agents + free-form), local LLM config (probes LM Studio for loaded models), discussion template (consortium / code_review / adversarial / brainstorm / blank), confirm + create. Writes the chosen template into the file, sets ACL, starts bridges, prints the join command.

- **`treebird-chat-session`** — non-interactive one-liner session creator. Creates `CONSORTIUM_<name>_<date>.md`, sets ACL for `--invite`d agents, auto-starts `gemma-bridge` if `gemma` is invited, prints `export CHAT=` + join hint. `--join` flag opens TUI immediately.

- **`gemma-bridge`** — local LLM bridge for treebird-chat. Watches a chat file for `@gemma` mentions using `corrwait`, calls any OpenAI-compatible local server (LM Studio, ollama, llama.cpp, mlx_lm), posts replies in flat format. 30-line context window, 20-min watchdog timeout (pure bash — no coreutils `timeout` required), stale-PID-aware single-instance lock. Configurable via `--lm-studio`, `--model`, `LM_STUDIO_URL`, `GEMMA_MODEL`.

- **`TREEBIRD_COLLAB_DIR` env var** — session and wizard default to `$TREEBIRD_COLLAB_DIR` instead of a hardcoded path. Falls back to `~/collab`.

- **Discussion templates** — four built-in templates in the wizard:
  - `consortium` — agenda, decisions log, action items table
  - `code_review` — risk checklist (security / breaking changes / large diffs / auth)
  - `adversarial` — proposer vs critic with arbiter rounds
  - `brainstorm` — open ideation with `[IDEA]` / `[CONCERN]` tagging

## 0.1.2 — 2026-05-07

### Fixed

- **`gemma-bridge` supervisor loop** — replaced bare `main().catch()` with a `supervisor()` loop that restarts `main()` on crash after a 5s backoff, preventing silent process death from dropping mentions on the floor. Also logs unknown corrwait reason codes to aid debugging.

- **`treebird-chat` TUI pump chain** — `onChange` handler errors now log to stderr and schedule a 250ms retry instead of permanently rejecting the pump promise, which previously caused all subsequent messages to silently fail to display.

## 0.1.1 — 2026-05-07

### Fixed

- **`gemma-bridge` crash storm** — unhandled `ERROR` result from `corrwait` caused an instant tight loop spawning hundreds of crashing node processes (114 in ~1 min observed on m5 at 3am). Added 10s backoff before retry when `corrwait` exits with error, preventing runaway crash reporting and CPU melt.

## 0.1.0 — 2026-05-03

### Added

- `@mention` notification hook (`lib/mention-scanner.mjs`, `lib/watchlist.mjs`, `bin/treebird-chat-watch.mjs`, `hooks/treebird-chat-notify.sh`). Agents registered via `treebird-chat-watch add <file>` get a `systemMessage` injection on their next Claude Code turn when `@mentioned`.
- Self-content filter in `corrwait` — agent's own flat-format lines no longer trigger a wake.
- Persisted cursor sidecar (`<file>.cursor.<agent>`) — advances even when agent stays quiet, preventing replay of already-seen content.
- `treebird-chat-bridge` — smalltoak bridge for real-time cross-machine access without Syncthing.
- Flat format as the primary chat format alongside the legacy round format.
- Cross-machine end-to-end verified (m5 ↔ m2 via Syncthing).
- `treebird-chat-session` and `consortium` skills + templates.
- Timestamp preservation fix in bridge (was clobbering local-time `[HH:MM]` with smalltoak UTC).
- 23 tests for mention scanner, watchlist, and notification hook.
