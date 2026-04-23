import { Command } from 'commander'
import { existsSync, statSync } from 'fs'
import { readFile } from 'fs/promises'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { join } from 'path'
import {
  loadConfig,
  resolveNotify,
  resolveErrorAlerts,
  hasExistingAuth,
  getConfigPath,
  getConfigDir,
  NotifyConfigError,
} from '../../config.js'
import type {
  NotificationPayload,
  ResolvedErrorAlerts,
  ResolvedNotify,
  ConnectionState,
} from '../../types.js'
import { readLiveRuntimeState, type RuntimeState } from '../../runtime-state.js'

const execFileAsync = promisify(execFile)

interface RunProcess {
  pid: number
  started?: string
  command: string
}

interface LogSummary {
  path: string
  exists: boolean
  sizeBytes?: number
  modified?: string
  entryCount?: number
  lastEntry?: {
    chatName?: string
    chatId: string
    messageCount: number
    lastTimestamp: number
  }
  error?: string
}

interface LiveState {
  pid: number
  startedAt: number
  updatedAt: number
  connectionState: ConnectionState
  lastActivityAt: number
  reconnectAttempts: number
  idleSec: number
}

interface StatusReport {
  configPath: string
  configError?: string
  auth: {
    authDir: string
    linked: boolean
  }
  allowlist: {
    groups: number
    contacts: number
    empty: boolean
  }
  notify:
    | { mode: 'disabled' }
    | { mode: 'command'; command: string; quietPeriodSec: number; timeoutSec: number; logFile: string }
    | {
        mode: 'openclaw-agent'
        agent: string
        sessionIdTemplate: string
        behaviorFile: string
        behaviorFileExists: boolean
        quietPeriodSec: number
        timeoutSec: number
        logFile: string
      }
  log: LogSummary
  runProcesses: RunProcess[]
  live: LiveState | null
  errorAlerts:
    | { enabled: false }
    | {
        enabled: true
        command: string
        throttleSec: number
        timeoutSec: number
        logFile: string
        logExists: boolean
        lastEntryAt?: number
        triggers: {
          conflict: boolean
          loggedOut: boolean
          extendedDisconnectAfterSec: number | null
          dispatchFailuresAfter: number | null
        }
      }
  ready: boolean
  blockers: string[]
}

export const statusCommand = new Command('status')
  .description('Show whether the monitor is linked, allowlisted, configured, and running')
  .option('--json', 'Emit the status report as JSON')
  .action(async (options) => {
    const report = await buildStatus()

    if (options.json) {
      console.log(JSON.stringify(report, null, 2))
    } else {
      printHuman(report)
    }

    const healthy =
      report.ready &&
      (report.live === null ||
        (report.live.connectionState !== 'conflict' &&
          report.live.connectionState !== 'logged_out'))
    process.exit(healthy ? 0 : 1)
  })

async function buildStatus(): Promise<StatusReport> {
  const configPath = getConfigPath()
  const blockers: string[] = []

  let configError: string | undefined
  let config
  try {
    config = await loadConfig()
  } catch (err) {
    configError = err instanceof Error ? err.message : String(err)
  }

  const authDir = config?.authDir ?? ''
  const linked = authDir ? hasExistingAuth(authDir) : false
  if (!linked) blockers.push('not linked — run `whatsapp-monitor link`')

  const groups = config?.allowedGroups.length ?? 0
  const contacts = config?.allowedContacts.length ?? 0
  const empty = groups + contacts === 0
  if (empty) blockers.push('allowlist is empty — `whatsapp-monitor run` will refuse to start')

  let notify: ResolvedNotify | undefined
  let notifyError: string | undefined
  try {
    notify = resolveNotify(config?.notify)
  } catch (err) {
    notifyError = err instanceof NotifyConfigError ? err.message : err instanceof Error ? err.message : String(err)
    blockers.push(`notify config invalid: ${notifyError}`)
  }

  const notifySection = summarizeNotify(notify)
  if (notifySection.mode === 'openclaw-agent' && !notifySection.behaviorFileExists) {
    blockers.push(`behaviorFile missing: ${notifySection.behaviorFile}`)
  }

  const logPath = notify?.logFile ?? ''
  const log = logPath ? await summarizeLog(logPath) : { path: '', exists: false }

  const runProcesses = await findRunProcesses()

  const runtimeStatePath = join(getConfigDir(), 'runtime-state.json')
  const live = buildLiveState(readLiveRuntimeState(runtimeStatePath))

  if (live?.connectionState === 'conflict') {
    blockers.push(
      'WhatsApp session conflict (status 440): another WhatsApp Web device has taken over this slot. ' +
        'Close the competing session on your other device(s) and restart `whatsapp-monitor run`.'
    )
  } else if (live?.connectionState === 'logged_out') {
    blockers.push('WhatsApp session logged out — re-run `whatsapp-monitor link`')
  }

  const errorAlerts = resolveErrorAlerts(config?.errorAlerts)
  const errorAlertsSection = await summarizeErrorAlerts(errorAlerts)

  const ready = !configError && linked && !empty && !notifyError

  return {
    configPath,
    configError,
    auth: { authDir, linked },
    allowlist: { groups, contacts, empty },
    notify: notifySection,
    log,
    runProcesses,
    live,
    errorAlerts: errorAlertsSection,
    ready,
    blockers,
  }
}

