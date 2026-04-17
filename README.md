# whatsapp-monitor

A **read-only** WhatsApp monitoring service using Baileys. Runs as a persistent listener, filters by an allowlist, and hands batched notifications to a command of your choice — a webhook, an OpenClaw agent, a log, anything that reads JSON from stdin.

> This is **monitoring**, not a chat channel. It surfaces messages from an external WhatsApp account *into* another tool. It cannot send messages.
>
> **Note for OpenClaw agents**: `@openclaw/whatsapp` is a bidirectional channel — it's how an OpenClaw agent talks to users over WhatsApp. This tool is different: it observes messages on a *separate* (typically personal) WhatsApp account read-only, so an agent can react to them without being able to send from that account. The two can coexist.

## Why a persistent service

Baileys is built around a live WebSocket session, not a pull API:

- `messaging-history.set` / `fetchMessageHistory` are for initial/offline recovery, not reliable cron-style ingestion.
- WhatsApp drops messages during reconnects, has limited server-side retention, and logs out linked devices after ~14 days of phone inactivity.
- Baileys v7 explicitly says production apps must keep a persistent client.

So this tool is designed to run as a **long-lived process** under `launchd` / `systemd` / `pm2`. The one-shot `messages` and `events` commands are still there for debugging.

## Install

```bash
npm install -g whatsapp-monitor
```

From source:

```bash
git clone https://github.com/amitm02/whatsapp-monitor
cd whatsapp-monitor
npm install
npm run build
npm link
```

Requires Node.js >= 18.

## Quick start

1. **Link WhatsApp** (one-time, interactive):

   ```bash
   whatsapp-monitor link
   ```

   Scan the QR with WhatsApp → Settings → Linked Devices → Link a Device. For headless/agent setups use the pairing code flow: `whatsapp-monitor link --code --phone 12345678901`.

2. **Pick what to monitor**:

   ```bash
   whatsapp-monitor groups
   whatsapp-monitor config add 1234567890@g.us
   ```

3. **Configure a notify command** in `~/.whatsapp-monitor/config.json`:

   ```json
   {
     "allowedGroups": ["1234567890@g.us"],
     "allowedContacts": [],
     "notify": {
       "command": "tee -a ~/whatsapp-digest.jsonl",
       "quietPeriodSec": 120
     }
   }
   ```

4. **Verify the pipeline** before connecting WhatsApp:

   ```bash
   whatsapp-monitor notify test
   ```

