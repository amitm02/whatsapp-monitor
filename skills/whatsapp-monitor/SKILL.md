---
name: whatsapp-monitor
description: Set up and operate the whatsapp-monitor service — read-only monitoring of the user's personal WhatsApp, feeding notifications into an OpenClaw agent (or any external consumer). Use when asked to monitor WhatsApp chats, forward WhatsApp messages to an agent, set up WhatsApp notifications, or run the whatsapp-monitor service.
allowed-tools: Bash(whatsapp-monitor *), Bash(openclaw agent *), Bash(cat *), Bash(echo *), Bash(mkdir *), Bash(test *), Bash(which *)
---

# whatsapp-monitor Skill

> **Requires whatsapp-monitor >= 1.3.0** (npm package `whatsapp-monitor`). If the installed version is older, Step 0 will tell you how to upgrade. Features below (structured `notify.kind`, `notify.timeoutSec`, clean shutdown, explicit `notify test` output) are all 1.3.0+.

Read-only monitoring of the user's WhatsApp. Incoming messages from allowlisted chats are batched and handed to a configured notifier — either a structured `notify.kind: "openclaw-agent"` (first-class OpenClaw integration, no shell quoting) or a user-defined `notify.command` (arbitrary shell). This skill has everything needed to onboard a user and operate the service; you should not need to read other files.

> **For OpenClaw agents**: this is **not** the same as `@openclaw/whatsapp`.
>
> - `@openclaw/whatsapp` is a bidirectional **channel** — how the user talks to an agent over WhatsApp, usually from a dedicated bot number.
> - This skill is a one-way **monitor** — it observes the user's personal WhatsApp read-only. The CLI has no send capability; the agent cannot reply from that account.
> - The two can coexist. A common setup: dedicated bot number for `@openclaw/whatsapp`, personal number monitored by this tool.

---

## Full onboarding flow

If the user asks you to set up WhatsApp monitoring, walk through **all seven steps (0 through 6)** in order. Don't skip ahead — each step depends on the previous. Ask explicit questions; don't guess the user's intent.

### Step 0 — Install the CLI

Before anything else, confirm `whatsapp-monitor` is on the user's `PATH`. Every subsequent step calls it.

```bash
which whatsapp-monitor && whatsapp-monitor --version
```

- If both succeed and the version is `1.3.0` or newer → skip to Step 1.
- If `which` fails (command not found) → install it (see below).
- If the version is older than `1.3.0` → **upgrade, don't proceed**. Earlier versions are missing the structured `notify.kind`, `notify.timeoutSec`, and the step-by-step `notify test` output this skill depends on. Run:

  ```bash
  npm install -g whatsapp-monitor@latest
  whatsapp-monitor --version   # confirm >= 1.3.0
  ```

**Install command (canonical):**

```bash
npm install -g whatsapp-monitor
```

Notes for the agent:

- On macOS with Homebrew Node or any user-managed Node (nvm, fnm, volta), this works without `sudo`.
- On macOS/Linux with system Node, the global install directory may be root-owned; the user will see `EACCES`. **Do not run `sudo npm install -g ...` for them** — tell the user to either (a) switch to a user-managed Node (`brew install node` or install nvm), or (b) run `sudo npm install -g whatsapp-monitor` themselves in their terminal. Don't silently install it as root; it creates PATH and ownership pain later.
- Prerequisite: Node.js >= 18. If `node --version` shows < 18, stop and tell the user to upgrade Node first.

Verify the install:

```bash
whatsapp-monitor --version   # must print 1.3.0 or newer
whatsapp-monitor --help      # confirms the `run` and `notify` commands are present
```

If either fails, do not proceed to Step 1. Debug the install first.

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

### Step 5 — Configure the `notify` block and verify

#### Pick a notify mode

`whatsapp-monitor` has **two mutually-exclusive notify modes**. You pick one by setting exactly one of `notify.kind` or `notify.command` in `~/.whatsapp-monitor/config.json`. Setting both is a config error.

