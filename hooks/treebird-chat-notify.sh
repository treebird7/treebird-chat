#!/usr/bin/env bash
# UserPromptSubmit — @mention notifications from treebird-chat
#
# Scans registered chat files for new @mentions of the current agent and
# injects them as a system message on the next Claude Code turn.
# Silent (exits 0, outputs '{}') when no mentions or no agent identity.
#
# Install: copy to ~/.claude/hooks/treebird-chat-notify.sh
# Register in ~/.claude/settings.json under UserPromptSubmit hooks.
#
# Register a file to watch:
#   treebird-chat-watch add ~/treebird-shared/collab/CONSORTIUM_*.md

AGENT="${ENVOAK_AGENT_LABEL:-${BIRDCHAT_AGENT:-}}"
if [ -z "$AGENT" ]; then
  echo '{}'
  exit 0
fi

result=$(node ~/Dev/treebird-chat/bin/treebird-chat-watch.mjs scan-and-drain "$AGENT" 2>/dev/null)
if [ -z "$result" ]; then
  echo '{}'
  exit 0
fi

jq -n --arg msg "$result" '{"systemMessage": $msg}'