5. **Run the service**:

   ```bash
   whatsapp-monitor run
   ```

   Leave it running. See [running as a service](#running-as-a-service) for launchd/systemd.

## How notifications work

`run` keeps a persistent WhatsApp connection, filters messages through the allowlist, and buffers them per chat. When a chat has been quiet for `notify.quietPeriodSec` seconds, one batched notification is emitted for that chat.

Each notification:

1. Is appended to `~/.whatsapp-monitor/notifications.jsonl` (durable record).
2. Runs `notify.command` via `sh -c`, with the JSON payload written to the child's **stdin**.
3. Exposes a few convenience env vars: `WAM_CHAT_ID`, `WAM_CHAT_NAME`, `WAM_IS_GROUP`, `WAM_MESSAGE_COUNT`, `WAM_FIRST_TS`, `WAM_LAST_TS`.

Non-zero exits are logged to stderr but don't crash the service. Invocations for the same chat are serialized (no overlap).

### Payload shape

```jsonc
{
  "chatId": "1234567890@g.us",
  "chatName": "Family Group",
  "isGroup": true,
  "firstTimestamp": 1713300000000,
  "lastTimestamp": 1713300180000,
  "messageCount": 3,
  "senderCount": 2,
  "messages": [
    { "id": "...", "sender": "...", "senderName": "Mom", "text": "...", "timestamp": 1713300000000, "type": "text", "upsertType": "notify", "chatId": "1234567890@g.us", "isGroup": true },
    // ...
  ]
}
```

When `quietPeriodSec: 0`, the same shape is emitted with `messageCount: 1` per message — consumers don't need to branch on two shapes.

### `notify` config reference

| Field | Default | Description |
|---|---|---|
| `command` | _(none)_ | Shell command invoked via `sh -c`. Receives JSON on stdin. |
| `quietPeriodSec` | `120` | Per-chat quiet period before flushing a batch. `0` disables batching. |
| `logFile` | `~/.whatsapp-monitor/notifications.jsonl` | Where each payload is appended, regardless of `command` outcome. |
| `maxBufferedPerChat` | `50` | Safety cap on buffered messages per chat before forced flush. |

### Recipes

```sh
# Plain log
"command": "tee -a ~/whatsapp-digest.jsonl"

# Slack webhook
"command": "jq -r '\"\\(.chatName): \\(.messageCount) new messages\"' | curl -s -X POST -H 'Content-Type: application/json' --data-binary @- \"$SLACK_WEBHOOK_URL\""

# OpenClaw agent turn — daily-rolling session, behavior brief prefixed
# (see skills/whatsapp-monitor/SKILL.md for the full onboarding flow)
"command": "openclaw agent --agent main --session-id \"wa-monitor-$(date +%F)\" --message \"$(printf '%s\\n\\n---\\n\\n' \"$(cat ~/.whatsapp-monitor/behavior.md)\")$(cat)\""

# Only ping on group messages
"command": "[ \"$WAM_IS_GROUP\" = \"true\" ] && openclaw agent --agent main --session-id \"wa-monitor-$(date +%F)\" --message \"$(cat)\" || cat >/dev/null"
```

> **Security**: `notify.command` runs as the user owning the service process, with full shell access. The config file is user-owned — treat it accordingly.

## Running as a service

### macOS (launchd)

Write `~/Library/LaunchAgents/com.whatsapp-monitor.run.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.whatsapp-monitor.run</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/whatsapp-monitor</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/whatsapp-monitor.out.log</string>
  <key>StandardErrorPath</key><string>/tmp/whatsapp-monitor.err.log</string>
</dict>
</plist>
```

Then:

```bash
launchctl load ~/Library/LaunchAgents/com.whatsapp-monitor.run.plist
launchctl start com.whatsapp-monitor.run
```

Adjust `/usr/local/bin/whatsapp-monitor` to match `which whatsapp-monitor`.

### Linux (systemd user service)

`~/.config/systemd/user/whatsapp-monitor.service`:

```ini
[Unit]
Description=WhatsApp Monitor
After=network-online.target

[Service]
ExecStart=/usr/local/bin/whatsapp-monitor run
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now whatsapp-monitor
```

### pm2

```bash
pm2 start whatsapp-monitor --name wa-monitor -- run
pm2 save
```

## Commands

| Command | Purpose |
|---|---|
| `whatsapp-monitor run` | Persistent listener. The primary mode. |
| `whatsapp-monitor notify test` | Run `notify.command` once with a synthetic payload. |
| `whatsapp-monitor link` | Link WhatsApp account (QR or pairing code). |
| `whatsapp-monitor groups` | List available groups with their IDs. |
| `whatsapp-monitor config add/remove/list` | Manage the allowlist. |
| `whatsapp-monitor reset` | Reset auth state (requires re-linking). |

### Debugging / inspection commands

These are for ad-hoc debugging. Prefer `run` for ongoing monitoring.

| Command | Purpose |
|---|---|
| `whatsapp-monitor messages` | Connect, fetch queued messages, exit. `-f` keeps running but is no substitute for the service. |
| `whatsapp-monitor events` | Stream raw Baileys events. |

See `whatsapp-monitor <command> --help` for flags.

## Configuration

Stored at `~/.whatsapp-monitor/config.json`:

```json
{
  "allowedGroups": ["1234567890@g.us"],
  "allowedContacts": ["1234567890@s.whatsapp.net"],
  "authDir": "/Users/you/.whatsapp-monitor/auth",
  "notify": {
    "command": "openclaw agent --session-id wa-monitor --message \"$(cat)\"",
    "quietPeriodSec": 120
  }
}
```

### Security

- **Allowlist-based**: only messages from explicitly allowed chats are surfaced.
- **Secure default**: if the allowlist is empty, `run` refuses to start.
- **Read-only**: the client does not expose any methods to send messages.

## Library usage

```typescript
import { WhatsAppMonitor, loadConfig } from 'whatsapp-monitor'

const config = await loadConfig()
const client = new WhatsAppMonitor(config)

client.onMessage((msg) => {
  console.log('New message:', msg.text)
})

await client.connect()
```

### Available methods

- `connect()` / `disconnect()`
- `listGroups()`, `getGroupMetadata(groupId)`
- `onMessage`, `onMessageUpdate`, `onMessageDelete`
- `onConnection`, `onQR`, `onReady`, `onActivity`

## Baileys limits (why the service design matters)

- No guarantee that offline messages will all sync; prioritizes recent.
- Connection-timing drops during reconnect are real.
- Server-side retention is limited.
- 14+ days of phone inactivity logs out linked devices.

A persistent listener closes all of these gaps as much as WhatsApp allows. Run it under a process manager; don't rely on one-shot `messages` for anything important.

## Message shape

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
  quotedMessage?: { id: string; sender: string; text?: string }
}
```

## License

MIT
