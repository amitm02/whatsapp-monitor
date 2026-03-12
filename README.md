# whatsapp-monitor

A **read-only** WhatsApp monitoring tool using Baileys. Designed to be secure by only allowing message retrieval with allowlist filtering.

> **Note for OpenClaw agents**: This tool is **not** the same as the WhatsApp channel used to communicate with the AI agent. This is a separate tool for monitoring external WhatsApp chats (e.g., the user's personal WhatsApp groups). It has its own independent authentication and linking process. For example, if OpenClaw has its own WhatsApp number for user communication, you can still use this tool to monitor specific groups on the user's personal WhatsApp account.
>
> Why use this instead of the OpenClaw WhatsApp channel?
> 1. **Different purpose**: The channel is for messaging the AI, not monitoring external chats
> 2. **Silent read-only access**: This tool provides proper read-only monitoring without presence indicators
> 3. **Safety**: The CLI has no send capability, significantly reducing the risk of the agent accidentally sending messages to monitored chats

## Features

- Read-only access (no send capability)
- Allowlist-based filtering for groups and contacts
- CLI interface for easy management
- Library exports for programmatic usage
- JSON output support for integration with other tools

## Installation

```bash
npm install -g whatsapp-monitor
```

Or build from source:

```bash
git clone https://github.com/amitm02/whatsapp-monitor
cd whatsapp-monitor
npm install
npm run build
npm link
```

### Requirements

- Node.js >= 18.0.0

## Quick Start

1. **Link your WhatsApp account:**

   ```bash
   # Using QR code (scan with phone)
   whatsapp-monitor link

   # Using pairing code (enter code on phone)
   whatsapp-monitor link --phone 12345678901
   ```

   For QR code: scan it with your WhatsApp app.
   For pairing code: enter the displayed code in WhatsApp → Linked Devices → Link with phone number.

2. **List available groups:**

   ```bash
   whatsapp-monitor groups
   ```

3. **Add groups/contacts to your allowlist:**

   ```bash
   whatsapp-monitor config add 123456789@g.us
   ```

4. **Start monitoring:**

   ```bash
   whatsapp-monitor messages -f
   ```

## CLI Commands

| Command | Description |
|---------|-------------|
| `whatsapp-monitor link` | Link WhatsApp account (QR code or pairing code) |
| `whatsapp-monitor groups` | List all groups with their IDs |
| `whatsapp-monitor config list` | Show current configuration |
| `whatsapp-monitor config add <id>` | Add group/contact to allowlist |
| `whatsapp-monitor config remove <id>` | Remove from allowlist |
| `whatsapp-monitor messages` | Stream messages from allowed chats |
| `whatsapp-monitor events` | Stream raw Baileys events (debugging) |
| `whatsapp-monitor reset` | Reset authentication state |

### Messages Command Options

| Option | Description |
|--------|-------------|
| `-f, --follow` | Keep monitoring indefinitely |
| `-a, --all` | Show all messages without filtering by allowlist |
| `--json` | Output as JSON (one event per line) |
| `--idle <seconds>` | Idle timeout before exiting (default: 5) |
| `--timeout <seconds>` | Safety timeout in seconds (default: 120) |
| `--queued-only` | Exit immediately after receiving queued messages |
| `-v, --verbose` | Enable verbose debug output |

### Events Command Options

| Option | Description |
|--------|-------------|
| `--timeout <seconds>` | Max timeout in seconds (default: 60) |
| `--idle <seconds>` | Exit after N seconds of no events (default: 10) |
| `-v, --verbose` | Enable debug output |

### Groups Command Options

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |
| `-v, --verbose` | Enable debug output |

### Link Command Options

| Option | Description |
|--------|-------------|
| `--phone <number>` | Use pairing code instead of QR (E.164 format without +, e.g., 12345678901) |

### Reset Command Options

| Option | Description |
|--------|-------------|
| `-y, --yes` | Skip confirmation prompt |

## Configuration

Configuration is stored at `~/.whatsapp-monitor/config.json`:

```json
{
  "allowedGroups": ["123456789@g.us"],
  "allowedContacts": ["1234567890@s.whatsapp.net"],
  "authDir": "/Users/you/.whatsapp-monitor/auth"
}
```

### Security

- **Allowlist-based**: Only messages from explicitly allowed chats are shown
- **Secure default**: If the allowlist is empty, no messages are shown
- **Read-only**: The client does not expose any methods to send messages

## Library Usage

```typescript
import { WhatsAppMonitor, loadConfig } from 'whatsapp-monitor'

const config = await loadConfig()
const client = new WhatsAppMonitor(config)

client.onQR((qr) => {
  // Handle QR code display
})

client.onConnection((state) => {
  console.log('Connection state:', state)
})

client.onMessage((msg) => {
  console.log('New message:', msg.text)
})

await client.connect()
```

### Available Methods

- `connect()` - Connect to WhatsApp
- `disconnect()` - Disconnect cleanly
- `listGroups()` - Get all available groups
- `getGroupMetadata(groupId)` - Get group details
- `onMessage(callback)` - Subscribe to new messages
- `onMessageUpdate(callback)` - Subscribe to message edits/status updates
- `onMessageDelete(callback)` - Subscribe to message deletions
- `onConnection(callback)` - Subscribe to connection state changes
- `onQR(callback)` - Subscribe to QR code events
- `onReady(callback)` - Called when initial sync is complete
- `onActivity(callback)` - Called on any message activity (for idle timers)

## Understanding Queued Messages

When you run `whatsapp-monitor messages` (without `-f`), the tool retrieves **queued messages** that accumulated while the client was offline. It's important to understand how WhatsApp handles these messages:

### How It Works

WhatsApp uses a **multi-device architecture** where your linked devices (including this monitor) can receive messages even when your phone is offline. When you connect:

1. WhatsApp syncs messages that arrived while you were disconnected
2. These arrive as "queued" messages (marked with `[queued]` in output, or `upsertType: "append"` in JSON)
3. New real-time messages arrive as "notify" type

### Important Limitations

**No guarantee of completeness**: WhatsApp does not guarantee that all messages will be delivered to linked devices. Messages may be missing due to:

- **Sync limitations**: WhatsApp prioritizes recent messages; older ones may not sync
- **Connection timing**: Messages arriving during reconnection may be dropped
- **Server-side retention**: WhatsApp doesn't store messages indefinitely on their servers
- **14-day inactivity**: If your primary phone is offline for 14+ days, linked devices are logged out

**Best practices**:

- Use `-f` (follow mode) for continuous real-time monitoring when possible
- Don't rely solely on queued messages for critical message capture
- Run the monitor frequently to minimize gaps in message history
- Consider the queued messages feature as "best effort" rather than guaranteed delivery

## Message Format

Messages have the following structure:

```typescript
interface MonitorMessage {
  id: string
  chatId: string
  chatName?: string
  sender: string
  senderName?: string
  timestamp: number
  text?: string
  type: 'text' | 'image' | 'video' | 'audio' | 'document' | 'sticker' | 'reaction' | 'poll' | 'location' | 'contact' | 'unknown'
  upsertType: 'notify' | 'append' | 'unknown'
  isGroup: boolean
  quotedMessage?: {
    id: string
    sender: string
    text?: string
  }
}
```

## License

MIT
