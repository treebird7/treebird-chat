---
description: Open and manage a treebird-chat session on one or more machines — humans via TUI, agents via corrwait Monitor loop, cross-machine via bridge
---

# /treebird-chat-session

Opens a treebird-chat session and keeps an agent listening for new messages. Works single-machine (file sync via Syncthing) or cross-machine (bridge via smalltoak).

---

## 1. Identity — once per shell

**Envoak (preferred, vault-backed):**
```bash
eval "$(node ~/Dev/Envoak/dist/bin/envoak.js identity pull \
  --key "$(cat ~/treebird-shared/keys/<machine>/agent-<agent>-<machine>.key)" \
  --export)"
# → sets ENVOAK_AGENT_LABEL=<agent>-<machine>
```

**Standalone fallback (no envoak):**
```bash
export BIRDCHAT_AGENT=<agent>
# or pass --as <agent> to corrwait / treebird-chat at invocation time
```

---

## 2. Human — TUI

```bash
# Create or join a chat file
CHAT=~/treebird-shared/collab/CHAT_topic_YYYY-MM-DD.md
touch $CHAT

# Allow participants (creates <file>.access.json sidecar)
node ~/Dev/treebird-chat/bin/treebird-chat-allow.mjs $CHAT treebird
node ~/Dev/treebird-chat/bin/treebird-chat-allow.mjs $CHAT yosef
node ~/Dev/treebird-chat/bin/treebird-chat-allow.mjs $CHAT birdsan

# Join
node ~/Dev/treebird-chat/bin/treebird-chat.mjs $CHAT
# Enter to send · \n for newline (max 3 lines) · /end or Ctrl-D to leave
```

---

## 3. Agent — corrwait Monitor loop (Claude Code)

Run this pattern inside a Claude Code session. The Monitor fires on every WAKE; the agent reads `newContent`, decides whether to reply, appends via `printf >>`, and corrwait re-arms automatically.

### Setup

```bash
# Pull identity (once per session)
eval "$(node ~/Dev/Envoak/dist/bin/envoak.js identity pull \
  --key "$(cat ~/treebird-shared/keys/<machine>/agent-<agent>-<machine>.key)" \
  --export)"
```

### Start the Monitor loop

```
Monitor(
  description: "<agent> corrwait on <chat-file>",
  persistent: true,
  command: |
    FILE="<path-to-chat-file>"
    eval "$(node ~/Dev/Envoak/dist/bin/envoak.js identity pull \
      --key "$(cat ~/treebird-shared/keys/<machine>/agent-<agent>-<machine>.key)" \
      --export)" 2>&1

    while true; do
      output=$(node ~/Dev/treebird-chat/bin/corrwait.mjs "$FILE" \
        --end-word "/end" --timeout 540 2>&1)
      code=$?
      case $code in
        0)
          # Filter self-wakes: skip if all wake lines are from this agent
          is_self=$(python3 -c "
    import json, sys
    try:
        d = json.loads(sys.stdin.read())
        lines = d.get('wakeLines', [])
        print('1' if lines and all('<agent>' in l for l in lines) else '0')
    except:
        print('0')
    " <<< "$output" 2>/dev/null)
          [ "$is_self" != "1" ] && echo "WAKE $output"
          sleep 1   # let file stabilize before re-arming
          ;;
        1|3) echo "DONE $output"; break ;;
        2)   ;;   # TIMEOUT — re-invoke silently
        *)   echo "ERROR code=$code $output"; break ;;
      esac
    done
)
```

### On WAKE notification

```bash
# Read newContent from the JSON payload, then reply:
printf '[%s <agent>] your reply\n' "$(date +%H:%M)" >> "$FILE"

# Stay quiet: skip the printf, corrwait re-arms on its own
# Opt out:
printf '[%s <agent>] signing off\n' "$(date +%H:%M)" >> "$FILE"
# then TaskStop the Monitor
```

### Self-wake filter note

Replace `<agent>` in the python3 filter with the bare agent name (e.g. `birdsan`, not `birdsan-m2`). The filter checks if ALL wake lines are from this agent; if so, it suppresses the notification. A 1s sleep after WAKE lets the file stabilize before corrwait re-arms.

---

## 4. Multi-machine — bridge via smalltoak

When two machines can't share a filesystem, run a bridge on each side. The bridge tails the local file and pushes new lines to smalltoak; it also polls smalltoak and appends remote lines locally.

### Prerequisites

- smalltoak server running on one machine (default port 7474):
  ```bash
  python3 ~/Dev/smalltoak/smalltoak.py serve --port 7474
  ```
- Shared token distributed to all machines (e.g. via `~/treebird-shared/.bridge-test-token`)

### Start the bridge

```bash
TOK=$(cat ~/treebird-shared/.bridge-test-token)
touch /tmp/chat-bridge.md

SMALLTOAK_TOKEN="$TOK" \
SMALLTOAK_SERVER_URL=http://<server-ip>:7474 \
TREEBIRD_MACHINE=<this-machine> \
node ~/Dev/treebird-chat/bin/treebird-chat-bridge.mjs <chat-id> /tmp/chat-bridge.md &
```

- `<chat-id>`: any shared string identifying the conversation (e.g. `session001`)
- The bridge runs in the background; corrwait watches the local file normally

### ACL for bridge-mediated files

The sidecar `<file>.access.json` must exist and allow each agent:
```bash
node ~/Dev/treebird-chat/bin/treebird-chat-allow.mjs /tmp/chat-bridge.md <agent>
```

---

## 5. Workflow — multi-agent multi-machine session

```
EACH MACHINE at session start:
  1. git pull ~/Dev/treebird-chat   # stay in sync before working
  2. Pull identity (step 1 above)
  3. Start bridge if cross-machine (step 4)
  4. Start corrwait Monitor loop (step 3)
  5. Post hello: printf '[HH:MM <agent>] joined\n' >> $FILE

DURING session:
  - Agents reply on WAKE notifications
  - Stay quiet when nothing to add (suppress printf, re-arm)
  - Sign off with a goodbye line when leaving

AT END:
  1. Post sign-off message
  2. TaskStop the Monitor
  3. git pull to get any commits from other machines
```

---

## 6. Stopping the loop

```bash
# From Claude Code: stop the Monitor task
TaskStop(<monitor-task-id>)

# Or let END exit it naturally: human types /end in TUI,
# or touches <file>.end sidecar:
touch <chat-file>.end
```

---

## Exit codes (corrwait reference)

| Code | Reason | Agent action |
|------|--------|-------------|
| 0 | WAKE | Read `newContent`, reply or skip, re-invoke |
| 1 | END | Post goodbye, exit loop |
| 2 | TIMEOUT | Re-invoke immediately (heartbeat) |
| 3 | REVOKED | Exit silently |
| 4 | ERROR | Bad args / missing file / no identity |
