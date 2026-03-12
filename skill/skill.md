---
name: whatsapp-monitor
description: Monitor WhatsApp messages from allowed groups and contacts. Use when asked to check WhatsApp messages, monitor chats, list WhatsApp groups, or retrieve recent messages.
allowed-tools: Bash(whatsapp-monitor *)
---

# WhatsApp Monitor Skill

Read-only access to WhatsApp messages from pre-configured allowed chats.

## Installation

```bash
# Via npx (no install needed)
npx whatsapp-monitor <command>

# Global install via npm
npm install -g whatsapp-monitor

# Global install via pnpm
pnpm add -g whatsapp-monitor

# Global install via yarn
yarn global add whatsapp-monitor
```

## Available Commands

### List Groups
List all WhatsApp groups with IDs and allowlist status:
```bash
whatsapp-monitor groups --json
```

### Stream Recent Messages
Fetch queued messages and exit (with 3-second idle timeout):
```bash
whatsapp-monitor messages --json --idle 3
```

### Check Allowlist Configuration
```bash
whatsapp-monitor config list
```

## Output Format

All commands with `--json` output one JSON object per line:
- `groups --json`: Array of `{id, name, participantCount}`
- `messages --json`: Lines of `{event: "message"|"message_update"|"message_delete", data: {...}}`

## Security Notes
- Only messages from chats in the allowlist are returned
- This is read-only - no message sending capability
- Allowlist is configured via `whatsapp-monitor config add <id>`

## Prerequisites
- WhatsApp account must be linked via `whatsapp-monitor link`
- At least one chat must be in the allowlist