| Mode | Selected by | What the daemon does with each batched payload | Use for |
|---|---|---|---|
| **Structured** | `notify.kind: "openclaw-agent"` | Calls `spawn("openclaw", ["agent", "--agent", …, "--session-id", …, "--message", brief + "\n\n---\n\n" + payloadJson])` directly. No shell. No quoting. `behaviorFile` is read fresh each call. | The OpenClaw setup this skill is built around. Also the only mode that gives you `timeoutSec` without writing shell yourself. |
| **Command** | `notify.command: "<shell string>"` | Runs `sh -c "<your command>"`, writes the JSON payload to the child's stdin, exposes a few `WAM_*` env vars. Whatever the command does with the payload is your business. | Webhooks, logs, custom scripts, or OpenClaw with flags the structured mode doesn't expose (e.g. `--deliver`). |

**Today `kind` has exactly one legal value: `"openclaw-agent"`.** Any other value is rejected at config load. The field exists so new structured integrations (e.g. `"kind": "webhook"` in some future version) can be added without breaking anyone's config. If you're not setting up OpenClaw, use `notify.command`.

#### Write the config (structured mode)

Use this mode for the OpenClaw flow the skill is built around. Edit `~/.whatsapp-monitor/config.json` — read it first and merge; don't clobber `allowedGroups` or `authDir`:

```bash
cat ~/.whatsapp-monitor/config.json
```

```json
{
  "allowedGroups": ["1234567890@g.us"],
  "allowedContacts": [],
  "authDir": "/Users/you/.whatsapp-monitor/auth",
  "notify": {
    "kind": "openclaw-agent",
    "agent": "<AGENT_ID>",
    "sessionIdTemplate": "wa-monitor-{date}",
    "behaviorFile": "~/.whatsapp-monitor/behavior.md",
    "quietPeriodSec": 30,
    "timeoutSec": 120
  }
}
```

Field-by-field:

