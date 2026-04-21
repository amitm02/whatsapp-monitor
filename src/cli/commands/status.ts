import { Command } from 'commander'
import { existsSync, statSync } from 'fs'
import { readFile } from 'fs/promises'
import { execFile } from 'child_process'
import { promisify } from 'util'
import {
  loadConfig,
  resolveNotify,
  hasExistingAuth,
  getConfigPath,
  NotifyConfigError,
} from '../../config.js'
import type { NotificationPayload, ResolvedNotify } from '../../types.js'

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

    process.exit(report.ready ? 0 : 1)
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

  const ready = !configError && linked && !empty && !notifyError

  return {
    configPath,
    configError,
    auth: { authDir, linked },
    allowlist: { groups, contacts, empty },
    notify: notifySection,
    log,
    runProcesses,
    ready,
    blockers,
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
  if (r.ready && r.runProcesses.length > 0) {
    console.log('Status: ✓ ready and running')
  } else if (r.ready) {
    console.log('Status: ✓ ready (not running — start with `whatsapp-monitor run`)')
  } else {
    console.log('Status: ✗ not ready')
    for (const b of r.blockers) console.log(`  - ${b}`)
  }
  console.log('')
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}
