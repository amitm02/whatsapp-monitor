---
name: whatsapp-monitor
description: Set up and operate the whatsapp-monitor service — read-only monitoring of the user's personal WhatsApp, feeding notifications into an OpenClaw agent (or any external consumer). Use when asked to monitor WhatsApp chats, forward WhatsApp messages to an agent, set up WhatsApp notifications, or run the whatsapp-monitor service.
allowed-tools: Bash(whatsapp-monitor *), Bash(openclaw agent *), Bash(cat *), Bash(echo *), Bash(mkdir *), Bash(test *), Bash(which *)
---

# whatsapp-monitor Skill

Read-only monitoring of the user's WhatsApp. Incoming messages from allowlisted chats are batched and piped into a shell command (`notify.command`) — typically `openclaw agent ...` for OpenClaw users. This skill has everything needed to onboard a user and operate the service; you should not need to read other files.

> **For OpenClaw agents**: this is **not** the same as `@openclaw/whatsapp`.
>
> - `@openclaw/whatsapp` is a bidirectional **channel** — how the user talks to an agent over WhatsApp, usually from a dedicated bot number.
> - This skill is a one-way **monitor** — it observes the user's personal WhatsApp read-only. The CLI has no send capability; the agent cannot reply from that account.
> - The two can coexist. A common setup: dedicated bot number for `@openclaw/whatsapp`, personal number monitored by this tool.

---

## Full onboarding flow

If the user asks you to set up WhatsApp monitoring, walk through **all six steps** in order. Don't skip ahead — each step depends on the previous. Ask explicit questions; don't guess the user's intent.

### Step 1 — Link WhatsApp (user must do this themselves in a terminal)

**Critical rule: do NOT try to run `whatsapp-monitor link` yourself unless the user has explicitly told you they're sitting in a real terminal session with you and asked you to run it.** Most chat UIs (including WhatsApp, Slack, Matrix web, mobile apps) mangle the QR code so badly it can't be scanned. Default to instructing the user to run it themselves.

First, check whether the account is already linked:

```bash
whatsapp-monitor groups
```

- If it lists groups → already linked, skip to Step 2.
- If it hangs on a QR or pairing prompt → not linked, continue.

Tell the user exactly this (pick QR or pairing based on their setup):

**QR (most users):**
> "Please open a terminal on the machine where `whatsapp-monitor` is installed and run:
> ```
> whatsapp-monitor link --name "WhatsApp Monitor"
> ```
> Then open WhatsApp on your phone → Settings → Linked Devices → Link a Device → scan the QR code that appears in your terminal. Tell me when it shows 'Connected'."

**Pairing code (headless / remote server):**
> "Please SSH into the server and run:
> ```
> whatsapp-monitor link --code --phone <E.164 without +> --name "WhatsApp Monitor"
> ```
> e.g. `--phone 12025550123`. It will show an 8-character code. Open WhatsApp → Settings → Linked Devices → Link a Device → 'Link with phone number instead' → enter the code. Tell me when it shows 'Connected'."

After the user confirms, verify:

```bash
whatsapp-monitor groups
```

If this lists groups, linking succeeded.

### Step 2 — Pick groups (deliberate, explicit, one by one)

**Critical rule: monitoring is deliberate. Do NOT suggest "monitor all groups" as a convenience.** Every allowlisted chat is a conscious choice the user named. Surfacing unrelated chats spams the agent and defeats the point of the tool.

List the groups and present them to the user:

```bash
whatsapp-monitor groups
```

Show the output to the user as a numbered list (group name + id). Ask:

> "Which of these groups do you want me to monitor? You can name them, give numbers, or say 'none of these for now.' I'll confirm each one before adding it."

For each group the user picks:

```bash
whatsapp-monitor config add <id>
```

If the user also wants to monitor DMs from specific contacts:

> "WhatsApp doesn't expose a contact list, so we find a contact ID by looking at one of their messages. Ask that person to send you any message, then I'll run `whatsapp-monitor messages -a` once, find their ID (it looks like `12025550123@s.whatsapp.net`), and I'll add it for you."

Then `whatsapp-monitor config add <contact-id>`.

Verify when done:

```bash
whatsapp-monitor config list
```

### Step 3 — Define what should happen when a message arrives

Now ask the user how they want the agent to handle incoming messages. Phrase it as an open question with concrete examples:

