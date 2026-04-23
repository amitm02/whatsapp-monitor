import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join, dirname, isAbsolute } from 'path'
import type {
  ErrorAlertsConfig,
  MonitorConfig,
  NotifyConfig,
  ResolvedErrorAlerts,
  ResolvedNotify,
} from './types.js'

const CONFIG_DIR = join(homedir(), '.whatsapp-monitor')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')
const DEFAULT_AUTH_DIR = join(CONFIG_DIR, 'auth')
const DEFAULT_NOTIFY_LOG = join(CONFIG_DIR, 'notifications.jsonl')
const DEFAULT_ERROR_ALERTS_LOG = join(CONFIG_DIR, 'error-alerts.jsonl')
const DEFAULT_BEHAVIOR_FILE = join(CONFIG_DIR, 'behavior.md')
const DEFAULT_QUIET_PERIOD_SEC = 30
const DEFAULT_TIMEOUT_SEC = 120
const DEFAULT_MAX_BUFFERED_PER_CHAT = 50
const DEFAULT_SESSION_ID_TEMPLATE = 'wa-monitor-{date}'
const DEFAULT_ERROR_ALERTS_THROTTLE_SEC = 15 * 60
const DEFAULT_ERROR_ALERTS_TIMEOUT_SEC = 60
const DEFAULT_EXTENDED_DISCONNECT_SEC = 10 * 60
const DEFAULT_DISPATCH_FAILURES_AFTER = 5

const DEFAULT_CONFIG: MonitorConfig = {
  allowedGroups: [],
  allowedContacts: [],
  authDir: DEFAULT_AUTH_DIR,
}

export class NotifyConfigError extends Error {}

function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

function resolvePath(p: string, base: string): string {
  const expanded = expandHome(p)
  return isAbsolute(expanded) ? expanded : join(base, expanded)
}

function normalizeNotify(input: unknown): NotifyConfig | undefined {
  if (!input || typeof input !== 'object') return undefined
  const raw = input as Record<string, unknown>
  const notify: NotifyConfig = {}

  if (typeof raw.command === 'string' && raw.command.trim() !== '') {
    notify.command = raw.command
  }
  if (raw.kind !== undefined) {
    if (raw.kind !== 'openclaw-agent') {
      throw new NotifyConfigError(`notify.kind must be "openclaw-agent" (got ${JSON.stringify(raw.kind)})`)
    }
    notify.kind = raw.kind
  }
  if (typeof raw.agent === 'string' && raw.agent.trim() !== '') notify.agent = raw.agent
  if (typeof raw.sessionIdTemplate === 'string' && raw.sessionIdTemplate.trim() !== '') {
    notify.sessionIdTemplate = raw.sessionIdTemplate
  }
  if (typeof raw.behaviorFile === 'string' && raw.behaviorFile.trim() !== '') {
    notify.behaviorFile = raw.behaviorFile
  }
  if (typeof raw.quietPeriodSec === 'number' && raw.quietPeriodSec >= 0) {
    notify.quietPeriodSec = raw.quietPeriodSec
  }
  if (typeof raw.timeoutSec === 'number' && raw.timeoutSec >= 0) {
    notify.timeoutSec = raw.timeoutSec
  }
  if (typeof raw.logFile === 'string' && raw.logFile.trim() !== '') {
    notify.logFile = raw.logFile
  }
  if (typeof raw.maxBufferedPerChat === 'number' && raw.maxBufferedPerChat > 0) {
    notify.maxBufferedPerChat = raw.maxBufferedPerChat
  }

  if (notify.command && notify.kind) {
    throw new NotifyConfigError(
      'notify.command and notify.kind are mutually exclusive. Pick one: set "command" for a custom shell pipeline, or "kind" for a structured integration.'
    )
  }
  if (notify.kind === 'openclaw-agent' && !notify.agent) {
    throw new NotifyConfigError('notify.kind = "openclaw-agent" requires notify.agent (the OpenClaw agent id)')
  }

  return Object.keys(notify).length > 0 ? notify : undefined
}