async function summarizeErrorAlerts(errorAlerts: ResolvedErrorAlerts): Promise<StatusReport['errorAlerts']> {
  if (!errorAlerts.enabled) return { enabled: false }
  const logExists = existsSync(errorAlerts.logFile)
  let lastEntryAt: number | undefined
  if (logExists) {
    try {
      const content = await readFile(errorAlerts.logFile, 'utf-8')
      const lines = content.split('\n').filter((l) => l.trim() !== '')
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const parsed = JSON.parse(lines[i]) as { timestamp?: unknown }
          if (typeof parsed.timestamp === 'number') {
            lastEntryAt = parsed.timestamp
            break
          }
        } catch {
          // skip malformed
        }
      }
    } catch {
      // ignore
    }
  }
  return {
    enabled: true,
    command: errorAlerts.command,
    throttleSec: errorAlerts.throttleSec,
    timeoutSec: errorAlerts.timeoutSec,
    logFile: errorAlerts.logFile,
    logExists,
    lastEntryAt,
    triggers: errorAlerts.triggers,
  }
}

function buildLiveState(state: RuntimeState | null): LiveState | null {
  if (!state) return null
  return {
    pid: state.pid,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    connectionState: state.connectionState,
    lastActivityAt: state.lastActivityAt,
    reconnectAttempts: state.reconnectAttempts,
    idleSec: Math.max(0, Math.round((Date.now() - state.lastActivityAt) / 1000)),
  }
}

function summarizeNotify(notify: ResolvedNotify | undefined): StatusReport['notify'] {
  if (!notify || notify.mode === 'disabled') return { mode: 'disabled' }
  if (notify.mode === 'command') {
    return {
      mode: 'command',
      command: notify.command,
      quietPeriodSec: notify.quietPeriodSec,
      timeoutSec: notify.timeoutSec,
      logFile: notify.logFile,
    }
  }
  return {
    mode: 'openclaw-agent',
    agent: notify.agent,
    sessionIdTemplate: notify.sessionIdTemplate,
    behaviorFile: notify.behaviorFile,
    behaviorFileExists: existsSync(notify.behaviorFile),
    quietPeriodSec: notify.quietPeriodSec,
    timeoutSec: notify.timeoutSec,
    logFile: notify.logFile,
  }
}

async function summarizeLog(path: string): Promise<LogSummary> {
  if (!existsSync(path)) return { path, exists: false }
  try {
    const stat = statSync(path)
    const content = await readFile(path, 'utf-8')
    const lines = content.split('\n').filter((l) => l.trim() !== '')
    let lastEntry: LogSummary['lastEntry']
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(lines[i]) as NotificationPayload
        lastEntry = {
          chatName: parsed.chatName,
          chatId: parsed.chatId,
          messageCount: parsed.messageCount,
          lastTimestamp: parsed.lastTimestamp,
        }
        break
      } catch {
        // skip malformed line
      }
    }
    return {
      path,
      exists: true,
      sizeBytes: stat.size,
      modified: stat.mtime.toISOString(),
      entryCount: lines.length,
      lastEntry,
    }
  } catch (err) {
    return { path, exists: true, error: err instanceof Error ? err.message : String(err) }
  }
}