> "When a new message arrives in one of these chats, what should happen? Here are some patterns people use:
>
> 1. **Time-sensitive vs digest**: if the message looks urgent (a direct question, time-sensitive request, family emergency), ping me immediately in our normal channel. Otherwise, save it for the end-of-day summary.
> 2. **Keyword alert**: only ping me if the message mentions certain words (e.g. my name, 'tomorrow', 'urgent').
> 3. **Always forward**: summarize and forward every batch.
> 4. **Just log silently**: write it to memory so you can reference it later when I ask about it, but don't proactively tell me.
>
> What would you like, or do you have a different idea?"

Capture the user's answer as a short **behavior brief** (a few sentences, their words where possible, concrete about what "urgent" means to them). Write it to `~/.whatsapp-monitor/behavior.md`:

```bash
mkdir -p ~/.whatsapp-monitor
cat > ~/.whatsapp-monitor/behavior.md <<'EOF'
# whatsapp-monitor behavior

<the user's brief, in their own words, with your clarifying edits>
EOF
```

Make the brief specific. "Tell me if urgent" is too vague. Good briefs include: what counts as urgent for this user, which chats are noisier and need a higher bar, what the "non-urgent" destination is (end-of-day summary, a memory note, nothing at all), and what format the user wants urgent alerts in.

Confirm the brief with the user before continuing: read it back to them and ask "does this match what you want?"

### Step 4 — Pick the OpenClaw agent

Ask the user which agent should handle these notifications:

> "Which OpenClaw agent should handle WhatsApp notifications? If you have a 'main' agent with memory about your family/work context, that's usually the right choice — we'll use a dedicated daily session so it doesn't clutter your normal chat with it. If you're not sure, run `openclaw agent --help` and check which agents are configured."

Let `<AGENT_ID>` be the user's answer. We'll use it in the next step.

### Step 5 — Configure `notify.command` and verify

The `notify.command` does three things in one shell expression:

- **Rolls the session daily** by suffixing the session id with `$(date +%F)` — each calendar day gets a fresh session (`wa-monitor-YYYY-MM-DD`), capping context cost and noise.
- **Prefixes the behavior brief** onto every message. Yes, this re-sends the brief on every notification — but `quietPeriodSec` keeps the frequency low (typically a few calls per hour per chat), the brief is short (a paragraph or two), and the approach is stateless: no priming to track, no markers to clean up, changes to `behavior.md` take effect on the very next notification.
- **Appends the batched JSON payload** after the brief.

Edit `~/.whatsapp-monitor/config.json` to add the `notify` block. Read the existing config first and merge — don't clobber `allowedGroups` or `authDir`:

```bash
cat ~/.whatsapp-monitor/config.json
```

Write a merged config like this (substitute the real `<AGENT_ID>`):

```json
{
  "allowedGroups": ["1234567890@g.us"],
  "allowedContacts": [],
  "authDir": "/Users/you/.whatsapp-monitor/auth",
  "notify": {
    "command": "openclaw agent --agent <AGENT_ID> --session-id \"wa-monitor-$(date +%F)\" --message \"$(printf '%s\\n\\n---\\n\\n' \"$(cat ~/.whatsapp-monitor/behavior.md)\")$(cat)\"",
    "quietPeriodSec": 120
  }
}
```

What that `--message` argument does: reads `~/.whatsapp-monitor/behavior.md`, appends a `---` separator, then appends the JSON payload from stdin. The agent sees the rules and the payload together, every time.

If the inline shell is too cramped to edit comfortably, a two-line variant is equivalent and easier to read:

```json
"command": "PAYLOAD=\"$(cat)\"; openclaw agent --agent <AGENT_ID> --session-id \"wa-monitor-$(date +%F)\" --message \"$(cat ~/.whatsapp-monitor/behavior.md)\n\n---\n\n$PAYLOAD\""
```

#### Where does the agent's reply go?

By default, `openclaw agent` **prints its reply to stdout and does not deliver it anywhere**. With `notify.command` as above, the agent's response lands in the `whatsapp-monitor` service log (launchd/systemd stdout) — the user never sees it. That's the behavior you want: silent by default, the agent decides when to alert the user.

**When the agent needs to reach the user, it must initiate that itself** — by calling one of its own configured messaging tools (Slack, Telegram, Discord, whatever). The behavior brief should say "call your Slack tool / Telegram tool to notify me," not "reply to me," so the agent doesn't think printing a reply is enough.

If instead you want **every batch auto-delivered to a channel as an OpenClaw reply** (unusual, but valid for simple "forward everything" setups), add `--deliver` plus delivery flags to the command:

| Flag | Purpose |
|---|---|
| `--deliver` | Turn delivery on. Without this, the reply is stdout-only. |
| `--reply-channel <name>` | Channel to deliver into: `telegram`, `slack`, `discord`, etc. |
| `--reply-to <target>` | Where inside the channel (a chat id, `#channel`, `@user`). Format depends on the channel — check `openclaw agent --help` or the channel's docs. |
| `--reply-account <id>` | Which configured account in that channel (multi-account setups). |

Example always-deliver variant:

```json
"command": "openclaw agent --agent <AGENT_ID> --session-id \"wa-monitor-$(date +%F)\" --deliver --reply-channel telegram --reply-to <your-telegram-chat-id> --message \"$(printf '%s\\n\\n---\\n\\n' \"$(cat ~/.whatsapp-monitor/behavior.md)\")$(cat)\""
```

Prefer the default (no `--deliver`) for the time-sensitive-vs-digest pattern. The agent's tool-calling gives finer-grained control than `--deliver` can — "alert only if urgent" is the agent's judgment call, not a daemon-level always-on flag.

#### Test the pipeline

```bash
whatsapp-monitor notify test
```

This fires a synthetic payload through `notify.command`. Check today's session on the agent's side — the agent should have received the brief + payload and responded according to the behavior brief (for a synthetic test, the expected response is usually "non-urgent / logged"). If the agent reacted sensibly, the wiring is correct.

### Step 6 — Run the service under a process manager

`whatsapp-monitor run` is a foreground process. If the user runs it in a shell, it dies when the shell closes. **Always** walk them through a process manager.

**Critical rule: do NOT run `whatsapp-monitor run` as a one-off Bash command for the user.** It will block your tool call indefinitely.

Pick the right one:

- macOS → launchd (see below).
- Linux → systemd (see below).
- "Just testing briefly" → tell the user to run `whatsapp-monitor run -v` in their own terminal.

Confirm with the user which platform they're on, then give them the appropriate recipe (see the [Process manager recipes](#process-manager-recipes) section).

After the service is running, confirm:

```bash
# macOS
launchctl list | grep whatsapp-monitor
# Linux
systemctl --user status whatsapp-monitor
```

Send a test message from another device to an allowlisted chat, wait up to `quietPeriodSec` (default 120s), and confirm the agent session received it.

Onboarding is complete.

---

## Reference

### `run` (primary command)

```bash
whatsapp-monitor run [-v] [--no-notify]
```

| Option | Description |
|---|---|
| `-v, --verbose` | Log each message as it arrives |
| `--no-notify` | Skip `notify.command`; still write to the JSONL log |

Refuses to start if the allowlist is empty. Handles SIGINT/SIGTERM with a clean flush.

### `notify test`

```bash
whatsapp-monitor notify test
```

Fires one synthetic payload through `notify.command`. Use to verify wiring.

### Other commands

| Command | Purpose |
|---|---|
| `whatsapp-monitor link [--qr\|--code --phone <num>] [--name <str>] [--reset]` | Link WhatsApp account |
| `whatsapp-monitor groups [--json]` | List groups with their IDs |
| `whatsapp-monitor config list` | Show current allowlist and notify config |
| `whatsapp-monitor config add <id>` | Add group (`<num>@g.us`) or contact (`<num>@s.whatsapp.net`) |
| `whatsapp-monitor config remove <id>` | Remove from allowlist |
| `whatsapp-monitor reset [-y]` | Reset auth state (requires re-linking) |
| `whatsapp-monitor messages [-a] [-f] [--json]` | **Debugging only** — one-shot fetch of queued messages |
| `whatsapp-monitor events` | **Debugging only** — stream raw Baileys events |

**Do not use `messages` or `events` for ongoing monitoring.** WhatsApp drops messages during reconnects, so one-shot polling misses messages. Always use `run` under a process manager.

### Config file reference

Full shape of `~/.whatsapp-monitor/config.json`:

```json
{
  "allowedGroups": ["1234567890@g.us"],
  "allowedContacts": ["1234567890@s.whatsapp.net"],
  "authDir": "/Users/you/.whatsapp-monitor/auth",
  "notify": {
    "command": "openclaw agent --agent main --session-id \"wa-monitor-$(date +%F)\" --message \"$(printf '%s\\n\\n---\\n\\n' \"$(cat ~/.whatsapp-monitor/behavior.md)\")$(cat)\"",
    "quietPeriodSec": 120,
    "logFile": "/Users/you/.whatsapp-monitor/notifications.jsonl",
    "maxBufferedPerChat": 50
  }
}
```