export function resolveNotify(notify: NotifyConfig | undefined): ResolvedNotify {
  const base = {
    quietPeriodSec: notify?.quietPeriodSec ?? DEFAULT_QUIET_PERIOD_SEC,
    timeoutSec: notify?.timeoutSec ?? DEFAULT_TIMEOUT_SEC,
    logFile: resolvePath(notify?.logFile ?? DEFAULT_NOTIFY_LOG, CONFIG_DIR),
    maxBufferedPerChat: notify?.maxBufferedPerChat ?? DEFAULT_MAX_BUFFERED_PER_CHAT,
  }

  if (notify?.kind === 'openclaw-agent') {
    return {
      ...base,
      mode: 'openclaw-agent',
      agent: notify.agent!,
      sessionIdTemplate: notify.sessionIdTemplate ?? DEFAULT_SESSION_ID_TEMPLATE,
      behaviorFile: resolvePath(notify.behaviorFile ?? DEFAULT_BEHAVIOR_FILE, CONFIG_DIR),
    }
  }

  if (notify?.command) {
    return { ...base, mode: 'command', command: notify.command }
  }

  return { ...base, mode: 'disabled' }
}

function normalizeErrorAlerts(input: unknown): ErrorAlertsConfig | undefined {
  if (!input || typeof input !== 'object') return undefined
  const raw = input as Record<string, unknown>
  const errorAlerts: ErrorAlertsConfig = {}

  if (typeof raw.command === 'string' && raw.command.trim() !== '') {
    errorAlerts.command = raw.command
  }
  if (typeof raw.throttleSec === 'number' && raw.throttleSec >= 0) {
    errorAlerts.throttleSec = raw.throttleSec
  }
  if (typeof raw.timeoutSec === 'number' && raw.timeoutSec >= 0) {
    errorAlerts.timeoutSec = raw.timeoutSec
  }
  if (typeof raw.logFile === 'string' && raw.logFile.trim() !== '') {
    errorAlerts.logFile = raw.logFile
  }
  if (raw.on && typeof raw.on === 'object') {
    const on = raw.on as Record<string, unknown>
    errorAlerts.on = {}
    if (typeof on.conflict === 'boolean') errorAlerts.on.conflict = on.conflict
    if (typeof on.loggedOut === 'boolean') errorAlerts.on.loggedOut = on.loggedOut
    if (typeof on.notLinked === 'boolean') errorAlerts.on.notLinked = on.notLinked
    if (typeof on.extendedDisconnect === 'boolean') {
      errorAlerts.on.extendedDisconnect = on.extendedDisconnect
    } else if (on.extendedDisconnect && typeof on.extendedDisconnect === 'object') {
      const ext = on.extendedDisconnect as { afterSec?: unknown }
      if (typeof ext.afterSec === 'number' && ext.afterSec > 0) {
        errorAlerts.on.extendedDisconnect = { afterSec: ext.afterSec }
      }
    }
    if (typeof on.dispatchFailures === 'boolean') {
      errorAlerts.on.dispatchFailures = on.dispatchFailures
    } else if (on.dispatchFailures && typeof on.dispatchFailures === 'object') {
      const df = on.dispatchFailures as { afterConsecutive?: unknown }
      if (typeof df.afterConsecutive === 'number' && df.afterConsecutive > 0) {
        errorAlerts.on.dispatchFailures = { afterConsecutive: df.afterConsecutive }
      }
    }
  }

  return Object.keys(errorAlerts).length > 0 ? errorAlerts : undefined
}

