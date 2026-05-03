---
description: Run a treebird-chat consortium — structured multi-agent meeting with agenda, roles, decisions log, action items, and close ceremony
---

# /consortium

Runs a structured multi-agent + human meeting on a treebird-chat file. Produces a decision log, action items, and a TLDR. Works single-machine or cross-machine via bridge.

---

## 1. Before the meeting — facilitator setup

```bash
# Create the chat file from template
DATE=$(date +%Y-%m-%d)
TOPIC="topic-slug"
CHAT=~/treebird-shared/collab/CONSORTIUM_${TOPIC}_${DATE}.md
cp ~/Dev/treebird-chat/templates/CONSORTIUM_template.md $CHAT

# Fill in header: facilitator, goal, participants, agenda
# (use your editor — file isn't live yet)

# Allow all participants
node ~/Dev/treebird-chat/bin/treebird-chat-allow.mjs $CHAT treebird
node ~/Dev/treebird-chat/bin/treebird-chat-allow.mjs $CHAT yosef
node ~/Dev/treebird-chat/bin/treebird-chat-allow.mjs $CHAT birdsan
# Add observers too — they can read but should stay quiet

# Cross-machine: start the bridge on each machine
# See treebird-chat-session skill, step 4
```

---

## 2. Opening — facilitator

Post the opening line to signal start:

```bash
printf '[%s %s] consortium open — goal: %s. agenda: %s\n' \
  "$(date +%H:%M)" "FACILITATOR" "GOAL" "3 items, see header" >> $CHAT
```

Then open each agenda item when ready:
```bash
printf '[%s %s] item 1: %s\n' "$(date +%H:%M)" "FACILITATOR" "DESCRIPTION" >> $CHAT
```

---

## 3. Agent join — each agent

```bash
# Pull identity
eval "$(node ~/Dev/Envoak/dist/bin/envoak.js identity pull \
  --key "$(cat ~/treebird-shared/keys/<machine>/agent-<agent>-<machine>.key)" \
  --export)"

# Pull latest + start bridge if cross-machine
git -C ~/Dev/treebird-chat pull

# Post join
printf '[%s <agent>] joined\n' "$(date +%H:%M)" >> $CHAT

# Start corrwait Monitor loop (see treebird-chat-session skill, step 3)
```

---

## 4. During the meeting

### Turn discipline

- **Reply when you have something to add.** Stay quiet otherwise — re-invoke corrwait, don't post filler.
- **@mention** to direct a question: `[HH:MM yosef] @birdsan can you check X?`
- **Keep turns tight.** One topic per message. If it's long, split into two posts.

### Logging decisions

When a decision is reached, any participant logs it inline:

```bash
printf '[%s <agent>] [DECISION] %s\n' "$(date +%H:%M)" "DECISION TEXT" >> $CHAT
```

The facilitator collects `[DECISION]` lines into the Decisions section at close.

### Closing an agenda item

```bash
printf '[%s %s] item 1 closed\n' "$(date +%H:%M)" "FACILITATOR" >> $CHAT
```

---

## 5. Close ceremony — facilitator

**Step 1 — signal close:**
```bash
printf '[%s %s] consortium closing — posting TLDR\n' "$(date +%H:%M)" "FACILITATOR" >> $CHAT
```

**Step 2 — collect decisions:**
```bash
grep '\[DECISION\]' $CHAT
# Paste into the Decisions section of the file header
```

**Step 3 — collect action items:**
Fill in the Action Items table in the header (owner, due date, status).

**Step 4 — post TLDR:**
```bash
printf '[%s %s] [TLDR] %s\n' "$(date +%H:%M)" "FACILITATOR" "ONE PARAGRAPH SUMMARY" >> $CHAT
```

**Step 5 — signal end (closes all corrwait loops):**
```bash
touch $CHAT.end
# or: printf '[%s %s] /end\n' "$(date +%H:%M)" "FACILITATOR" >> $CHAT
```

**Step 6 — memoak ingest (optional but recommended):**
```bash
# Run /memoak-ingest or /close in each agent's session
# to persist decisions and lessons to the shared knowledge store
```

**Step 7 — commit the file:**
```bash
git -C ~/Dev/treebird-chat add -A
git -C ~/Dev/treebird-chat commit -m "consortium: $TOPIC $DATE — decisions + action items"
git -C ~/Dev/treebird-chat push
```

---

## 6. Roles reference

| Role | Responsibilities |
|------|-----------------|
| **Facilitator** | Opens/closes items, keeps pace, posts TLDR, triggers /end |
| **Agent** | corrwait loop, replies on WAKE, logs [DECISION] lines |
| **Observer** | corrwait loop (or tail), stays quiet, reads only |
| **memosan-tldr** | (optional) posts summary every N messages automatically |

---

## 7. File naming convention

```
CONSORTIUM_<topic-slug>_<YYYY-MM-DD>.md
```

Examples:
- `CONSORTIUM_smalltoak-publish_2026-05-03.md`
- `CONSORTIUM_sprint-planning_2026-05-10.md`
- `CONSORTIUM_architecture-review_2026-05-17.md`

Keep files in `~/treebird-shared/collab/` for Syncthing availability across machines.
