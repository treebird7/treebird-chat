# Changelog

## 0.2.2 — 2026-05-15

### Added

- **`/invite <agent>` inline invite block** (`bin/treebird-chat.mjs`) — `/invite` in the TUI now prints a ready-to-copy invite block immediately after adding the agent to the ACL. Prints cross-machine smalltoak instructions if the session was started with a chatId/smalltoakUrl, or local `corrwait` instructions otherwise.
- **`~/.treebird-chat/.env` support** (`lib/config.mjs`) — `loadEnv()` now checks `~/.treebird-chat/.env` as a canonical user-level config location (after `./.env`, before the process environment). Lets non-envoak users set `SMALLTOAK_TOKEN`, `SMALLTOAK_SERVER_URL`, etc. once and forget it.
- **Wizard skips smalltoak prompts when env vars are set** (`bin/treebird-chat-wizard.mjs`) — if `SMALLTOAK_SERVER_URL` is already in env, the wizard auto-selects the smalltoak transport and skips prompting for URL and token; only asks for chat-id. Avoids re-entering config that's already in `.env`.

### Fixed

- **Wizard always prompted for smalltoak URL/token** — even with `SMALLTOAK_SERVER_URL` set in env, the wizard asked for it again. Now uses env values silently.

## Unreleased

### Fixed

- **Smalltoak bridge echo storm** (`lib/bridge.mjs`, `lib/markdown-archive.mjs`) — the bridge's self-echo guard could fail to recognize a line it had just appended, treating its own echo as a fresh local message and re-posting it in a loop (observed: one chat line re-appended 100+ times). Root cause: `selfInsertedContent` was a `Set`, which collapses duplicate line content — once one identical self-line was consumed, a second went unrecognized whenever the line-number guard also missed. Exact line-number attribution is impossible when non-locking writers (a raw `printf >>`) share the file, so the content guard is now a counting multiset (one credit per self-append, retired on match). `markdown-archive#appendLine` additionally scans for its appended line from the end of the file, so a duplicate earlier copy is never mistaken for the new line.

### Security

- **Full `process.env` passthrough to network-facing bridges** (`treebird-chat-wizard`, `treebird-chat-session`, `treebird-chat-add-bridge`, `bridge-agent-base`, `treebird-chat-toak-bridge`) — bridge subprocesses inherited every credential in the parent env (vault keys, TOAK/OpenAI/Anthropic tokens). Added `spawnEnv()` allowlist helper in `lib/config.mjs` (base keys `PATH`/`HOME`/`LANG`/`LC_ALL`/`TERM`/`TMPDIR` + explicit per-bridge extras); replaced every `{ ...process.env }` spread and implicit inherit at a bridge spawn site. The earlier `add-bridge` denylist (`/^ENVOAK_|^SUPABASE_/`) is superseded by this allowlist.
- **Session registry written world-readable** (`lib/config.mjs`) — `~/.treebird-chat/sessions.json` holds `smalltoakToken` but was written with default `0o644`. Now written `0o600` (dir `0o700`), with a `chmodSync` to re-assert the mode on pre-existing files.
- **Inconsistent agent-name validation** — only `add-bridge` validated agent names; `treebird-chat-allow`/`-deny`/`-invite`, `corrwait --as`, and the TUI `/invite` accepted arbitrary strings. Added shared `AGENT_NAME_RE` + `assertAgentName`/`isValidAgentName` to `lib/identity.mjs` (anchored: starts with a letter, `[A-Za-z0-9_-]`, max 64); enforced in `verifyAgentIdentity` and at every agent-name entry point.
- **Path traversal via agent name in cursor file** (`lib/access.mjs`) — `cursorPath` interpolated the agent name into a write path unchecked; `assertAgentName` now guards it.
- **Path traversal via session name in filename** (`treebird-chat-wizard`, `treebird-chat-session`) — user-supplied session name flowed into `CONSORTIUM_<name>_<date>.md` unsanitized. Sanitized with a `safeFileSegment` helper before filename use.
- **Missing `child.on('error')` on detached spawns** (`treebird-chat-wizard`, `treebird-chat-session`) — `ENOENT`/`EACCES` on a detached bridge spawn crashed the parent. Added `error` handlers to every detached spawn.
- **Unhandled rejection in TUI input handler** (`bin/treebird-chat.mjs`) — the async `rl.on('line')` handler had no `try/catch`; an `appendLines` lock timeout surfaced as an unhandled rejection. Wrapped the handler body.
- **Silent ACL-grant failures in wizard** — `treebird-chat-wizard`'s `allow()` discarded the `spawnSync` result; failed grants are now surfaced via `warn()`.

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
