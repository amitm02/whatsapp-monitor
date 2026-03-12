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

## First-Time Setup (Required)

Before using any commands, the user must link their WhatsApp account. This is a **one-time interactive process** that requires the user to scan a QR code with their phone.

```bash
whatsapp-monitor link
```

This will display a QR code in the terminal. The user must:
1. Open WhatsApp on their phone
2. Go to Settings → Linked Devices → Link a Device
3. Scan the QR code displayed in the terminal

**The agent cannot complete this step automatically** - it requires user interaction. Once linked, the session is saved and subsequent commands will work without re-linking.

To check if already linked, run any command (e.g., `whatsapp-monitor groups`). If it connects successfully, the account is linked. If it shows a QR code, the user needs to scan it.

## Commands Reference

### messages
Stream messages from allowed chats. Default behavior: fetch queued messages, wait for idle timeout, then exit.

```bash
whatsapp-monitor messages [options]
```

| Option | Description |
|--------|-------------|
| `-f, --follow` | Keep monitoring indefinitely (do not use for agent tasks) |
| `-a, --all` | Show all messages without filtering by allowlist |
| `--json` | Output as JSON (one event per line) |
| `--idle <seconds>` | Idle timeout before exiting (default: 5) |
| `--timeout <seconds>` | Safety timeout in seconds (default: 120) |
| `--queued-only` | Exit immediately after receiving queued messages |
| `-v, --verbose` | Enable verbose debug output |

### groups
List all WhatsApp groups with IDs, participant counts, and allowlist status.

```bash
whatsapp-monitor groups [options]
```

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |
| `-v, --verbose` | Enable debug output |

### config
Manage allowlist configuration.

```bash
whatsapp-monitor config list              # Show current allowlist
whatsapp-monitor config add <id>          # Add group/contact to allowlist
whatsapp-monitor config remove <id>       # Remove from allowlist
```

### link
Display QR code to link WhatsApp account (interactive, requires user to scan).

```bash
whatsapp-monitor link
```

### reset
Reset authentication state (requires re-linking).

```bash
whatsapp-monitor reset [options]
```

| Option | Description |
|--------|-------------|
| `-y, --yes` | Skip confirmation prompt |

## Queued Messages Behavior

When running `messages` without `-f`, the tool retrieves messages that accumulated while offline. **Important**: WhatsApp does not guarantee all offline messages will be delivered. Messages may be missing due to sync limitations, connection timing, or server-side retention limits.

## Security Notes
- Only messages from chats in the allowlist are returned (unless `-a` is used)
- This is read-only - no message sending capability

## Prerequisites
- WhatsApp account must be linked via `whatsapp-monitor link`
- At least one chat must be in the allowlist (or use `-a` to bypass)