`notify.command` is any shell command that reads the JSON payload from stdin. The default shown above is the OpenClaw recipe from Step 5 (daily-rolling session, behavior brief prepended). For non-OpenClaw setups, substitute whatever you want — a webhook, a log, a script.

| Field | Default | Description |
|---|---|---|
| `notify.command` | _(none)_ | Shell command invoked via `sh -c`. Receives JSON on stdin. |
| `notify.quietPeriodSec` | `120` | Per-chat quiet period before flushing a batch. `0` disables batching. |
| `notify.logFile` | `~/.whatsapp-monitor/notifications.jsonl` | Where each payload is appended regardless of command outcome. |
| `notify.maxBufferedPerChat` | `50` | Safety cap; forces a flush if reached. |

### Notification payload shape

`notify.command` receives this JSON on stdin:

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
    {
      "id": "...",
      "chatId": "1234567890@g.us",
      "chatName": "Family Group",
      "sender": "1234567890@s.whatsapp.net",
      "senderName": "Mom",
      "timestamp": 1713300000000,
      "text": "...",
      "type": "text",
      "upsertType": "notify",
      "isGroup": true
    }
    // ...
  ]
}
```

Convenience env vars also set on the child: `WAM_CHAT_ID`, `WAM_CHAT_NAME`, `WAM_IS_GROUP` (`"true"`/`"false"`), `WAM_MESSAGE_COUNT`, `WAM_FIRST_TS`, `WAM_LAST_TS`.

### Session lifetime and rolling cadence

OpenClaw sessions persist indefinitely on disk (`~/.openclaw/agents/<agent>/sessions/<session-id>.jsonl`) — there is no client-side expiry. Every turn includes prior context, so long sessions cost more per turn and carry old noise into new decisions. OpenClaw compacts automatically, but you still pay to re-summarize.

The default recipe uses a **daily-rolling** session id — `wa-monitor-$(date +%F)` expands to `wa-monitor-2025-04-17` and rolls at local midnight. Each day starts fresh; the behavior brief is re-sent with every notification, so there is no priming state to maintain. Continuity across days lives in the agent's long-term memory (whatever the brief tells it to write), not in the session log.

To change cadence, swap `$(date +%F)` for something else in the `notify.command`:

| Cadence | Fragment |
|---|---|
| **Daily (default)** | `wa-monitor-$(date +%F)` |
| **Weekly** | `wa-monitor-$(date +%Y-W%V)` |
| **Never roll** | `wa-monitor` (fixed string) |

There are no markers or priming state to clean up when you change cadence — just edit `notify.command` and the next notification picks up the new id.

### Worked behavior-brief examples

Drop one of these into `~/.whatsapp-monitor/behavior.md` (or adapt to the user's actual preference) in Step 3.

> **Important phrasing note**: the agent's textual reply to `openclaw agent --message ...` goes to the service log, not to the user. When the brief says "notify me" or "alert me," the agent must call one of its own configured messaging tools (Slack, Telegram, etc.) to reach the user — a plain reply is invisible. Phrase alert instructions as **"call your <Slack/Telegram/whatever> tool"** so the agent doesn't assume its reply is enough.

**Example A — time-sensitive vs digest** (the original motivating case):

```markdown
# whatsapp-monitor behavior

For each batch of messages that arrives in this session:

1. Classify the batch as **urgent** or **non-urgent**.

   Urgent means at least one of:
   - A direct question to me that expects a reply within hours.
   - A time-sensitive request (pickup, meeting, change of plans today/tomorrow).
   - A family emergency signal (health, safety, "call me").
   - Explicit urgency words: "urgent", "ASAP", "now", "please help".

   Everything else is non-urgent.

2. If **urgent**: call your Telegram tool (or whichever messaging tool reaches me) to send a short alert right now — one or two sentences summarizing what's going on and from whom. Do NOT rely on your text reply alone; it goes to a log, not to me.

3. If **non-urgent**: silently add a one-line entry to an end-of-day digest (a memory note, not a message). At the end of the day, if I ask for "my WhatsApp digest", recall and summarize what accumulated.

4. Never try to reply back to WhatsApp — you have no send capability on that account.
```

**Example B — keyword alert only:**

```markdown
# whatsapp-monitor behavior

Only act when a message mentions any of: my name "Amit", "tomorrow", "urgent", or "kids". For any such batch, call your Telegram tool to send me a short alert.

