# WhatsApp Monitor

A read-only WhatsApp monitoring tool using Baileys.

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
whatsapp-monitor link              # QR code linking
whatsapp-monitor groups            # List all groups with IDs and participant counts
whatsapp-monitor groups -v         # List groups with debug output
whatsapp-monitor events            # Stream all raw Baileys events (for debugging)
whatsapp-monitor config list       # Show current allowlist
whatsapp-monitor config add <id>   # Add to allowlist
whatsapp-monitor config remove <id> # Remove from allowlist
whatsapp-monitor messages          # Stream queued messages then exit (5s idle timeout)
whatsapp-monitor messages --idle 10 # Use 10s idle timeout
whatsapp-monitor messages -f       # Follow mode: keep monitoring for new messages
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