export function resolveErrorAlerts(errorAlerts: ErrorAlertsConfig | undefined): ResolvedErrorAlerts {
  const command = errorAlerts?.command ?? ''
  const enabled = command.length > 0
  const on = errorAlerts?.on ?? {}
  const extractExtended = (): number | null => {
    const v = on.extendedDisconnect
    if (v === false) return null
    if (v === true || v === undefined) return enabled ? DEFAULT_EXTENDED_DISCONNECT_SEC : null
    return v.afterSec ?? DEFAULT_EXTENDED_DISCONNECT_SEC
  }
  const extractDispatchFailures = (): number | null => {
    const v = on.dispatchFailures
    if (v === false) return null
    if (v === true || v === undefined) return enabled ? DEFAULT_DISPATCH_FAILURES_AFTER : null
    return v.afterConsecutive ?? DEFAULT_DISPATCH_FAILURES_AFTER
  }
  return {
    enabled,
    command,
    throttleSec: errorAlerts?.throttleSec ?? DEFAULT_ERROR_ALERTS_THROTTLE_SEC,
    timeoutSec: errorAlerts?.timeoutSec ?? DEFAULT_ERROR_ALERTS_TIMEOUT_SEC,
    logFile: resolvePath(errorAlerts?.logFile ?? DEFAULT_ERROR_ALERTS_LOG, CONFIG_DIR),
    triggers: {
      // Default to on for conflict/loggedOut/notLinked when error alerts are
      // enabled; these are the high-value signals operators almost always want.
      conflict: enabled && on.conflict !== false,
      loggedOut: enabled && on.loggedOut !== false,
      extendedDisconnectAfterSec: enabled ? extractExtended() : null,
      dispatchFailuresAfter: enabled ? extractDispatchFailures() : null,
      notLinked: enabled && on.notLinked !== false,
    },
  }
}

export async function loadConfig(): Promise<MonitorConfig> {
  if (!existsSync(CONFIG_FILE)) {
    return { ...DEFAULT_CONFIG }
  }
  let parsed: Partial<MonitorConfig>
  try {
    const content = await readFile(CONFIG_FILE, 'utf-8')
    parsed = JSON.parse(content) as Partial<MonitorConfig>
  } catch {
    return { ...DEFAULT_CONFIG }
  }
  return {
    allowedGroups: parsed.allowedGroups ?? [],
    allowedContacts: parsed.allowedContacts ?? [],
    authDir: parsed.authDir ?? DEFAULT_AUTH_DIR,
    notify: normalizeNotify(parsed.notify),
    errorAlerts: normalizeErrorAlerts(parsed.errorAlerts),
  }
}

export async function saveConfig(config: MonitorConfig): Promise<void> {
  await mkdir(dirname(CONFIG_FILE), { recursive: true })
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8')
}

export async function addToAllowlist(id: string): Promise<void> {
  const config = await loadConfig()
  const isGroup = id.endsWith('@g.us')
  const isContact = id.endsWith('@s.whatsapp.net')

  if (!isGroup && !isContact) {
    throw new Error(
      'Invalid ID format. Must end with @g.us (group) or @s.whatsapp.net (contact)'
    )
  }

  if (isGroup) {
    if (!config.allowedGroups.includes(id)) {
      config.allowedGroups.push(id)
    }
  } else {
    if (!config.allowedContacts.includes(id)) {
      config.allowedContacts.push(id)
    }
  }

  await saveConfig(config)
}

export async function removeFromAllowlist(id: string): Promise<void> {
  const config = await loadConfig()

  config.allowedGroups = config.allowedGroups.filter((g) => g !== id)
  config.allowedContacts = config.allowedContacts.filter((c) => c !== id)

  await saveConfig(config)
}

export function isAllowed(chatId: string, config: MonitorConfig): boolean {
  // If both allowlists are empty, nothing is allowed (secure default)
  if (config.allowedGroups.length === 0 && config.allowedContacts.length === 0) {
    return false
  }

  return (
    config.allowedGroups.includes(chatId) ||
    config.allowedContacts.includes(chatId)
  )
}

export function getConfigPath(): string {
  return CONFIG_FILE
}

export function getConfigDir(): string {
  return CONFIG_DIR
}

export function hasExistingAuth(authDir: string = DEFAULT_AUTH_DIR): boolean {
  return existsSync(join(authDir, 'creds.json'))
}

export { CONFIG_DIR, CONFIG_FILE, DEFAULT_AUTH_DIR, DEFAULT_NOTIFY_LOG }
