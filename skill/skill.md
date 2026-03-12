---
name: whatsapp-monitor
description: Monitor WhatsApp messages from allowed groups and contacts. Use when asked to check WhatsApp messages, monitor chats, list WhatsApp groups, or retrieve recent messages.
allowed-tools: Bash(whatsapp-monitor *)
---

# WhatsApp Monitor Skill

Read-only access to WhatsApp messages from pre-configured allowed chats.

> **Note for OpenClaw agents**: This skill is **not** the same as the WhatsApp channel used to communicate with the AI agent. This is a separate tool for monitoring external WhatsApp chats (e.g., the user's personal WhatsApp groups). It has its own independent authentication and linking process. For example, if OpenClaw has its own WhatsApp number for user communication, you can still use this skill to monitor specific groups on the user's personal WhatsApp account.
>
> Why use this instead of the OpenClaw WhatsApp channel?
> 1. **Different purpose**: The channel is for messaging the AI, not monitoring external chats
> 2. **Silent read-only access**: This tool provides proper read-only monitoring without presence indicators
> 3. **Safety**: The CLI has no send capability, significantly reducing the risk of the agent accidentally sending messages to monitored chats

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

Before using any commands, the user must link their WhatsApp account. This is a **one-time interactive process** that requires user involvement.

### For AI Agent Use (Recommended)

Use pairing code authentication - the agent displays a code that the user enters manually:

```bash
whatsapp-monitor link --phone <phone-number>
```

The phone number must be in E.164 format without the + sign (e.g., `12345678901` for US number +1-234-567-8901).

The agent will display an 8-digit pairing code. The user must:
1. Open WhatsApp on their phone
2. Go to Settings → Linked Devices → Link a Device
3. Tap "Link with phone number instead"
4. Enter the pairing code displayed by the agent

### For Manual Use (QR Code)

Use QR code authentication when running interactively:

```bash
whatsapp-monitor link
```

This will display a QR code in the terminal. The user must:
1. Open WhatsApp on their phone
2. Go to Settings → Linked Devices → Link a Device
3. Scan the QR code displayed in the terminal

**Either method requires user interaction** - the agent cannot complete linking automatically. Once linked, the session is saved and subsequent commands will work without re-linking.

To check if already linked, run any command (e.g., `whatsapp-monitor groups`). If it connects successfully, the account is linked. If it shows a QR code or pairing code prompt, the user needs to complete the linking process.

## Configuring the Allowlist

After linking, ask the user which groups or contacts they want to monitor.

### Adding Groups
1. Run `whatsapp-monitor groups` to list all available groups with their IDs
2. Ask the user which groups they want to monitor
3. Add each group with `whatsapp-monitor config add <group-id>`

### Adding Contacts (DMs)
There is no direct way to list contact IDs from WhatsApp. To get a contact's ID:
1. Ask the user to have that person send them a message
2. Run `whatsapp-monitor messages -a` to see all messages (bypassing allowlist)
3. Find the contact's ID from the message output (format: `1234567890@s.whatsapp.net`)
4. Add the contact with `whatsapp-monitor config add <contact-id>`

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
Link WhatsApp account via QR code or pairing code (interactive, requires user involvement).

```bash
whatsapp-monitor link [options]
```

| Option | Description |
|--------|-------------|
| `--phone <number>` | Use pairing code instead of QR (E.164 format without +, e.g., 12345678901) |

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
