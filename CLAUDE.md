# WhatsApp Monitor

A read-only WhatsApp **monitoring service** using Baileys. Runs as a persistent listener and hands batched notifications to a configurable shell command (webhook, `openclaw agent`, log, etc.).

> This is **monitoring**, not a chat channel. It surfaces messages from an external WhatsApp account *into* another tool. It cannot send.
>
> **Note for OpenClaw agents**: `@openclaw/whatsapp` is a bidirectional *channel* — how a user talks to the agent. This tool is a one-way *input*: it observes a separate (typically personal) WhatsApp account read-only, so the agent can react without being able to send from that account.

## Project Structure

- `src/client.ts` — WhatsApp client wrapper (read-only, no send methods)
- `src/config.ts` — Configuration management (`~/.whatsapp-monitor/config.json`)
- `src/types.ts` — TypeScript interfaces
- `src/notifier.ts` — Per-chat quiet-period buffering (pure; no Baileys dep)
- `src/dispatcher.ts` — Spawns `notify.command`, writes JSON to stdin, appends to JSONL log
- `src/cli/commands/run.ts` — The `run` command (persistent listener)
- `src/cli/commands/notify.ts` — The `notify test` command
- `src/cli/` — Commander CLI implementation
- `skills/whatsapp-monitor/SKILL.md` — Agent-facing onboarding + operations skill (self-contained)

## Security Design

1. **Read-only**: the client does NOT expose any Baileys send methods.
2. **Allowlist filtering**: messages filtered at library level before reaching callers. `run` refuses to start with an empty allowlist.
3. **Local config**: allowlist and `notify.command` stored in a user-owned file, not passed as parameters.
4. `notify.command` runs with full shell access as the service user; docs call this out.

## CLI Commands

```bash
whatsapp-monitor run                 # Persistent listener (primary). Requires allowlist.
whatsapp-monitor run -v              # Verbose
whatsapp-monitor run --no-notify     # Skip notify.command; still write JSONL log
whatsapp-monitor notify test         # Fire one synthetic payload through notify.command
whatsapp-monitor link                # QR code linking (default, interactive)
whatsapp-monitor link --code --phone 12345678901
whatsapp-monitor link --name "My Bot"
whatsapp-monitor link --reset
whatsapp-monitor groups              # List groups with IDs
whatsapp-monitor groups --json
whatsapp-monitor config list|add <id>|remove <id>
whatsapp-monitor reset [-y]          # Reset auth (requires re-linking)
# Debugging / inspection:
whatsapp-monitor messages [-f|-a|--json|--queued-only|--idle N|--timeout N]
whatsapp-monitor events [--idle N|--timeout N]
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
  "authDir": "~/.whatsapp-monitor/auth",
  "notify": {
    "command": "openclaw agent --session-id wa-monitor --message \"$(cat)\"",
    "quietPeriodSec": 120,
    "logFile": "~/.whatsapp-monitor/notifications.jsonl",
    "maxBufferedPerChat": 50
  }
}
```

### `notify.command` contract

- Invoked via `sh -c` for every batched notification.
- JSON payload written to child **stdin** (see `NotificationPayload` in `src/types.ts`).
- Convenience env vars: `WAM_CHAT_ID`, `WAM_CHAT_NAME`, `WAM_IS_GROUP`, `WAM_MESSAGE_COUNT`, `WAM_FIRST_TS`, `WAM_LAST_TS`.
- Each payload is also appended to `logFile` regardless of command outcome (durable record).
- Non-zero exits are logged but don't crash the service. Invocations are serialized per chat.

## Throttling

Per-chat quiet-period flush: buffer inbound messages; flush one batched payload after `quietPeriodSec` of no new messages in that chat. Default 120s. `0` disables batching (one payload per message).

## Service lifecycle

The service is a foreground process. Use `launchd` / `systemd` / `pm2` to keep it running. See README for copy-pasteable snippets. `run` handles SIGINT/SIGTERM with a flush.

## Queued Messages Behavior (one-shot `messages` command)

`messages` (the legacy debug command) fetches whatever WhatsApp syncs on connect (`messages.upsert` with `type: "append"`). WhatsApp does **not** guarantee all offline messages will sync, so don't rely on it for capture. Use `run` under a process manager.

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
