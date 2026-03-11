# whatsapp-monitor

A **read-only** WhatsApp monitoring tool using Baileys. Designed to be secure by only allowing message retrieval with allowlist filtering.

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

Or use locally:

```bash
git clone https://github.com/yourusername/whatsapp-monitor
cd whatsapp-monitor
npm install
npm run build
npm link
```

## Quick Start

1. **Link your WhatsApp account:**

   ```bash
   whatsapp-monitor link
   ```

   Scan the QR code with your WhatsApp app.

2. **List available groups and contacts:**

   ```bash
   whatsapp-monitor groups
   whatsapp-monitor contacts
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
| `whatsapp-monitor link` | Display QR code to link WhatsApp account |
| `whatsapp-monitor groups [--full] [-v]` | List all groups with their IDs |
| `whatsapp-monitor contacts [-v]` | List all contacts with their IDs |
| `whatsapp-monitor config list` | Show current configuration |
| `whatsapp-monitor config add <id>` | Add group/contact to allowlist |
| `whatsapp-monitor config remove <id>` | Remove from allowlist |
| `whatsapp-monitor messages [-f] [--json] [--idle <s>]` | Stream messages from allowed chats (-f to follow) |
| `whatsapp-monitor events` | Stream raw Baileys events (debugging) |

### Options

- `--json` - Output messages as JSON (one per line)
- `-f, --follow` - Keep monitoring indefinitely (for `messages` command)
- `--idle <seconds>` - Idle timeout before exiting (default: 5, for `messages` command)
- `--chat <id>` - Filter to a specific chat
- `--full` - For `groups`: fetch all groups using API (slower but includes participant counts)
- `-v, --verbose` - Enable debug output (shows sync events, connection state, timing)

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
- `listContacts()` - Get all synced contacts
- `getGroupMetadata(groupId)` - Get group details
- `onMessage(callback)` - Subscribe to new messages
- `onConnection(callback)` - Subscribe to connection state changes
- `onQR(callback)` - Subscribe to QR code events

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