For everything else, do nothing — don't log, don't summarize, don't call any tool. Your text reply in this session goes to a log I never read, so silence is fine.
```

**Example C — silent memory only:**

```markdown
# whatsapp-monitor behavior

Do not proactively contact me about WhatsApp batches. For every batch, write a short memory note so you can reference it later when I ask. When I do ask "what was on WhatsApp?" or similar (in our normal chat, not this session), recall and summarize from those notes.
```

### Filtering before the agent sees the payload

For hard cutoffs where you never want to spend an agent turn at all — obvious noise, wrong chat type, keyword-only alerting — guard `notify.command` with a shell conditional. The convenience env vars (`WAM_IS_GROUP`, `WAM_CHAT_ID`, etc.) make this cheap:

```json
// Only forward group messages, drop DMs entirely
"command": "[ \"$WAM_IS_GROUP\" = \"true\" ] && openclaw agent --agent main --session-id \"wa-monitor-$(date +%F)\" --message \"$(printf '%s\\n\\n---\\n\\n' \"$(cat ~/.whatsapp-monitor/behavior.md)\")$(cat)\" || cat >/dev/null"
```

```json
// Only forward if any message contains 'urgent' (case-insensitive)
"command": "PAYLOAD=\"$(cat)\"; echo \"$PAYLOAD\" | jq -e '.messages[].text | select(.) | test(\"urgent\"; \"i\")' >/dev/null && openclaw agent --agent main --session-id \"wa-monitor-$(date +%F)\" --message \"$(cat ~/.whatsapp-monitor/behavior.md)\n\n---\n\n$PAYLOAD\" || true"
```

If the one-liners get uncomfortable, split the logic into a tiny script at `~/.whatsapp-monitor/dispatch.sh` and point `notify.command` at it. That's a user choice, not a skill requirement.

Prefer keeping decision logic in the **behavior brief** rather than shell filters — the agent can reconsider edge cases, and evolving the brief doesn't require touching config. Use shell filtering only for hard cutoffs that are cheap to express and save real cost.

---

## Process manager recipes

### macOS (launchd)

Check the install path:

```bash
which whatsapp-monitor
```

Write `~/Library/LaunchAgents/com.whatsapp-monitor.run.plist` with that path substituted for `/usr/local/bin/whatsapp-monitor`:

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
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
```

**Important**: if `notify.command` calls `openclaw`, add the directory containing `openclaw` to `PATH` in `EnvironmentVariables` (launchd does not inherit the user's shell PATH). Run `which openclaw` and include its directory.

Then:

```bash
launchctl load ~/Library/LaunchAgents/com.whatsapp-monitor.run.plist
launchctl start com.whatsapp-monitor.run
launchctl list | grep whatsapp-monitor   # verify
```

Logs: `tail -f /tmp/whatsapp-monitor.err.log`.

To stop / reload after config changes:

```bash
launchctl unload ~/Library/LaunchAgents/com.whatsapp-monitor.run.plist
launchctl load ~/Library/LaunchAgents/com.whatsapp-monitor.run.plist
```

### Linux (systemd user service)

Write `~/.config/systemd/user/whatsapp-monitor.service`:

```ini
[Unit]
Description=WhatsApp Monitor
After=network-online.target

[Service]
ExecStart=/usr/local/bin/whatsapp-monitor run
Restart=on-failure
RestartSec=5
Environment=PATH=/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
```

Adjust `ExecStart` to match `which whatsapp-monitor`, and extend `Environment=PATH` to include `which openclaw`'s directory if needed. Then:

```bash
systemctl --user daemon-reload
systemctl --user enable --now whatsapp-monitor
systemctl --user status whatsapp-monitor   # verify
journalctl --user -u whatsapp-monitor -f   # logs
```

---

## Trust and safety boundary

- The linked WhatsApp account is the user's **personal** number.
- The CLI has **no send capability**. No code path in this tool can post a message to WhatsApp. If the agent wants to reply to someone, it must do so through a different channel (e.g. `@openclaw/whatsapp` on a separate bot number, email, SMS).
- `notify.command` runs as the user owning the service process, with full shell access. The config file is user-owned; treat changes to it like changes to any other user script.
- The JSONL log (`notifications.jsonl`) contains full message text. Treat it as sensitive.

## Prerequisites

- Node.js >= 18 and `whatsapp-monitor` installed (`npm install -g whatsapp-monitor`).
- For OpenClaw integration: `openclaw` CLI installed and reachable on `PATH` for the service user — including inside launchd/systemd (see process-manager notes above).
- At least one chat in the allowlist (Step 2) before `run` will start.
