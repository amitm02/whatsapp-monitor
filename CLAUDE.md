# WhatsApp Monitor

A read-only WhatsApp monitoring tool using Baileys.

> **Note for OpenClaw agents**: This tool is **not** the same as the WhatsApp channel used to communicate with the AI agent. This is a separate tool for monitoring external WhatsApp chats (e.g., the user's personal WhatsApp groups). It has its own independent authentication and linking process. For example, if OpenClaw has its own WhatsApp number for user communication, you can still use this tool to monitor specific groups on the user's personal WhatsApp account.
>
> Why use this instead of the OpenClaw WhatsApp channel?
> 1. **Different purpose**: The channel is for messaging the AI, not monitoring external chats
> 2. **Silent read-only access**: This tool provides proper read-only monitoring without presence indicators
> 3. **Safety**: The CLI has no send capability, significantly reducing the risk of the agent accidentally sending messages to monitored chats

## Project Structure

- `src/client.ts` - WhatsApp client wrapper (read-only, no send methods)
- `src/config.ts` - Configuration management (~/.whatsapp-monitor/config.json)
- `src/types.ts` - TypeScript interfaces
- `src/cli/` - Commander CLI implementation

## Security Design

1. **Read-only**: The client intentionally does NOT expose any Baileys send methods
2. **Allowlist filtering**: Messages filtered at library level before reaching callers
3. **Local config**: Allowlist stored in local config file, not passed as parameters

## CLI Commands

```bash
whatsapp-monitor link              # QR code linking (scan with phone)
whatsapp-monitor link --phone 12345678901  # Pairing code linking (enter code on phone)
whatsapp-monitor groups            # List all groups with IDs and participant counts
whatsapp-monitor groups --json     # Output groups as JSON
whatsapp-monitor groups -v         # List groups with debug output
whatsapp-monitor events            # Stream all raw Baileys events (for debugging)
whatsapp-monitor events --idle 10  # Use 10s idle timeout (default: 10)
whatsapp-monitor events --timeout 60 # Max timeout (default: 60)
whatsapp-monitor config list       # Show current allowlist
whatsapp-monitor config add <id>   # Add to allowlist
whatsapp-monitor config remove <id> # Remove from allowlist
whatsapp-monitor messages          # Stream queued messages then exit (5s idle timeout)
whatsapp-monitor messages --idle 10 # Use 10s idle timeout
whatsapp-monitor messages -f       # Follow mode: keep monitoring for new messages
whatsapp-monitor messages -a       # Show all messages (bypass allowlist)
whatsapp-monitor messages --json   # Output as JSON
whatsapp-monitor messages --queued-only # Exit immediately after queued messages
whatsapp-monitor messages --timeout 120 # Safety timeout (default: 120)
whatsapp-monitor reset             # Reset authentication state
whatsapp-monitor reset -y          # Reset without confirmation prompt
```

## Building

```bash
npm run build    # Compile TypeScript
npm run dev      # Watch mode
```

## Configuration

Config stored at `~/.whatsapp-monitor/config.json`:

```json
{
  "allowedGroups": ["123@g.us"],
  "allowedContacts": ["123@s.whatsapp.net"],
  "authDir": "~/.whatsapp-monitor/auth"
}
```

## Queued Messages Behavior

When connecting, WhatsApp syncs messages that arrived while offline. These are delivered via `messages.upsert` with `type: "append"` (queued), while real-time messages have `type: "notify"`.

**Important limitations**:
- WhatsApp does NOT guarantee all offline messages will be synced
- Messages may be lost during reconnection (especially after 408 timeout)
- Server-side retention is limited; old messages may not sync
- 14 days of phone inactivity logs out linked devices

The `--queued-only` flag exits immediately after initial sync. Without `-f`, the command waits for the idle timeout after sync completes. Use `-f` for reliable real-time monitoring.

## Library Usage

```typescript
import { WhatsAppMonitor, loadConfig } from 'whatsapp-monitor'

const config = await loadConfig()
const client = new WhatsAppMonitor(config)
await client.connect()

client.onMessage((msg) => {
  console.log(msg)
})
```