- **`kind`** — required for structured mode. Must be `"openclaw-agent"`.
- **`agent`** — required when `kind` is set. The OpenClaw agent id (what you'd pass to `openclaw agent --agent <id>`). Ask the user; match Step 4.
- **`sessionIdTemplate`** — the `--session-id` value, with substitutions applied at dispatch time. Default `"wa-monitor-{date}"`. Supported tokens:
  - `{date}` → local `YYYY-MM-DD` (daily rolling)
  - `{week}` → local `YYYY-Www` (weekly rolling, ISO week)
  - `{chatId}` → literal chat id, e.g. `1234567890@g.us`
  - `{chatIdSlug}` → chat id with non-alphanumerics replaced by `_`, e.g. `1234567890_g_us`. Use this when you want one session per chat; don't use `{chatId}` directly — the `@` confuses some tools.
  - A fixed string with no tokens (e.g. `"wa-monitor"`) = one permanent session. Fine for low-volume setups.
- **`behaviorFile`** — path to a markdown file (defaults to `~/.whatsapp-monitor/behavior.md`). The daemon reads it on every dispatch and prepends its contents + a `---` separator to the JSON payload before handing it to `openclaw agent --message`. Edits take effect on the very next batch; there's no priming state or cache.
- **`quietPeriodSec`** — per-chat batching window (covered in Step 6). Default 30. `0` disables batching.
- **`timeoutSec`** — hard cap on how long `openclaw agent` can run per call. Default 120. After the timeout: SIGTERM, 2s grace, SIGKILL. `0` disables the timeout (not recommended).

#### Write the config (command mode — alternative)

If the user wants something that isn't structured OpenClaw — a webhook, a log-only pipeline, a custom script, or OpenClaw invoked with flags like `--deliver` — use `notify.command` instead:

```json
{
  "notify": {
    "command": "tee -a ~/whatsapp-digest.jsonl",
    "quietPeriodSec": 30,
    "timeoutSec": 120
  }
}
```

The daemon will `sh -c` the string for every batch. See the Reference section below for the payload shape, env vars, and more recipes.

Reminder: setting both `kind` and `command` in the same `notify` block is rejected as a config error — pick one.

#### Where does the agent's reply go?

By default, `openclaw agent` **prints its reply to stdout and does not deliver it anywhere**. With `notify.command` as above, the agent's response lands in the `whatsapp-monitor` service log (launchd/systemd stdout) — the user never sees it. That's the behavior you want: silent by default, the agent decides when to alert the user.

**When the agent needs to reach the user, it must initiate that itself** — by calling one of its own configured messaging tools (Slack, Telegram, Discord, whatever). The behavior brief should say "call your Slack tool / Telegram tool to notify me," not "reply to me," so the agent doesn't think printing a reply is enough.

If instead you want **every batch auto-delivered to a channel as an OpenClaw reply** (unusual, but valid for simple "forward everything" setups), structured mode does not expose OpenClaw's `--deliver` / `--reply-channel` flags directly. Drop back to `notify.command` mode:

```json
{
  "notify": {
    "command": "openclaw agent --agent <AGENT_ID> --session-id \"wa-monitor-$(date +%F)\" --deliver --reply-channel telegram --reply-to <your-telegram-chat-id> --message \"$(printf '%s\\n\\n---\\n\\n' \"$(cat ~/.whatsapp-monitor/behavior.md)\")$(cat)\"",
    "quietPeriodSec": 30,
    "timeoutSec": 120
  }
}
```

Relevant OpenClaw flags:

| Flag | Purpose |
|---|---|
| `--deliver` | Turn delivery on. Without this, the reply is stdout-only. |
| `--reply-channel <name>` | Channel to deliver into: `telegram`, `slack`, `discord`, etc. |
| `--reply-to <target>` | Where inside the channel (a chat id, `#channel`, `@user`). Format depends on the channel — check `openclaw agent --help` or the channel's docs. |
| `--reply-account <id>` | Which configured account in that channel (multi-account setups). |

Prefer the structured-mode default (no `--deliver`) for the time-sensitive-vs-digest pattern. The agent's tool-calling gives finer-grained control than `--deliver` can — "alert only if urgent" is the agent's judgment call, not a daemon-level always-on flag.

#### Test the pipeline

```bash
whatsapp-monitor notify test
```

Expected output for a healthy config (1.3.0+):

```
notify test (dry run)
[info] config loaded from /Users/you/.whatsapp-monitor/config.json
[info] notify mode: openclaw-agent
[info] resolved target: openclaw agent --agent main --session-id wa-monitor-2026-04-17
[info] behaviorFile:    /Users/you/.whatsapp-monitor/behavior.md
[step] generating synthetic payload (1 message, N bytes json)
[step] appending to log: /Users/you/.whatsapp-monitor/notifications.jsonl
[step] spawning child and waiting (timeout: 120s)
[ok]   log append
[ok  ] child exited: code=0, elapsed=XXXms, stdin=0 bytes
[info] stdout: <agent's acknowledgement, truncated>
[result] ok
```

Exit code 0 means every step passed. Non-zero means at least one step failed — the `[fail]` line names which one (log append, spawn, non-zero exit, timeout). See Troubleshooting below.

**What `notify test` proves:** monitor-side payload generation, JSONL log append, and child process spawn + exit. It does **not** verify end-to-end alert delivery — whether the agent then called its Telegram tool, whether Telegram delivered the message, etc. For full verification you need a real message through `run` (Step 6).

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

#### First live test — optionally shorten `quietPeriodSec`

The default `quietPeriodSec: 30` is already fairly snappy (30 seconds after each message before the notifier fires). For the first end-to-end verification you may want it even tighter — set to `5` (or `0` to disable batching entirely) while iterating, then raise it back to `30` or higher once you're satisfied:

```json
"notify": {
  "kind": "openclaw-agent",
  "agent": "<AGENT_ID>",
  "quietPeriodSec": 5,
  "timeoutSec": 120
}
```

Reload the service so the new config takes effect:

```bash
# macOS
launchctl unload ~/Library/LaunchAgents/com.whatsapp-monitor.run.plist
launchctl load ~/Library/LaunchAgents/com.whatsapp-monitor.run.plist
# Linux
systemctl --user restart whatsapp-monitor
```

Now send a message from another device to an allowlisted chat. Within ~5 seconds you should see the flush in the service log and (if the behavior brief said to alert) the agent reaching out via its messaging tool.

Once verified, restore the production value:

```json
"quietPeriodSec": 30
```

and reload the service the same way.

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

`~/.whatsapp-monitor/config.json` supports two mutually-exclusive notify modes.

**Structured mode** (preferred for OpenClaw — no shell quoting, cleaner config):

```json
{
  "allowedGroups": ["1234567890@g.us"],
  "allowedContacts": ["1234567890@s.whatsapp.net"],
  "authDir": "/Users/you/.whatsapp-monitor/auth",
  "notify": {
    "kind": "openclaw-agent",
    "agent": "main",
    "sessionIdTemplate": "wa-monitor-{date}",
    "behaviorFile": "~/.whatsapp-monitor/behavior.md",
    "quietPeriodSec": 30,
    "timeoutSec": 120,
    "logFile": "/Users/you/.whatsapp-monitor/notifications.jsonl",
    "maxBufferedPerChat": 50
  }
}
```

**Command mode** (anything that isn't structured — webhooks, logs, scripts, or OpenClaw with non-default flags like `--deliver`):

```json
{
  "notify": {
    "command": "tee -a ~/whatsapp-digest.jsonl",
    "quietPeriodSec": 30,
    "timeoutSec": 120
  }
}
```

Setting both `command` and `kind` is a config error — the loader rejects it with a clear message.

| Field | Default | Description |
|---|---|---|
| `notify.kind` | _(none)_ | Structured mode selector. Only `"openclaw-agent"` is supported today. Exclusive with `notify.command`. |
| `notify.agent` | _(required if kind=openclaw-agent)_ | OpenClaw agent id (the `--agent` value). |
| `notify.sessionIdTemplate` | `"wa-monitor-{date}"` | Template with `{date}` (YYYY-MM-DD), `{week}` (YYYY-Www), `{chatId}`, `{chatIdSlug}` substitutions. |
| `notify.behaviorFile` | `~/.whatsapp-monitor/behavior.md` | File prepended to each dispatch with a `---` separator. Re-read every call. |
| `notify.command` | _(none)_ | Command mode: shell command invoked via `sh -c`. Receives JSON on stdin. Exclusive with `notify.kind`. |
| `notify.quietPeriodSec` | `30` | Per-chat quiet period before flushing a batch. `0` disables batching. |
| `notify.timeoutSec` | `120` | Hard cap on child process runtime. SIGTERM then 2s grace then SIGKILL. `0` disables. |
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

> **Test-noise rule worth including in every brief**: if a batch is obviously a self-sent test — single short message from the user's own contact id, content like "test", "בדיקה", "ping", "check", or similar — drop it. Don't alert, don't add it to the digest. Self-tests aren't signal and clutter end-of-day summaries.

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

## Troubleshooting

### Version mismatch — `whatsapp-monitor` older than 1.3.0

Symptoms: `notify test` prints the old "Dispatching synthetic payload... / Done." output, or `notify.kind` is rejected, or `timeoutSec` is ignored.

Fix:

```bash
npm install -g whatsapp-monitor@latest
whatsapp-monitor --version   # must print 1.3.0 or newer
```

Restart the service after upgrading (launchd `unload`+`load`, or `systemctl --user restart whatsapp-monitor`).

### Linux: `systemctl --user` can't connect to the user bus

Symptoms: `systemctl --user status whatsapp-monitor` prints `Failed to connect to bus: No such file or directory` or similar — typically on freshly-logged-in non-graphical sessions, headless servers, or containers.

The user systemd needs `XDG_RUNTIME_DIR` and, for some tools, `DBUS_SESSION_BUS_ADDRESS`:

```bash
export XDG_RUNTIME_DIR=/run/user/$(id -u)
export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus
```

Add those to `~/.bashrc` (or equivalent) if the shell doesn't set them by default. If `loginctl enable-linger $USER` hasn't been run, the user services will also stop when the user logs out — enable lingering if the service should survive logout.

### `notify test` exits non-zero

The `[fail]` line names the failing step. In order of what it might be:

- **`config load failed: ...`** — `~/.whatsapp-monitor/config.json` has invalid JSON, or `notify.command` and `notify.kind` are both set. Fix the config file and re-test.
- **`no notify.command or notify.kind is configured`** — config has no notify block at all. Add one (see Step 5).
- **`log append failed: ...`** — the JSONL log path is not writable. Check permissions on `notify.logFile` and its parent directory.
- **`child spawn failed: ...`** — the executable isn't found. For structured mode: `openclaw` not on `PATH` for the service user. For command mode: your command name is misspelled. Verify with `which openclaw` (or your command name).
- **`child exited: code=127`** — shell command reports "not found." Same as above but from inside the shell.
- **`child timed out after ...`** — the child ran longer than `notify.timeoutSec`. Either its work is actually slow (raise `timeoutSec`), or it's hung (investigate the child — OpenClaw gateway stuck, Telegram API not responding, etc.).
- **`child exited: code=<nonzero>`** — the command ran but failed. The stderr preview usually explains why.

### launchd/systemd: lingering children on stop (1.3.0+ should have fixed this)

Symptoms: `launchctl unload` or `systemctl stop` takes the full stop-timeout before succeeding, journal shows `SIGKILL after timeout` or `status=143`, and/or orphaned `sh -c openclaw ...` processes persist.

If you're on 1.3.0+ and this still happens, check:

- `notify.timeoutSec` is not `0` (child runtime is unbounded).
- The behavior brief doesn't make the agent start long-running background work that outlives the turn.
- `launchctl list | grep whatsapp` / `pgrep -af whatsapp-monitor` to see what's still around.

1.3.0 sends SIGTERM to in-flight children on shutdown and waits up to 5 seconds before SIGKILL. If you need more headroom, set `TimeoutStopSec=15` (systemd) or accept launchd's default.

### PATH issues inside launchd/systemd

Symptoms: `notify test` works from your shell but fails in the service with `openclaw: command not found` (structured mode) or similar for command mode.

launchd and systemd don't inherit your shell's `PATH`. Make `openclaw` reachable:

- **launchd**: add `<key>PATH</key><string>...</string>` inside `EnvironmentVariables` (see [Process manager recipes](#process-manager-recipes) above). Include the directory `which openclaw` reports.
- **systemd user service**: set `Environment=PATH=...` in the unit file similarly.

Reload the service after editing the plist/unit file.

---

## Uninstall / reset

Clean removal when a user wants to stop using `whatsapp-monitor`:

```bash
# 1. Stop and remove the service.
# macOS:
launchctl unload ~/Library/LaunchAgents/com.whatsapp-monitor.run.plist
rm ~/Library/LaunchAgents/com.whatsapp-monitor.run.plist
# Linux:
systemctl --user disable --now whatsapp-monitor
rm ~/.config/systemd/user/whatsapp-monitor.service
systemctl --user daemon-reload

# 2. Unlink the WhatsApp device (optional but recommended — otherwise it
#    shows up in the user's "Linked Devices" list on their phone forever).
#    Do this from the phone: WhatsApp → Settings → Linked Devices → tap the
#    "WhatsApp Monitor" entry → Log Out.

# 3. Remove the CLI.
npm uninstall -g whatsapp-monitor

# 4. Remove state (optional — this wipes the linked auth, allowlist, logs,
#    and behavior.md; full re-onboarding required after this).
rm -rf ~/.whatsapp-monitor
```

What each step removes:

| Command | Removes |
|---|---|
| `launchctl unload` / `systemctl disable` | The service definition. The running process stops. |
| Phone-side "Log Out" | The linked-device entry on WhatsApp's side. |
| `npm uninstall -g` | The `whatsapp-monitor` binary. |
| `rm -rf ~/.whatsapp-monitor` | All state: Baileys auth (credentials), allowlist, behavior brief, notify log. |

Step 4 is intentionally separate — users who plan to reinstall later should skip it so the allowlist, behavior brief, and linked-device state survive. Removing `~/.whatsapp-monitor` requires a full re-onboarding including `link`.

---

## Trust and safety boundary

- The linked WhatsApp account is the user's **personal** number.
- The CLI has **no send capability**. No code path in this tool can post a message to WhatsApp. If the agent wants to reply to someone, it must do so through a different channel (e.g. `@openclaw/whatsapp` on a separate bot number, email, SMS).
- `notify.command` runs as the user owning the service process, with full shell access. The config file is user-owned; treat changes to it like changes to any other user script.
- The JSONL log (`notifications.jsonl`) contains full message text. Treat it as sensitive.

## Prerequisites

- Node.js >= 18 (`node --version`).
- `whatsapp-monitor` >= 1.3.0 on `PATH` (see Step 0).
- For OpenClaw integration: `openclaw` CLI installed and reachable on `PATH` for the service user — including inside launchd/systemd (see process-manager notes above).
- At least one chat in the allowlist (Step 2) before `run` will start.