async function findRunProcesses(): Promise<RunProcess[]> {
  try {
    const { stdout } = await execFileAsync('ps', ['-Ao', 'pid=,lstart=,args='])
    const self = process.pid
    const parent = process.ppid
    const out: RunProcess[] = []
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue
      const match = line.match(/^\s*(\d+)\s+(.{24})\s+(.*)$/)
      if (!match) continue
      const pid = Number(match[1])
      const started = match[2].trim()
      const command = match[3].trim()
      if (pid === self || pid === parent) continue
      if (!/whatsapp-monitor(\s+|$)/.test(command)) continue
      if (!/\brun\b/.test(command)) continue
      if (/\bstatus\b/.test(command)) continue
      out.push({ pid, started, command })
    }
    return out
  } catch {
    return []
  }
}

function printHuman(r: StatusReport): void {
  const bar = '─'.repeat(50)
  console.log('')
  console.log('WhatsApp Monitor Status')
  console.log(bar)
  console.log(`Config file: ${r.configPath}`)
  if (r.configError) console.log(`  ✗ config error: ${r.configError}`)

  console.log('')
  console.log('Auth:')
  console.log(`  Directory: ${r.auth.authDir || '(unknown)'}`)
  console.log(`  Linked:    ${r.auth.linked ? '✓ yes' : '✗ no (run `whatsapp-monitor link`)'}`)

  console.log('')
  console.log('Allowlist:')
  console.log(`  Groups:   ${r.allowlist.groups}`)
  console.log(`  Contacts: ${r.allowlist.contacts}`)
  if (r.allowlist.empty) console.log('  ✗ empty — `run` will refuse to start')

  console.log('')
  console.log('Notify:')
  const n = r.notify
  if (n.mode === 'disabled') {
    console.log('  Mode: disabled (no notify.command or notify.kind configured)')
  } else if (n.mode === 'command') {
    console.log('  Mode:          command')
    console.log(`  Command:       ${n.command}`)
    console.log(`  Quiet period:  ${n.quietPeriodSec}s`)
    console.log(`  Timeout:       ${n.timeoutSec === 0 ? 'disabled' : n.timeoutSec + 's'}`)
    console.log(`  Log file:      ${n.logFile}`)
  } else {
    console.log('  Mode:              openclaw-agent')
    console.log(`  Agent:             ${n.agent}`)
    console.log(`  Session template:  ${n.sessionIdTemplate}`)
    console.log(`  Behavior file:     ${n.behaviorFile}${n.behaviorFileExists ? '' : '  ✗ missing'}`)
    console.log(`  Quiet period:      ${n.quietPeriodSec}s`)
    console.log(`  Timeout:           ${n.timeoutSec === 0 ? 'disabled' : n.timeoutSec + 's'}`)
    console.log(`  Log file:          ${n.logFile}`)
  }

  console.log('')
  console.log('Notification log:')
  if (!r.log.path) {
    console.log('  (no log path — notify not configured)')
  } else if (!r.log.exists) {
    console.log(`  ${r.log.path}`)
    console.log('  (does not exist yet — no notifications dispatched)')
  } else if (r.log.error) {
    console.log(`  ${r.log.path}`)
    console.log(`  ✗ ${r.log.error}`)
  } else {
    console.log(`  Path:     ${r.log.path}`)
    console.log(`  Size:     ${formatBytes(r.log.sizeBytes ?? 0)}`)
    console.log(`  Entries:  ${r.log.entryCount}`)
    console.log(`  Modified: ${r.log.modified}`)
    if (r.log.lastEntry) {
      const e = r.log.lastEntry
      const when = new Date(e.lastTimestamp).toISOString()
      const who = e.chatName ? `${e.chatName} (${e.chatId})` : e.chatId
      console.log(`  Last:     ${when} — ${who}, ${e.messageCount} msg`)
    }
  }

  console.log('')
  console.log('Error alerts (operator notifications on service issues):')
  if (!r.errorAlerts.enabled) {
    console.log('  Mode: disabled (no errorAlerts.command configured)')
    console.log('  Note: service issues like session conflict, logged-out, or extended')
    console.log('        disconnect will only surface in logs. Configure errorAlerts.command')
    console.log('        in ~/.whatsapp-monitor/config.json to get notified.')
  } else {
    const a = r.errorAlerts
    console.log(`  Command:       ${a.command}`)
    console.log(`  Throttle:      ${a.throttleSec}s (per-kind)`)
    console.log(`  Timeout:       ${a.timeoutSec === 0 ? 'disabled' : a.timeoutSec + 's'}`)
    const triggers: string[] = []
    if (a.triggers.conflict) triggers.push('conflict')
    if (a.triggers.loggedOut) triggers.push('loggedOut')
    if (a.triggers.extendedDisconnectAfterSec !== null)
      triggers.push(`extendedDisconnect(${a.triggers.extendedDisconnectAfterSec}s)`)
    if (a.triggers.dispatchFailuresAfter !== null)
      triggers.push(`dispatchFailures(${a.triggers.dispatchFailuresAfter} consecutive)`)
    console.log(`  Triggers:      [${triggers.join(', ')}]`)
    console.log(`  Log file:      ${a.logFile}`)
    if (a.logExists && a.lastEntryAt) {
      console.log(`  Last alert:    ${new Date(a.lastEntryAt).toISOString()}`)
    } else if (a.logExists) {
      console.log('  Last alert:    (log exists but no parseable entries)')
    } else {
      console.log('  Last alert:    (none — log does not exist yet)')
    }
  }

  console.log('')
  console.log('Processes:')
  if (r.runProcesses.length === 0) {
    console.log('  (no `whatsapp-monitor run` process found)')
  } else {
    for (const p of r.runProcesses) {
      console.log(`  pid ${p.pid} — started ${p.started}`)
      console.log(`    ${p.command}`)
    }
  }

  console.log('')
  console.log('Live connection:')
  if (!r.live) {
    console.log('  (not running, or `run` process is from a pre-upgrade version)')
  } else {
    const lbl = connectionStateLabel(r.live.connectionState)
    console.log(`  State:              ${lbl}`)
    console.log(`  Pid:                ${r.live.pid}`)
    console.log(`  Uptime:             ${formatDuration(Date.now() - r.live.startedAt)}`)
    console.log(`  Last activity:      ${new Date(r.live.lastActivityAt).toISOString()} (${formatDuration(r.live.idleSec * 1000)} ago)`)
    console.log(`  Reconnect attempts: ${r.live.reconnectAttempts}`)
    console.log(`  State file age:     ${formatDuration(Date.now() - r.live.updatedAt)}`)
  }

  console.log('')
  const live = r.live
  if (live?.connectionState === 'conflict') {
    console.log('Status: ✗ session conflict (440)')
    for (const b of r.blockers) console.log(`  - ${b}`)
  } else if (live?.connectionState === 'logged_out') {
    console.log('Status: ✗ logged out')
    for (const b of r.blockers) console.log(`  - ${b}`)
  } else if (r.ready && live?.connectionState === 'connected') {
    console.log('Status: ✓ ready and connected')
  } else if (r.ready && r.runProcesses.length > 0) {
    console.log(`Status: ✓ ready and running (${live ? live.connectionState : 'no live state'})`)
  } else if (r.ready) {
    console.log('Status: ✓ ready (not running — start with `whatsapp-monitor run`)')
  } else {
    console.log('Status: ✗ not ready')
    for (const b of r.blockers) console.log(`  - ${b}`)
  }
  console.log('')
}

function connectionStateLabel(state: ConnectionState): string {
  switch (state) {
    case 'connected':
      return '✓ connected'
    case 'connecting':
      return '… connecting'
    case 'disconnected':
      return '⟳ disconnected (reconnecting)'
    case 'logged_out':
      return '✗ logged out'
    case 'conflict':
      return '✗ session conflict (440 — another WhatsApp Web device took over)'
  }
}

function formatDuration(ms: number): string {
  if (ms < 0) ms = 0
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ${sec % 60}s`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ${min % 60}m`
  const d = Math.floor(hr / 24)
  return `${d}d ${hr % 24}h`
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}
