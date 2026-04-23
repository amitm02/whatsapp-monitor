---
name: whatsapp-monitor
description: Set up and operate the whatsapp-monitor service — read-only monitoring of the user's personal WhatsApp, feeding notifications into an OpenClaw agent (or any external consumer). Use when asked to monitor WhatsApp chats, forward WhatsApp messages to an agent, set up WhatsApp notifications, or run the whatsapp-monitor service.
allowed-tools: Bash(whatsapp-monitor *), Bash(openclaw agent *), Bash(cat *), Bash(echo *), Bash(mkdir *), Bash(test *), Bash(which *)
---

# whatsapp-monitor Skill

> **Requires the npm package `whatsapp-monitor`, latest version.** Step 0 confirms it's installed and up to date. The skill assumes features that have been added in recent releases (structured `notify.kind`, `notify.timeoutSec`, clean shutdown, explicit `notify test` output) — install or upgrade first if anything is missing.

Read-only monitoring of the user's WhatsApp. Incoming messages from allowlisted chats are batched and handed to a configured notifier — either a structured `notify.kind: "openclaw-agent"` (first-class OpenClaw integration, no shell quoting) or a user-defined `notify.command` (arbitrary shell). This skill has everything needed to onboard a user and operate the service; you should not need to read other files.

> **For OpenClaw agents**: this is **not** the same as `@openclaw/whatsapp`.
>
> - `@openclaw/whatsapp` is a bidirectional **channel** — how the user talks to an agent over WhatsApp, usually from a dedicated bot number.
> - This skill is a one-way **monitor** — it observes the user's personal WhatsApp read-only. The CLI has no send capability; the agent cannot reply from that account.
> - The two can coexist. A common setup: dedicated bot number for `@openclaw/whatsapp`, personal number monitored by this tool.

---

## Full onboarding flow

If the user asks you to set up WhatsApp monitoring, walk through **all six steps (0 through 5)** in order. Don't skip ahead — each step depends on the previous. Ask explicit questions; don't guess the user's intent.

### Step 0 — Install or upgrade the CLI

Check what's installed locally vs. what's on npm:

```bash
which whatsapp-monitor && whatsapp-monitor --version
npm view whatsapp-monitor version    # latest published on npm
```

Decide what to do:

- **Installed and matches the npm version** → skip to Step 1.
- **`which` fails (command not found)** → install it (see below).
- **Installed but older than npm `latest`** → upgrade. The skill assumes recent features and the simplest rule is "always install the latest." Run:
  ```bash
  npm install -g whatsapp-monitor@latest
  whatsapp-monitor --version    # confirm it now matches `npm view`
  ```

Also verify Node.js itself: run `node --version` and confirm it's >= 18. If it isn't, stop and tell the user to upgrade Node before continuing — this tool won't run on older Node.

**Install command (when the user needs it):**

```bash
npm install -g whatsapp-monitor
```

How to guide the user through the install depends on their Node setup:

- **User-managed Node (Homebrew, nvm, fnm, volta, etc.)**: the command above works without `sudo`. You can suggest the user run it, or run it yourself if you have shell access and the user has explicitly authorized it.
- **System Node (macOS/Linux default)**: the global install directory is usually root-owned and the user will see `EACCES`. Do **not** run `sudo npm install -g ...` yourself. Two options, in order of preference:
  1. Ask the user to switch to a user-managed Node (`brew install node`, or install nvm). This avoids sudo entirely and makes future upgrades painless.
  2. If the user insists, they can run `sudo npm install -g whatsapp-monitor` themselves in their terminal. Flag one footgun before they do: the resulting binary lives under a root-owned path, so if their shell's `PATH` doesn't include that path, `which whatsapp-monitor` will still fail afterwards. If that happens, have them add it to `PATH` or use the full path.

After any install or upgrade, re-verify:

```bash
whatsapp-monitor --version    # should match `npm view whatsapp-monitor version`
whatsapp-monitor --help       # confirms the `run` and `notify` commands are present
```

