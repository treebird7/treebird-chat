# Changelog

## Unreleased

### Added

- **`corrwait --catchup`** (`bin/corrwait.mjs`) — non-blocking one-shot read mode. Emits a `CATCHUP` JSON payload with all new content since the agent's cursor, advances the cursor, and exits immediately (exit 0) — even when there is no new content. Designed for agents that wake on an external signal (e.g. a hive event) and need to read session context without waiting for the next message. Respects `--on-mention` filtering. Mutually exclusive with `--write`. 6 tests added.

- **History on join** (`bin/treebird-chat.mjs`) — TUI now prints the last 30 protocol lines as a history block on startup (with a `── history ──` / `── live ──` separator) before entering tail mode. Previously the cursor was set to end-of-file, so late joiners saw no context.
- **`/open <topic>` sub-collab shortcut** (`bin/treebird-chat.mjs`) — `/open device-link` now falls back to `sub:device-link` when the plain lookup finds nothing, so you can reference subs by topic name without the prefix. When the resolved type is `sub`, the command prints the `treebird-chat <path> --as <agent>` join command instead of opening the file in a pager.
- **Wikilink resolver** (`lib/wikilink.mjs`) — parses `[[target]]` syntax and resolves to file path, type (`chat` | `doc` | `sub` | `task` | `mem`), and active status. Supports `sub:`, `task:`, `mem:` prefixes; plain `[[filename]]` searches sibling dir then workspace roots. Active detection via `.bridge-cursor.json` sidecar or parent `.subs.json` entry.
- **TUI wikilink highlighting** — `[[wikilinks]]` rendered in cyan in all received messages.
- **`/sub <topic>` command** (`bin/treebird-chat.mjs`) — creates a sub-collab file (sibling to the current file, `_sub_<topic>_<HH:MM>` suffix), inherits parent ACL, registers in `.subs.json`, posts a `[[wikilink]]` pointer into the parent. If the sub already exists, prints the join command instead.
- **`/subs` command** — lists all sub-collabs for the current session with active/closed status.
- **`/preview <target>` command** — inlines the first 20 lines of any linked file.
- **Sub lifecycle** (`lib/subs.mjs`, `bin/treebird-chat.mjs`, `bin/treebird-chat-join.mjs`) — `/close [summary]` in a sub TUI posts a summary back to the parent chat and marks the sub closed in `.subs.json`. Auto-summary reads the last 3 protocol lines if no text is provided. `--parent <file>` flag on both binaries wires the close path.

### Fixed

- **`/open` on sub-collabs opened in pager** — sub files are meant to be joined in a new TUI session, not read in `less`. `/open` now detects `type === 'sub'` and prints the `treebird-chat` join command.
- **Malformed protocol lines invisible in TUI** — lines missing a `[HH:MM agent]` prefix are silently dropped by `printLine`. Added timestamp fixup for lines written as `[ agent]` (space-only where time should be).

### Added

- **`treebird-chat-join`** (`bin/treebird-chat-join.mjs`) — single-command remote session join. Collapses the old 6-step paste block (touch, env, bridge, allow, corrwait, reply) into `treebird-chat-join <chatId> [--as agent] [--tui]`. Reads `SMALLTOAK_TOKEN` from `~/.treebird-chat/.env` (never argv or shell history), resolves the smalltoak URL, spawns the bridge as a managed child, then runs a corrwait loop (agents) or opens the TUI (`--tui`, humans). Solves R-invite-2 — agents were misreading the multi-step paste block as in-session instructions.
- **Single-instance bridge lock** (`treebird-chat-join`) — a stale-PID-aware lockfile per `(chatId, mirror)` refuses to start a second bridge on the same file. Prevents the two-bridges-one-file echo storm where each bridge re-pushes the other's writes.
- **`resolvePublicUrl()` / `localIPv4s()`** (`lib/config.mjs`) — detect a loopback host in a cross-machine invite and rewrite it to the host's reachable IP (Thunderbolt `192.168.100.x` preferred, link-local `169.254.x.x` excluded), listing other routes as alternates.

### Fixed

- **`localhost` in cross-machine invites** — invites embedded the session's smalltoak URL verbatim; when the server ran on `localhost`, remote invitees connected to their own machine and their messages silently never reached the chat. Invites now rewrite the host to a reachable IP via `resolvePublicUrl()`.
- **Token in invite blocks** — the invite output put a live `SMALLTOAK_TOKEN` into shell history / clipboard / chat logs. Token now lives only in `~/.treebird-chat/.env` (0600); the invite shows a one-time setup block using `printf` + `envoak vault get` command-substitution so the secret never appears literally. Fixed in both the TUI `/invite` and the standalone `treebird-chat-invite` CLI.
- **chatId path traversal in `treebird-chat-join`** — `chatId` flowed unvalidated into `/tmp/${chatId}.md`. Now guarded with `/^[a-zA-Z0-9_-]+$/`.
- **`treebird-chat-join` spun against a dead bridge** — bridge exit only logged; the corrwait loop kept re-arming forever. Bridge exit now triggers `cleanup()`.
- **TUI word wrap** (`bin/treebird-chat.mjs`) — `wordWrap` now breaks on em-dash (heavily used in agent messages) as well as spaces, and hard-cuts cleanly when no break point exists in the width window.
- **Watcher cursor skipped continuation lines** (`lib/watcher.mjs`) — the cursor mis-handled multi-line flat messages.
- **Smalltoak bridge echo storm** (`lib/bridge.mjs`, `lib/markdown-archive.mjs`) — the bridge's self-echo guard used a `Set` for appended-line content, which collapses duplicate content: once one identical self-line was consumed, a second went unrecognized whenever the line-number guard also missed, and the bridge re-posted its own echo in a loop. Replaced with a counting multiset (`createSelfContentLedger()`) — one credit per self-append, retired on match. `markdown-archive#appendLine` now scans from the end of the file so a stale earlier duplicate is never mistaken for the just-appended line.

### Changed

- **`gemma-bridge` default model** — `google/gemma-4-26b-a4b` (an LM Studio HF id that triggered a 48 GB download on first run) replaced with `mlx-community/gemma-4-26b-a4b-it-4bit`, the MLX id served by `mlx_lm.server`.

## 0.2.2 — 2026-05-15

### Added

- **`/invite <agent>` inline invite block** (`bin/treebird-chat.mjs`) — `/invite` in the TUI now prints a ready-to-copy invite block immediately after adding the agent to the ACL. Prints cross-machine smalltoak instructions if the session was started with a chatId/smalltoakUrl, or local `corrwait` instructions otherwise.
- **`~/.treebird-chat/.env` support** (`lib/config.mjs`) — `loadEnv()` now checks `~/.treebird-chat/.env` as a canonical user-level config location (after `./.env`, before the process environment). Lets non-envoak users set `SMALLTOAK_TOKEN`, `SMALLTOAK_SERVER_URL`, etc. once and forget it.
- **Wizard skips smalltoak prompts when env vars are set** (`bin/treebird-chat-wizard.mjs`) — if `SMALLTOAK_SERVER_URL` is already in env, the wizard auto-selects the smalltoak transport and skips prompting for URL and token; only asks for chat-id. Avoids re-entering config that's already in `.env`.

### Fixed

- **Wizard always prompted for smalltoak URL/token** — even with `SMALLTOAK_SERVER_URL` set in env, the wizard asked for it again. Now uses env values silently.

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
