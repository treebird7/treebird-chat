# Changelog

## Unreleased

## 0.3.7 — 2026-06-13

sasusan's token-cost fast-follows from the 0.3.5 consortium, all
forward-compatible with the frozen line format.

### Changed

- **Mention-only is the default for `trbc join`.** The interactive join path now
  wakes only on freeform lines that `@-mention` your agent; round headers and
  human comments still wake (external by definition). Pass **`--all-traffic`** to
  opt back into waking on every line. `--mention-only` is still accepted (now a
  no-op — it's the default). Scope is the interactive join path *only*: the
  `corrwait` binary and the mention-scanning bridges keep all-traffic, so
  programmatic loops are unchanged. (`bin/treebird-chat-join.mjs`)

### Added

- **`corrwait --ack <ref>`** — post a one-line "seen it" receipt
  (`[HH:MM agent] ✓ ack <ref>`) and mark everything up to now as read (advances
  the persisted cursor), then exit `0` with `{reason:"ACKED", ref}`. Cheaper than
  a full reply when the right response is just "on it", and unlike a bare
  `--write` it won't let the acked content re-surface on the next wake. Mutually
  exclusive with `--write`/`--catchup`; CR/LF-stripped ref. (`bin/corrwait.mjs`)
- **Day-separator writing.** `lib/writer.mjs` emits a `--- YYYY-MM-DD ---` divider
  the first time content lands on a new calendar day, so long logs are grouped by
  day without the ~26KB cost of a per-line date. Tracked via a `<file>.day`
  sidecar (same pattern as `.cursor.<agent>`); the first write to a file just
  initialises the stamp with no divider, and the decision is made under the
  writer lock so concurrent same-day writers can't double-emit. The watcher
  recognises the divider (`DAY_SEPARATOR_RE`) as non-waking — it never wakes the
  room. (`lib/writer.mjs`, `lib/watcher.mjs`)

## 0.3.6 — 2026-06-07

### Changed (behavior change for consumers that read `newContent`)

- **`corrwait` WAKE/CATCHUP payload is lean by default.** It now emits
  `wakeLines` (the new wake-relevant lines since the cursor, excluding the
  agent's own posts) and **omits `newContent` unless `--raw` is passed.**
  Previously every wake carried the delta twice — `wakeLines` plus `newContent`
  (a raw join of *all* new lines, including the agent's own just-posted ones) —
  roughly doubling the payload an agent re-ingests each poll and adding
  self-echo. That per-wake cost is the dominant token sink in a busy room.
  - The mention-scanning bridge (`lib/bridge-agent-base.mjs`, used by
    gemma/memosan/add-bridge) passes `--raw` internally, so bridges are
    unaffected. `treebird-chat-join` and the supervisor already read
    `wakeLines`.
  - Migration for external agent loops: read `wakeLines`; pass `--raw` if you
    specifically need the raw full delta. Docs (`CLAUDE.md`, `README.md`)
    updated accordingly.

### Fixed

- **`upsertUserEnv` strips CR/LF from values** (`lib/config.mjs`) — a newline in
  a `--url`/`--token` (or vault) value injected an extra line into
  `~/.treebird-chat/.env` on parse-back. Values are operator-supplied so it's
  not a remote exploit, but a pasted token with a trailing newline no longer
  silently corrupts the file. (Surfaced by `/ts-review` on the 0.3.5 `trbc init`.)

## 0.3.4 — 2026-05-30

### Changed (breaking for direct `appendLines` callers)

- **`lib/writer.mjs` no longer silently truncates lines over 4000 chars** (#23).
  Was: line collapsed to one row + `" […truncated]"` marker appended.
  Now: throws `MessageTooLongError` (named, with `lineIndex` / `length` / `limit`
  fields) and leaves the file untouched. Callers must handle the error and
  surface a clear "split into shorter posts" message to the author.
  - TUI (`bin/treebird-chat.mjs`) catches and shows: `✗ message too long — line N (after blank-line trim) is M chars (limit 4000). split into shorter posts and resend.`
  - Bridge inbound (`lib/bridge.mjs`) substitutes a visible `[time system] ⚠️ inbound message from <agent> at <time> exceeded line limit (M chars > 4000) — not appended` note when a peer ships an oversize line. Author field is capped (≤80) to keep the substitute itself under the limit.

  Migration for downstream `appendLines` users: wrap calls in try/catch and inspect for `err.code === 'MESSAGE_TOO_LONG'`. The `lib/writer.mjs` exports `MAX_LINE_LEN` and `MessageTooLongError` for callers that want to pre-check.

## 0.3.3 — 2026-05-30

### Added

- **`--mention-only` flag on `treebird-chat-join`** (#22) — opt-in wake filter.
  When set, forwards `--on-mention` to the supervised corrwait subprocess
  (including the catchup pass on restart). Corrwait then filters freeform
  lines to those that `@-mention` your agent (short or full label). Round
  headers and human comments still wake — they're external by definition.
  Massive signal-to-noise improvement in busy multi-agent rooms; default
  behavior unchanged.

  ```bash
  treebird-chat-join <chat-id> --as <agent> --mention-only
  ```

### Fixed

- **Supervisor catchup pass now forwards caller `extraArgs`** (#22). Previously
  `lib/corrwait-supervisor.mjs` hardcoded `extraArgs: ['--catchup']` for the
  drain pass, silently dropping any caller-supplied filter. A restarting
  `--mention-only` agent would have been woken by the entire backlog of
  unmentioned lines on every restart. Fix: merge `[...extraArgs, '--catchup']`.
  Caught by rubberduck pre-merge review; integration test added that stubs
  `corrwaitBin` and asserts argv forwarding on both runs.

### Notes

- `--mention-only` is a no-op when combined with `--tui` (TUI shows every
  message; filtering applies only to the corrwait wake loop). One-line stderr
  warning is emitted in that case.
- `@all` is recognised for priority detection (`@@/@@@`) but is not a wake
  target under `--on-mention`. See `lib/watcher.mjs` `diffSinceBaseline`.

## 0.3.1 — 2026-05-25

### Docs

- **README cleanup** — replaced personal/agent names (treebird, yosef, watsan, mappersan, etc.) with generic placeholders (`human`, `agent1`, `agent2`). Example session name `spidersan-review` → `code-review`. Hardcoded envoak key path replaced with a generic `ENVOAK_AGENT_LABEL` export hint. Preserved as project-meaningful: `treebird-chat`, `treebird7`, `TREEBIRD_COLLAB_DIR`, `gemma`/`gemma-bridge`.

No code changes — patch release to ship the cleaner README to npm.

## 0.3.0 — 2026-05-25

The "issue #6" release. Twelve PRs landed in a single arc to close out
*"Stupid-easy + stable remote chat bridge"* — single-command join,
auto-bridge, corrwait keepalive, single source of truth for URL — plus
a security/hardening sweep on the way through. Tests grew from 63 to
159 across the wave.

### Highlights

- **Issue #6 fully shipped** — P1 (URL via `.env` → envoak vault → null) ·
  P2 (`join` honours `sessions.json` filePath, no more `/tmp` orphans) ·
  P2.1 (`/sub` auto-stage + auto-bridge with deterministic chat-ids) ·
  P3 (unified corrwait supervisor + `treebird-chat-status` liveness CLI) ·
  P3.1 (heartbeat hook for envoak hive integration — optional) ·
  P4 (structured bridge errors with URL + actionable hint catalog).
- **Smalltoak TLS + cert pinning** — Option A from the pinning spec, fail-closed
  on `https://` without a pin, empirical token-not-leaked-on-mismatch test.
- **Wikilink path-traversal containment** — `[[..]]`, `[[mem:..]]`, sub topic
  sanitisation all guarded; 14-test regression coverage.
- **Atomic sidecar writes + stale-lock recovery** — ACL, cursor, sessions.json,
  bridge-cursor all crash-safe via tmp+rename. Lockfile crashed-process recovery.
- **Two hardening passes after the main wave** — rubber-duck review caught 6
  small fixes (path normalisation, owner default, perm tightening, etc.);
  `/ts-review` security pass caught 10 more, 5 landed (ACL/cursor mode 0o600,
  spawn-error handler, length caps on topic/chatId/lines).

### Added

- **`treebird-chat-status` CLI** — single-command bridge liveness check, lists
  registered chats + orphan bridges (lockfiles without `sessions.json` entry),
  reports state via lockfile + `kill(0)` probe. Exit code reflects health.
- **`treebird-chat-join`** added to `package.json` bin (was previously usable
  only via direct node invocation).
- **`/sub <topic>` auto-stages** the new sub file + its `.access.json` in git
  (when the canopy is in a git repo). No commit, no push — the TUI must not
  mutate git history.
- **`/sub <topic>` auto-spawns** a smalltoak bridge for the sub. Deterministic
  chat-id `<parent>-sub-<safe-topic>` so peer machines can derive the same id
  from the wikilink alone. Sub bridge is detached + unref'd — outlives the
  parent TUI.
- **`lib/corrwait-supervisor.mjs`** — shared supervisor for the corrwait loop.
  Panic threshold (default 10 restarts in 60s), heartbeat callback hook
  (caller-side optional), catchup pass on startup, structured exit reasons.
  Replaces the two parallel `while (true) { spawn corrwait }` loops that
  used to live in `bin/treebird-chat-join.mjs` and `lib/bridge-agent-base.mjs`.
- **`lib/bridge-errors.mjs`** — `formatBridgeError({ error, op, url, chatId })`
  + `hintFor(error)`. Hint catalog covers `ECONNREFUSED`/`ENOTFOUND`/
  `ETIMEDOUT`/`EHOSTUNREACH` network codes, TLS cert failures, HTTP
  401/403/404/5xx, non-array payload, and a `fetch failed` fallback. Drills
  through Node fetch's `cause` chain (up to 4 levels) to surface the deepest
  code.
- **`lib/sub-bridge.mjs`** — `spawnSubBridge` + `subChatId` helpers. Async
  with 250ms liveness verify after spawn — fast-fail bridges (bad URL/token/
  cert) surface clear reasons instead of leaving stale lockfiles.
- **`lib/sub-git.mjs`** — `autoStageSub` + `isInGitRepo`. Stage-only policy.
- **`lib/config.mjs#resolveSmalltoakUrl` + `saveSmalltoakUrl`** — env →
  envoak vault → null resolution; vault path opt-in via `ENVOAK_AGENT_LABEL`
  detection (vanilla users pay no subprocess cost).
- **`lib/config.mjs#resolveMirrorFile`** — `treebird-chat-join` honours the
  registered `filePath` from `sessions.json` instead of always falling to
  `/tmp/<chatId>.md`. `/tmp` remains the fallback for remote invites with
  no local registration, but with a clear `[join] WARN: …` line naming the
  chat-id and pointing at `treebird-chat-wizard`.
- **`/sub` UX hardening** — rejects path-like arguments (`/`, `~`, `.`,
  trailing `.md`, > 48 chars) with a hint toward `/open`. Closes a class of
  bugs where a tired human pasted a path and got a "junk sub" named after
  the slugified path.

### Changed

- **`findSessionByPath`** returns `{ chatId, ...session }` — was `session`-
  only, fixing a latent bug at `bin/treebird-chat.mjs:261` where
  `session?.chatId` was always undefined and the remote-invite branch was
  effectively dead. Paths are now also normalised via `resolve()` on both
  sides — handles relative paths, symlinks, and `/./` / `//` artifacts.
- **`treebird-chat-bridge` startup replay guard** — pre-loads existing
  file lines so a re-fetch from `sinceId=0` on an already-populated file
  doesn't re-append the same content.
- **`treebird-chat-join` corrwait loop** is now supervised — panic-protected,
  observable restarts, optional heartbeat. Replaces the inline `while (true)`
  loop at the prior call site.

### Security

- **Wikilink path-traversal containment** (`lib/wikilink.mjs`) — `isContained`
  guard on plain `[[../foo]]` and `[[mem:../../bar]]` paths. Sub topic
  sanitisation already in place; ACL/cursor writes now 0o600. 14 traversal
  tests in `test/wikilink.test.mjs` + `test/resolve-public-url.test.mjs` for
  the related `resolvePublicUrl` guard.
- **`resolvePublicUrl` local-host guard** — function now only surfaces
  alternates when the URL's hostname matches a local IP. Previously, calling
  it on a non-host URL returned the caller's own IPs as "alternates" — junk
  pointing at the wrong server.
- **ACL + cursor sidecars written 0o600** — `.access.json` (leaks membership)
  and `.cursor.<agent>` (timing oracle) now match `sessions.json`'s posture.
- **Length caps on user-derived strings** — `subTopic` 64 chars,
  `chatId` argv 128 chars, `appendLines` per-line 4000 chars with
  `[…truncated]` marker. Defends against resource-exhaustion via flood.
- **URGENT_WAKE cursor persistence** — `corrwait` now advances the cursor on
  `URGENT_WAKE` as well as `WAKE`. Previously, urgent mentions (`@@@agent`)
  replayed on every corrwait restart because the cursor was never advanced
  past them.
- **`lastSmalltoakId` cursor advances only after `appendLine` succeeds** —
  prevented permanent message drop if the append threw mid-flight.
- **Detached spawn `child.on('error')` handler** — async spawn failures
  (`ENOENT`/`EACCES`) no longer become unhandled exceptions that crash the
  parent TUI.

### Fixed

- **The 2026-05-20 "nightjar" wrong-URL incident**, root-cause-fixed at
  three layers: P1 closes the wizard's silent wrong-guess, P2 closes the
  `/tmp` orphan, P4 makes the resulting `ECONNREFUSED` self-diagnosable
  with a `hint=...` line.
- **The "hidden corrwait respawn"** mappersan reported — turned out not to
  be hidden, just unobservable. The two parallel supervisor implementations
  are now unified at `lib/corrwait-supervisor.mjs:supervise`, with logged
  restarts.
- **Multi-interface URL selection** — `resolvePublicUrl` surfaces alternates
  when a host has Thunderbolt + WiFi addresses, so invite blocks cover all
  reachable subnets.
- **Sub-bridge token argv exposure (correctness, not regression)** — the
  prior code's comment claimed `process.env` was used to avoid `ps(1)`
  exposure, but the token always went into the spawned child's env via
  `spawnEnv`, not argv. Comment rewritten to match reality; the security
  posture was always correct.

### Internal

- `ensureAcl` owner default is `$USER || $USERNAME || 'owner'` instead of
  hardcoded `'treebird'`.
- `mkdirSync` calls for `~/.treebird-chat/locks/` `chmod` 0o700 after the
  mkdir, since `mode:` only applies on creation (defends against a
  pre-existing dir with looser perms).
- `appendLines` now strips embedded `\n`/`\r` from each line and coerces
  non-strings via `String()` — defensive convergence with the agent-name
  pattern.
- `package.json` lockfile resynced; `treebird-chat-join` + `treebird-chat-status`
  added to `bin`.

### Earlier additions in this release (the week leading up to issue #6)

#### Security (earlier)

- **Smalltoak transport TLS + cert pinning** (`lib/smalltoak-transport.mjs`, `lib/smalltoak-pin.mjs`) — the bridge ↔ smalltoak transport now supports `https://` with the server cert pinned (Option A from `SPEC_smalltoak_tls_pinning.md`: carry the cert PEM, pass as TLS `ca` with hostname-check disabled — pin is the trust root). An `https://` URL with no pin is **rejected at construction** (fail-closed; no silent fallback to OS trust). Plain `http://` keeps working and emits a one-line stderr warning. New `--cert-file` flag on `treebird-chat-bridge` and `treebird-chat-join` (plus `SMALLTOAK_CERT_FILE` env). `treebird-chat-join` and `treebird-chat-wizard` persist the cert to `~/.treebird-chat/smalltoak.crt` (mode 0600) so subsequent re-joins find it automatically. The invite blocks (standalone CLI and `/invite` in the TUI) embed the cert PEM + its SHA-256 fingerprint when the host has `SMALLTOAK_CERT` set, so the invitee can verify out-of-band. Wizard threads the cert through Step 3 (Transport) — prompts only when env/persisted-default is empty, validates via `loadPin`, prints the SHA-256 fingerprint, records the path in the session registry for re-joins. 13 new tests in `test/smalltoak-transport-tls.test.mjs` cover all five spec success criteria — including the empirical "token-not-leaked-on-mismatch" check (server-side request count = 0 after a failed handshake).

#### Added

- **`corrwait --catchup`** (`bin/corrwait.mjs`) — non-blocking one-shot read mode. Emits a `CATCHUP` JSON payload with all new content since the agent's cursor, advances the cursor, and exits immediately (exit 0) — even when there is no new content. Designed for agents that wake on an external signal (e.g. a hive event) and need to read session context without waiting for the next message. Respects `--on-mention` filtering. Mutually exclusive with `--write`. 6 tests added.

- **History on join** (`bin/treebird-chat.mjs`) — TUI now prints the last 30 protocol lines as a history block on startup (with a `── history ──` / `── live ──` separator) before entering tail mode. Previously the cursor was set to end-of-file, so late joiners saw no context.
- **`/open <topic>` sub-collab shortcut** (`bin/treebird-chat.mjs`) — `/open device-link` now falls back to `sub:device-link` when the plain lookup finds nothing, so you can reference subs by topic name without the prefix. When the resolved type is `sub`, the command prints the `treebird-chat <path> --as <agent>` join command instead of opening the file in a pager.
- **Wikilink resolver** (`lib/wikilink.mjs`) — parses `[[target]]` syntax and resolves to file path, type (`chat` | `doc` | `sub` | `task` | `mem`), and active status. Supports `sub:`, `task:`, `mem:` prefixes; plain `[[filename]]` searches sibling dir then workspace roots. Active detection via `.bridge-cursor.json` sidecar or parent `.subs.json` entry.
- **TUI wikilink highlighting** — `[[wikilinks]]` rendered in cyan in all received messages.
- **`/sub <topic>` command** (`bin/treebird-chat.mjs`) — creates a sub-collab file (sibling to the current file, `_sub_<topic>_<HH:MM>` suffix), inherits parent ACL, registers in `.subs.json`, posts a `[[wikilink]]` pointer into the parent. If the sub already exists, prints the join command instead.
- **`/subs` command** — lists all sub-collabs for the current session with active/closed status.
- **`/preview <target>` command** — inlines the first 20 lines of any linked file.
- **Sub lifecycle** (`lib/subs.mjs`, `bin/treebird-chat.mjs`, `bin/treebird-chat-join.mjs`) — `/close [summary]` in a sub TUI posts a summary back to the parent chat and marks the sub closed in `.subs.json`. Auto-summary reads the last 3 protocol lines if no text is provided. `--parent <file>` flag on both binaries wires the close path.

#### Fixed

- **`/open` on sub-collabs opened in pager** — sub files are meant to be joined in a new TUI session, not read in `less`. `/open` now detects `type === 'sub'` and prints the `treebird-chat` join command.
- **Malformed protocol lines invisible in TUI** — lines missing a `[HH:MM agent]` prefix are silently dropped by `printLine`. Added timestamp fixup for lines written as `[ agent]` (space-only where time should be).

#### Added

- **`treebird-chat-join`** (`bin/treebird-chat-join.mjs`) — single-command remote session join. Collapses the old 6-step paste block (touch, env, bridge, allow, corrwait, reply) into `treebird-chat-join <chatId> [--as agent] [--tui]`. Reads `SMALLTOAK_TOKEN` from `~/.treebird-chat/.env` (never argv or shell history), resolves the smalltoak URL, spawns the bridge as a managed child, then runs a corrwait loop (agents) or opens the TUI (`--tui`, humans). Solves R-invite-2 — agents were misreading the multi-step paste block as in-session instructions.
- **Single-instance bridge lock** (`treebird-chat-join`) — a stale-PID-aware lockfile per `(chatId, mirror)` refuses to start a second bridge on the same file. Prevents the two-bridges-one-file echo storm where each bridge re-pushes the other's writes.
- **`resolvePublicUrl()` / `localIPv4s()`** (`lib/config.mjs`) — detect a loopback host in a cross-machine invite and rewrite it to the host's reachable IP (Thunderbolt `192.168.100.x` preferred, link-local `169.254.x.x` excluded), listing other routes as alternates.

#### Fixed

- **`localhost` in cross-machine invites** — invites embedded the session's smalltoak URL verbatim; when the server ran on `localhost`, remote invitees connected to their own machine and their messages silently never reached the chat. Invites now rewrite the host to a reachable IP via `resolvePublicUrl()`.
- **Token in invite blocks** — the invite output put a live `SMALLTOAK_TOKEN` into shell history / clipboard / chat logs. Token now lives only in `~/.treebird-chat/.env` (0600); the invite shows a one-time setup block using `printf` + `envoak vault get` command-substitution so the secret never appears literally. Fixed in both the TUI `/invite` and the standalone `treebird-chat-invite` CLI.
- **chatId path traversal in `treebird-chat-join`** — `chatId` flowed unvalidated into `/tmp/${chatId}.md`. Now guarded with `/^[a-zA-Z0-9_-]+$/`.
- **`treebird-chat-join` spun against a dead bridge** — bridge exit only logged; the corrwait loop kept re-arming forever. Bridge exit now triggers `cleanup()`.
- **TUI word wrap** (`bin/treebird-chat.mjs`) — `wordWrap` now breaks on em-dash (heavily used in agent messages) as well as spaces, and hard-cuts cleanly when no break point exists in the width window.
- **Watcher cursor skipped continuation lines** (`lib/watcher.mjs`) — the cursor mis-handled multi-line flat messages.
- **Smalltoak bridge echo storm** (`lib/bridge.mjs`, `lib/markdown-archive.mjs`) — the bridge's self-echo guard used a `Set` for appended-line content, which collapses duplicate content: once one identical self-line was consumed, a second went unrecognized whenever the line-number guard also missed, and the bridge re-posted its own echo in a loop. Replaced with a counting multiset (`createSelfContentLedger()`) — one credit per self-append, retired on match. `markdown-archive#appendLine` now scans from the end of the file so a stale earlier duplicate is never mistaken for the just-appended line.

#### Changed

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