If either still fails, stop. Don't move to Step 1 until both work — the rest of the skill assumes they do.

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
> 1. **Relevance filter (recommended default)**: for every batch, you decide whether I'd care. If yes, ping me with a short summary right now. If not, drop it silently. Simple, stateless, no scheduled jobs.
> 2. **Time-sensitive vs digest**: ping me immediately if it's urgent; otherwise add it to an end-of-day digest that gets sent on a schedule.
> 3. **Keyword alert**: only ping me if the message mentions certain words (e.g. my name, 'tomorrow', 'urgent').
> 4. **Always forward**: summarize and forward every batch.
> 5. **Just log silently**: write it to memory so you can reference it later when I ask about it, but don't proactively tell me.
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

**If the brief involves a digest or summary:** active delivery beats passive recall. Don't write briefs that wait for the user to ask "what was on WhatsApp today?" — that depends on the user remembering, which defeats the point of accumulating one. Either:

- have the brief instruct the agent to call its messaging tool on a fixed schedule (works only if your runtime triggers an agent turn at that time — most don't on their own), or
- after writing the brief, propose a scheduled job (e.g. cron, launchd, the user's existing scheduler) that fires `openclaw agent --agent <id> --message "Send me today's WhatsApp digest now via <tool>"` at the user's preferred time. Confirm with the user whether one is already set up before suggesting a new one.

**Record where the source of truth lives — important.** Once the brief is written, add a short entry to your own persistent memory index (e.g. `MEMORY.md` for Claude Code, or whatever your runtime uses) that says roughly:

> WhatsApp monitoring is set up via the `whatsapp-monitor` service. The behavior brief — the rules for what to do with incoming WhatsApp batches — lives at `~/.whatsapp-monitor/behavior.md`. When the user gives feedback like "stop alerting me about the X group", "also alert on Y", "be quieter on weekends", etc., **edit that file** (not just the conversation), then reload the service (`launchctl unload+load` on macOS, `systemctl --user restart whatsapp-monitor` on Linux) so the next batch picks up the new rules. The session running the dispatched turns is named per the `notify.sessionIdTemplate` in `~/.whatsapp-monitor/config.json`.

Without this memory entry, future-you in a fresh conversation will respond to "stop notifying me about X" by trying to argue or take in-conversation notes, instead of editing the file the daemon actually reads.

### Step 4 — Pick the OpenClaw agent and configure the `notify` block

#### Pick the agent

If the user's setup uses OpenClaw (the common case for this skill), ask:

> "Which OpenClaw agent should handle WhatsApp notifications? If you have a 'main' agent with memory about your family/work context, that's usually the right choice — we'll use a dedicated daily session so it doesn't clutter your normal chat with it. If you're not sure, run `openclaw agent --help` and check which agents are configured."

Let `<AGENT_ID>` be the user's answer. You'll plug it into the config below.

If the user is *not* using OpenClaw and plans to wire the notifier into a webhook, a log, or a custom script, skip the agent question — you'll use command mode below.

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
- **`agent`** — required when `kind` is set. The OpenClaw agent id (what you'd pass to `openclaw agent --agent <id>`). Use whatever the user answered in the "Pick the agent" question above.
- **`sessionIdTemplate`** — the `--session-id` value, with substitutions applied at dispatch time. Default `"wa-monitor-{date}"`. Supported tokens:
  - `{date}` → local `YYYY-MM-DD` (daily rolling)
  - `{week}` → local `YYYY-Www` (weekly rolling, ISO week)
  - `{chatId}` → literal chat id, e.g. `1234567890@g.us`
  - `{chatIdSlug}` → chat id with non-alphanumerics replaced by `_`, e.g. `1234567890_g_us`. Use this when you want one session per chat; don't use `{chatId}` directly — the `@` confuses some tools.
  - A fixed string with no tokens (e.g. `"wa-monitor"`) = one permanent session. Fine for low-volume setups.
- **`behaviorFile`** — path to a markdown file (defaults to `~/.whatsapp-monitor/behavior.md`). The daemon reads it on every dispatch and prepends its contents + a `---` separator to the JSON payload before handing it to `openclaw agent --message`. Edits take effect on the very next batch; there's no priming state or cache.
- **`quietPeriodSec`** — per-chat batching window (covered in Step 5). Default 30. `0` disables batching.
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

Expected output for a healthy config on the latest CLI:

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

**What `notify test` proves:** monitor-side payload generation, JSONL log append, and child process spawn + exit. It does **not** verify end-to-end alert delivery — whether the agent then called its Telegram tool, whether Telegram delivered the message, etc. For full verification you need a real message through `run` (Step 5).

### Step 4.5 — Configure operator alerts (recommended)

**What this is:** a separate pipeline from `notify`. `notify` forwards incoming WhatsApp messages to the agent as content. **Alerts** notify the operator (you/your agent) about **problems with the service itself**: the WhatsApp session hitting a stream conflict (440), being logged out, staying disconnected for an extended period, or the `notify.command` failing repeatedly. Without this configured, those problems only show up in logs — you'd never know until you notice messages have stopped arriving.

Ask the user:

> "Do you want to be notified if the monitor itself runs into trouble? The common cases are: another device takes over the WhatsApp Web session, the session gets logged out, the service stays disconnected for more than ~10 minutes, or the agent pipeline keeps failing. **I recommend sending these alerts to the same agent as your notifications** — it already has context about the setup and can message you (via Telegram, Slack, whatever). It uses a separate session so service alerts don't pollute your message-notification session."

If the user agrees, add an `alerts` block to `~/.whatsapp-monitor/config.json`:

```json
{
  "allowedGroups": ["..."],
  "allowedContacts": ["..."],
  "authDir": "...",
  "notify": { ... },
  "alerts": {
    "command": "openclaw agent --agent <AGENT_ID> --session-id wa-monitor-alerts --message \"whatsapp-monitor service alert — this is a health signal for the monitor itself, NOT an incoming WhatsApp message. Please notify the user RIGHT NOW via whatever messaging tool you have that reaches them (Telegram / Slack / etc.). Your text reply in this session only goes to a log and the user will not see it. Kind: $WAM_ALERT_KIND. Details: $WAM_ALERT_MESSAGE\"",
    "throttleSec": 900,
    "timeoutSec": 60
  }
}
```

Substitute `<AGENT_ID>` with whatever the user picked for `notify.agent` in Step 4 — same agent, different session id. All four triggers default to on when `alerts.command` is set.

**Why the long prefix in `--message`.** An agent configured for the main notify session is likely trained to "decide whether the user cares about this batch" and often silently drop noise. A service alert framed like a message batch might get dropped the same way. The preamble tells the agent explicitly that this is a *health* event, not content, and that it must actively call a messaging tool rather than reply. If the user is confident their agent's general memory already covers this (e.g. "in any session containing the string 'service alert' reach me on Telegram immediately"), they can simplify to a shorter `--message`.

**Field reference:**

- **`alerts.command`** — shell command run via `sh -c` for every alert fire. Receives the full alert JSON on stdin; also gets `WAM_ALERT_KIND`, `WAM_ALERT_MESSAGE`, `WAM_ALERT_TIMESTAMP` env vars for shell-conditional use.
- **`alerts.throttleSec`** (default `900` = 15 min) — per-kind throttle. The same kind of alert won't fire twice within this window. Different kinds (e.g. `conflict` then `loggedOut`) are independent.
- **`alerts.timeoutSec`** (default `60`) — max time the child command can run. SIGTERM, 2s grace, SIGKILL.
- **`alerts.logFile`** (default `~/.whatsapp-monitor/alerts.jsonl`) — every fire attempt is appended here, whether or not the child was invoked (throttled alerts are logged but not sent). Durable record for postmortems.
- **`alerts.on`** — per-trigger switches. All default to on when the command is set. To disable one: `"conflict": false`. To change extended-disconnect threshold: `"extendedDisconnect": { "afterSec": 300 }`. To change dispatch-failures threshold: `"dispatchFailures": { "afterConsecutive": 3 }`.

**Briefing the agent further (optional).** The preamble in `--message` above is usually enough. If the user wants belt-and-suspenders, add a short note to the agent's general memory (not the monitor's behavior.md — that one is for message-content decisions): "Any turn in session `wa-monitor-alerts` is a service-health alert. Relay it to me via my Telegram tool immediately." This helps if the preamble ever gets shortened.

Verify the wiring:

```bash
whatsapp-monitor alerts test
```

This fires a synthetic alert through the pipeline (bypassing throttle). A healthy result is `[result] ok` and the user getting a test notification in whatever channel the agent is configured to use.

**Crash detection is separate.** In-process alerts can't detect the service process crashing — by definition there's no one to send from. For that you need an external watchdog. See [External watchdog](#external-watchdog-for-crash-detection) below.

### Step 5 — Run the service under a process manager

`whatsapp-monitor run` is a foreground process. If the user runs it in a shell, it dies when the shell closes. **Always** walk them through a process manager.

**Critical rule: do NOT run `whatsapp-monitor run` as a one-off Bash command for the user.** It will block your tool call indefinitely.

Pick the right one:

- macOS → launchd (see below).
- Linux → systemd (see below).
- "Just testing briefly" → tell the user to run `whatsapp-monitor run -v` in their own terminal.

Confirm with the user which platform they're on, then give them the appropriate recipe (see the [Process manager recipes](#process-manager-recipes) section).

After the service is running, confirm with both the process manager and the app-level readiness check:

```bash
# macOS
launchctl list | grep whatsapp-monitor
# Linux
systemctl --user status whatsapp-monitor

# Then — app-level check (linked? allowlist? notify config? live `run` process? last dispatched notification?):
whatsapp-monitor status
```

`whatsapp-monitor status` is the single command that answers "is this thing actually ready and running?" across all four dimensions (auth, allowlist, notify config, live `run` process) and surfaces the last line of the notification log. Exit code 0 means ready, non-zero means at least one blocker (reported under `Status: ✗ not ready`). Use `--json` for machine-readable output.

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

Final sanity check:

```bash
whatsapp-monitor status
```

Expect `Status: ✓ ready and connected` with a live `pid` under `Processes:` and `State: ✓ connected` under `Live connection:`. If the final line is `Status: ✓ ready and running (connecting)` or `(disconnected)`, wait a few seconds and re-run — those are transient reconnect states. Anything else (`✗ session conflict`, `✗ logged out`, `✗ not ready`) names the blocker; see Troubleshooting.

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
| `--no-notify` | Skip the notifier (both `notify.command` and `notify.kind` are bypassed); still write to the JSONL log |

Refuses to start if the allowlist is empty. Handles SIGINT/SIGTERM with a clean flush.

### `notify test`

```bash
whatsapp-monitor notify test
```

Fires one synthetic payload through the configured notifier (`notify.command` or `notify.kind`). Use to verify wiring.

### Other commands

| Command | Purpose |
|---|---|
| `whatsapp-monitor status [--json]` | One-shot readiness check: linked, allowlist, notify config, alerts config, live `run` process + its live connection state (connected / connecting / disconnected / conflict / logged_out), last dispatched notification, last fired alert. Exits non-zero if not ready or if the live state is `conflict` / `logged_out`. |
| `whatsapp-monitor alerts test` | Fire a synthetic alert through `alerts.command` (throttle bypassed). Verify the operator-alert pipeline. |
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
| `alerts.command` | _(none)_ | Shell command invoked via `sh -c` when a service issue fires. Receives alert JSON on stdin and `WAM_ALERT_KIND` / `WAM_ALERT_MESSAGE` / `WAM_ALERT_TIMESTAMP` env vars. Setting this enables alerts; leaving it unset disables the pipeline entirely. |
| `alerts.throttleSec` | `900` | Per-kind throttle window (seconds). Same-kind alerts within this window append to the log but don't run the shell command. |
| `alerts.timeoutSec` | `60` | Hard cap on child runtime. SIGTERM → 2s grace → SIGKILL. `0` disables. |
| `alerts.logFile` | `~/.whatsapp-monitor/alerts.jsonl` | Every fire attempt (fired or throttled) is appended here. |
| `alerts.on.conflict` | `true` | Fire on WhatsApp stream conflict (status 440). |
| `alerts.on.loggedOut` | `true` | Fire when WhatsApp reports the session is logged out. |
| `alerts.on.extendedDisconnect` | `{ afterSec: 600 }` | Fire when the monitor has been in a non-connected state for this many seconds. Set to `false` to disable. |
| `alerts.on.dispatchFailures` | `{ afterConsecutive: 5 }` | Fire after this many consecutive `notify` dispatch failures (spawn error / non-zero exit / timeout). Resets on the first successful dispatch. Set to `false` to disable. |

### Alert payload shape

```jsonc
{
  "kind": "conflict",           // one of: conflict, loggedOut, extendedDisconnect, dispatchFailures, test
  "message": "WhatsApp Web stream conflict (status 440): another linked device has taken over…",
  "timestamp": 1713300000000,
  "details": {                  // kind-specific fields
    "reconnectAttempts": 3
  }
}
```

Written to the child's stdin as one line of JSON. The env vars `WAM_ALERT_KIND`, `WAM_ALERT_MESSAGE`, `WAM_ALERT_TIMESTAMP` let shell commands use simple conditionals without parsing JSON.

### Notification payload shape

The notifier produces a JSON payload with this shape for every batched dispatch:

- In **command mode** it's written to the child's stdin.
- In **structured mode** it's appended to the behavior brief (after a `---` separator) and passed as the `--message` argument to `openclaw agent`.

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

**Command mode only**: the child also gets these env vars set, handy for shell conditionals: `WAM_CHAT_ID`, `WAM_CHAT_NAME`, `WAM_IS_GROUP` (`"true"`/`"false"`), `WAM_MESSAGE_COUNT`, `WAM_FIRST_TS`, `WAM_LAST_TS`. Structured mode doesn't need them — filtering logic belongs in the behavior brief.

### Session lifetime and rolling cadence

OpenClaw sessions persist indefinitely on disk (`~/.openclaw/agents/<agent>/sessions/<session-id>.jsonl`) — there is no client-side expiry. Every turn includes prior context, so long sessions cost more per turn and carry old noise into new decisions. OpenClaw compacts automatically, but you still pay to re-summarize.

The default configuration uses a **daily-rolling** session id — `sessionIdTemplate: "wa-monitor-{date}"` expands to e.g. `wa-monitor-2026-04-17` and rolls at local midnight. Each day starts fresh; the behavior brief is re-sent with every notification, so there is no priming state to maintain. Continuity across days lives in the agent's long-term memory (whatever the brief tells it to write), not in the session log.

To change cadence in **structured mode**, edit `notify.sessionIdTemplate`:

| Cadence | Template value |
|---|---|
| **Daily (default)** | `"wa-monitor-{date}"` |
| **Weekly** | `"wa-monitor-{week}"` |
| **Per-chat, daily** | `"wa-monitor-{date}-{chatIdSlug}"` |
| **Never roll** | `"wa-monitor"` (fixed string, no tokens) |

To change cadence in **command mode**, edit the `--session-id` fragment in `notify.command`:

| Cadence | Shell fragment |
|---|---|
| **Daily** | `wa-monitor-$(date +%F)` |
| **Weekly** | `wa-monitor-$(date +%Y-W%V)` |
| **Never roll** | `wa-monitor` |

Either way, there are no markers or priming state to clean up when you change cadence — just update the template (or command) and the next notification picks up the new id.

### Worked behavior-brief examples

Drop one of these into `~/.whatsapp-monitor/behavior.md` (or adapt to the user's actual preference) in Step 3.

> **Important phrasing note**: the agent's textual reply to `openclaw agent --message ...` goes to the service log, not to the user. When the brief says "notify me" or "alert me," the agent must call one of its own configured messaging tools (Slack, Telegram, etc.) to reach the user — a plain reply is invisible. Phrase alert instructions as **"call your <Slack/Telegram/whatever> tool"** so the agent doesn't assume its reply is enough.

> **Test-noise rule worth including in every brief**: if a batch is obviously a self-sent test — single short message from the user's own contact id, content like "test", "בדיקה", "ping", "check", or similar — drop it. Don't alert, don't add it to the digest. Self-tests aren't signal and clutter end-of-day summaries.

**Example A — relevance filter (recommended default)**:

```markdown
# whatsapp-monitor behavior

For each batch of messages that arrives in this session:

1. Decide whether I'd actually want to know about this batch right now. Use your judgment about what I care about — what's happening with my family, work obligations, things that might affect my plans, things I'd want to react to or remember. Lean toward sending — I'd rather see a few extra summaries than miss something — but skip pure noise (forwards, memes, "good morning" greetings, group chatter that doesn't involve me, automated notifications).

2. If **relevant**: call your Telegram tool (or whichever messaging tool reaches me) to send a short summary right now. One or two sentences: who the message is from, the chat it's in, and the gist. Do NOT rely on your text reply alone; it goes to a log, not to me.

3. If **not relevant**: do nothing. No reply, no memory note, no log. Silence is fine — your text reply in this session goes to a log I never read.

4. Never try to reply back to WhatsApp — you have no send capability on that account.

This is stateless: no priming, no daily notes, no cron. Each batch stands alone.
```

**Example B — time-sensitive vs end-of-day digest** (the original motivating case; needs a scheduled job for delivery):

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

3. If **non-urgent**: silently append a one-line entry to a memory note named "WhatsApp digest — YYYY-MM-DD" (one note per local day; create it on the first non-urgent batch of the day). Do not message me about it.

4. Never try to reply back to WhatsApp — you have no send capability on that account.

**End-of-day delivery (active):** the digest should reach me on its own each evening, not wait for me to ask. If a scheduled job doesn't already do this for me, suggest one now — for example, a cron entry that runs `openclaw agent --agent <my-agent> --message "Send me today's WhatsApp digest now via my Telegram tool"` at 21:00 local time. Confirm with me whether it's already set up before assuming.
```

**Example C — keyword alert only:**

```markdown
# whatsapp-monitor behavior

Only act when a message mentions any of: my name "Amit", "tomorrow", "urgent", or "kids". For any such batch, call your Telegram tool to send me a short alert.

For everything else, do nothing — don't log, don't summarize, don't call any tool. Your text reply in this session goes to a log I never read, so silence is fine.
```

**Example D — silent memory only:**

```markdown
# whatsapp-monitor behavior

Do not proactively contact me about WhatsApp batches. For every batch, write a short memory note so you can reference it later when I ask. When I do ask "what was on WhatsApp?" or similar (in our normal chat, not this session), recall and summarize from those notes.
```

### Filtering before the agent sees the payload (command mode)

The recipes in this section apply **only to command mode**. Structured mode (`notify.kind: "openclaw-agent"`) has no shell hook between the daemon and `openclaw agent` — if you need shell-level filtering, switch to command mode, or do the filtering in the behavior brief so the agent decides.

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

### External watchdog (for crash detection)

The in-process alerts pipeline (Step 4.5) covers `conflict`, `loggedOut`, `extendedDisconnect`, and `dispatchFailures`. It **cannot** cover a process crash — a killed or OOM'd `run` process can't send its own alert. For that, run a short cron job / systemd timer that polls `whatsapp-monitor status --json` and fires `alerts.command` itself when the service is down.

Only set this up if Step 4.5 is done — the watchdog reuses the same `alerts.command`.

**cron (every 5 min):**

```bash
crontab -e
```

Add:

```
*/5 * * * * /usr/local/bin/whatsapp-monitor status --json 2>/dev/null | /usr/bin/jq -e '.runProcesses | length > 0' >/dev/null || openclaw agent --agent <AGENT_ID> --session-id wa-monitor-alerts --message "whatsapp-monitor service alert — this is a health signal for the monitor itself, NOT an incoming WhatsApp message. Please notify the user RIGHT NOW via whatever messaging tool reaches them (Telegram / Slack / etc.). Your text reply in this session only goes to a log. Kind: crash. Details: whatsapp-monitor run process is not alive on host $(hostname)."
```

Adjust the `whatsapp-monitor` and `jq` paths per `which whatsapp-monitor` / `which jq`, and substitute `<AGENT_ID>`.

**systemd user timer (Linux):** if cron isn't preferred, use a `OnUnitActiveSec=5min` timer firing a small oneshot service running the same check. Same logic.

**Simpler version** if you don't care about the exact alert format and just want *something* to notice:

```
*/5 * * * * /usr/local/bin/whatsapp-monitor status >/dev/null || mail -s "whatsapp-monitor down" you@example.com
```

Two notes:

- Set the watchdog to the **same `<AGENT_ID>` and session id** as the in-process alerts so the agent sees both kinds in one session. Avoids the agent being confused by split context.
- The watchdog adds coverage, it doesn't replace the in-process alerts — the two catch different failure modes. Run both.

---

## Troubleshooting

### Start here — run `whatsapp-monitor status`

Before diving into any specific symptom below, run:

```bash
whatsapp-monitor status
```

It reports auth state, allowlist counts, the resolved notify block, the notification log (size, entry count, last entry), whether a `run` process is currently alive, and — if `run` is up — its **live connection state** (connected / connecting / disconnected / conflict / logged_out) plus uptime, idle time, and reconnect-attempt count.

Interpret the final status line:

- **`✓ ready and connected`** — fully healthy. If messages still aren't flowing, the issue is downstream (the notifier child, the agent, or the agent's messaging tool). Skip ahead to the relevant section below.
- **`✓ ready and running (<state>)`** — the service is up but the socket isn't connected (e.g. `connecting`, `disconnected`). Brief transient states during reconnect are fine; if it's stuck in `disconnected` for more than a minute, check `tail -f /tmp/whatsapp-monitor.err.log` (macOS) or `journalctl --user -u whatsapp-monitor -f` (Linux) for the disconnect reason.
- **`✗ session conflict (440)`** — another WhatsApp Web device has taken over the slot. See the dedicated section below.
- **`✗ logged out`** — the WhatsApp session was invalidated. Re-link with `whatsapp-monitor link`.
- **`✗ not ready`** — config-level blockers (not linked, empty allowlist, bad notify config). The listed blockers are the exact things to fix.

### Session conflict — `status` reports `✗ session conflict (440)`

Symptoms: `whatsapp-monitor status` shows `State: ✗ session conflict (440 — another WhatsApp Web device took over)`, and the service log shows `connection closed: reason=streamConflict(440) ... willReconnect=false` followed by `not reconnecting: session conflict (status 440)`. The service is still running (doesn't crash) but has stopped reconnecting. If the `alerts` pipeline is configured (Step 4.5), the agent should have pinged the user about it already.

What it means: WhatsApp's server allows only one live connection per linked-device slot. Another process using the same credentials claimed the slot, so the server kicked this connection. Retrying would just rotate who holds the slot — the cause must be resolved first.

**The usual cause is a second `whatsapp-monitor run` that shouldn't exist.** Check:

```bash
ps aux | grep whatsapp-monitor   # look for a second `run` process
```

If there's a stray one (e.g. launchd started one and a leftover shell session is running another), kill it. Then restart the service:

```bash
# macOS
launchctl unload ~/Library/LaunchAgents/com.whatsapp-monitor.run.plist
launchctl load ~/Library/LaunchAgents/com.whatsapp-monitor.run.plist
# Linux
systemctl --user restart whatsapp-monitor
```

If no second process exists locally, the conflict is coming from somewhere else — check the phone (WhatsApp → Settings → Linked Devices) for an active entry representing a copy of this auth dir running elsewhere (another machine, a container, an old `scp`-ed copy of `~/.whatsapp-monitor/auth/`). Stop that instance, then restart here.

**What conflict is NOT:** the user's iOS/desktop apps. Those are separate linked-device slots and don't conflict with `whatsapp-monitor`. Conflict only happens when two processes share the same credentials. Don't advise the user to close their desktop app.

If you can't find a second process anywhere and the conflict persists, last resort: `whatsapp-monitor reset` to wipe auth, then re-link and restart.

### `run` refuses to start — "Another `whatsapp-monitor run` is already running"

Symptoms: starting `run` (directly or via launchd/systemd) fails immediately with:

> `Another \`whatsapp-monitor run\` is already running (pid NNNN). If you believe it's stuck, kill it first: kill NNNN. Lock file: ~/.whatsapp-monitor/run.lock`

This is the single-instance guard working as intended. It prevents two `run` processes from producing a 440 conflict loop (see above).

Check what's there:

```bash
ps -p <NNNN>   # is the PID actually alive?
```

- **If alive and legitimate** (e.g. the service manager already started it): you don't need to do anything. `status` will confirm it's running.
- **If alive but unexpected** (stale shell session, debugging leftover): `kill NNNN`, then retry.
- **If the PID is dead** (the error shouldn't appear in that case — the lock is auto-cleaned for stale PIDs — but if a filesystem glitch leaves it behind): `rm ~/.whatsapp-monitor/run.lock` and retry.

Never force-remove the lock while the named PID is alive and is actually `whatsapp-monitor run` — you'd get back to the 440 loop.

### Version mismatch — installed `whatsapp-monitor` is behind npm `latest`

Symptoms: `notify test` prints the old "Dispatching synthetic payload... / Done." output, or `notify.kind` is rejected as unknown, or `timeoutSec` is ignored.

Fix:

```bash
npm install -g whatsapp-monitor@latest
whatsapp-monitor --version
npm view whatsapp-monitor version    # should match the line above
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

### launchd/systemd: lingering children on stop

Symptoms: `launchctl unload` or `systemctl stop` takes the full stop-timeout before succeeding, journal shows `SIGKILL after timeout` or `status=143`, and/or orphaned `sh -c openclaw ...` processes persist.

If you're on the latest CLI and this still happens, check:

- `notify.timeoutSec` is not `0` (child runtime is unbounded).
- The behavior brief doesn't make the agent start long-running background work that outlives the turn.
- `launchctl list | grep whatsapp` / `pgrep -af whatsapp-monitor` to see what's still around.

The CLI sends SIGTERM to in-flight children on shutdown and waits up to 5 seconds before SIGKILL. If you need more headroom, set `TimeoutStopSec=15` (systemd) or accept launchd's default. (If lingering children persist on the latest CLI, you may have hit a regression — confirm the installed version with `whatsapp-monitor --version` and `npm view whatsapp-monitor version` before deeper debugging.)

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

The `rm -rf ~/.whatsapp-monitor` step is intentionally separate — users who plan to reinstall later should skip it so the allowlist, behavior brief, and linked-device state survive. Removing `~/.whatsapp-monitor` requires a full re-onboarding including `link`.

---

## Trust and safety boundary

- The linked WhatsApp account is the user's **personal** number.
- The CLI has **no send capability**. No code path in this tool can post a message to WhatsApp. If the agent wants to reply to someone, it must do so through a different channel (e.g. `@openclaw/whatsapp` on a separate bot number, email, SMS).
- The notifier — `notify.command` (shell) or `notify.kind: "openclaw-agent"` (spawns `openclaw` directly) — runs as the user owning the service process with that user's full privileges. `command` mode has full shell access; `openclaw-agent` mode passes the behavior brief and message payload into the configured agent. Either way, the config file is user-owned; treat changes to it like changes to any other user script.
- The JSONL log (`notifications.jsonl`) contains full message text. Treat it as sensitive.

## Prerequisites

- Node.js >= 18 (`node --version`).
- `whatsapp-monitor` on `PATH`, latest npm version (see Step 0).
- For OpenClaw integration: `openclaw` CLI installed and reachable on `PATH` for the service user — including inside launchd/systemd (see process-manager notes above).
- At least one chat in the allowlist (Step 2) before `run` will start.
