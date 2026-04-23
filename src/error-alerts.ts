import { spawn } from 'child_process'
import { appendFile, mkdir } from 'fs/promises'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import type { ErrorAlertKind, ErrorAlertPayload, ResolvedErrorAlerts } from './types.js'

const SIGKILL_GRACE_MS = 2000

export interface ErrorAlerterOptions {
  errorAlerts: ResolvedErrorAlerts
  stateFile: string
  onWarning?: (msg: string) => void
}

export interface FireResult {
  fired: boolean
  reason?: 'disabled' | 'throttled'
  /** Populated when fired === true: */
  exitCode?: number | null
  signal?: NodeJS.Signals | null
  elapsedMs?: number
  spawnError?: string | null
  timedOut?: boolean
  stderrPreview?: string
}

interface ErrorAlertState {
  // Per-kind throttle. Each kind throttles independently so a flood of
  // dispatch-failure alerts doesn't mute a subsequent conflict alert.
  lastFiredByKind: Partial<Record<ErrorAlertKind, number>>
}

function readState(path: string): ErrorAlertState {
  if (!existsSync(path)) return { lastFiredByKind: {} }
  try {
    const raw = readFileSync(path, 'utf-8')
    const parsed = JSON.parse(raw) as ErrorAlertState
    if (parsed && typeof parsed === 'object' && parsed.lastFiredByKind) return parsed
  } catch {
    // fall through
  }
  return { lastFiredByKind: {} }
}

function writeState(path: string, state: ErrorAlertState): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(state, null, 2), 'utf-8')
  } catch {
    // best-effort — throttle state is advisory. A lost update means at
    // worst one extra alert after a crash, which is fine.
  }
}

/**
 * ErrorAlerter — fires operator-facing alerts when the monitor hits trouble
 * states (stream conflict, logged-out, extended disconnect, repeated
 * dispatch failures). Always appends to `errorAlerts.logFile` regardless of
 * whether the shell command was invoked, so there's a durable record even
 * when throttling kicks in.
 *
 * Delivery is via `sh -c errorAlerts.command` with a JSON payload on stdin
 * and `WAM_ERROR_ALERT_*` env vars for quick shell-conditional use.
 * Symmetric with `notify.command` so the mental model is shared.
 */
export class ErrorAlerter {
  private readonly opts: ErrorAlerterOptions
  private state: ErrorAlertState
  private logReady: Promise<void> | null = null

  constructor(opts: ErrorAlerterOptions) {
    this.opts = opts
    this.state = readState(opts.stateFile)
  }

  isEnabled(): boolean {
    return this.opts.errorAlerts.enabled
  }

  /**
   * Fire an error alert of the given kind. Idempotent within the throttle
   * window per-kind — subsequent calls during the window return
   * {fired: false, reason: 'throttled'} but still append to the log.
   *
   * Pass `force: true` for explicit test invocations that should bypass
   * throttling (e.g. `error-alerts test`).
   */
  async fire(
    kind: ErrorAlertKind,
    message: string,
    details?: Record<string, unknown>,
    opts: { force?: boolean } = {}
  ): Promise<FireResult> {
    const errorAlerts = this.opts.errorAlerts
    const payload: ErrorAlertPayload = {
      kind,
      message,
      timestamp: Date.now(),
      details,
    }
    const json = JSON.stringify(payload)

    // Always persist to the log, even when throttled or disabled — this is
    // the durable record for postmortem.
    await this.appendLog(json)

    if (!errorAlerts.enabled) {
      return { fired: false, reason: 'disabled' }
    }

    if (!opts.force) {
      const last = this.state.lastFiredByKind[kind] ?? 0
      const throttleMs = errorAlerts.throttleSec * 1000
      if (throttleMs > 0 && Date.now() - last < throttleMs) {
        return { fired: false, reason: 'throttled' }
      }
    }

    // Record send time up front so concurrent fires in the same kind don't
    // both slip through. Persisted at the end too in case this process is
    // killed before the child returns.
    this.state.lastFiredByKind[kind] = Date.now()
    writeState(this.opts.stateFile, this.state)

    const spawnResult = await this.execChild(payload, json)
    return { fired: true, ...spawnResult }
  }

  private async appendLog(line: string): Promise<void> {
    if (!this.logReady) {
      this.logReady = mkdir(dirname(this.opts.errorAlerts.logFile), { recursive: true }).then(() => undefined)
    }
    try {
      await this.logReady
      await appendFile(this.opts.errorAlerts.logFile, line + '\n', 'utf-8')
    } catch (err) {
      this.opts.onWarning?.(`Failed to append to error-alerts log: ${formatError(err)}`)
    }
  }

  private execChild(
    payload: ErrorAlertPayload,
    json: string
  ): Promise<Omit<FireResult, 'fired' | 'reason'>> {
    const { command, timeoutSec } = this.opts.errorAlerts
    const start = Date.now()

    return new Promise((resolve) => {
      const child = spawn('sh', ['-c', command], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          WAM_ERROR_ALERT_KIND: payload.kind,
          WAM_ERROR_ALERT_MESSAGE: payload.message,
          WAM_ERROR_ALERT_TIMESTAMP: String(payload.timestamp),
        },
      })

      let settled = false
      let termTimer: NodeJS.Timeout | null = null
      let killTimer: NodeJS.Timeout | null = null
      let timedOut = false
      let spawnError: string | null = null
      const stderrChunks: Buffer[] = []

      if (timeoutSec > 0) {
        termTimer = setTimeout(() => {
          if (settled) return
          timedOut = true
          try {
            child.kill('SIGTERM')
          } catch {
            // ignore
          }
          killTimer = setTimeout(() => {
            try {
              child.kill('SIGKILL')
            } catch {
              // ignore
            }
          }, SIGKILL_GRACE_MS)
        }, timeoutSec * 1000)
      }

      const finish = (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return
        settled = true
        if (termTimer) clearTimeout(termTimer)
        if (killTimer) clearTimeout(killTimer)
        resolve({
          exitCode: code,
          signal,
          elapsedMs: Date.now() - start,
          spawnError,
          timedOut,
          stderrPreview: previewBuffer(stderrChunks),
        })
      }

      child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk))
      // Discard stdout — we don't route it anywhere, and leaving it
      // unread would back-pressure the child. Consume and drop.
      child.stdout?.on('data', () => {})

      child.on('error', (err) => {
        spawnError = formatError(err)
        finish(null, null)
      })
      child.on('close', (code, signal) => {
        finish(code, signal)
      })

      if (child.stdin) {
        child.stdin.on('error', () => {
          // Some error-alert commands don't read stdin; ignore EPIPE.
        })
        try {
          child.stdin.end(Buffer.from(json, 'utf-8'))
        } catch {
          // fall through — child will exit naturally
        }
      }
    })
  }
}

function previewBuffer(chunks: Buffer[], max = 200): string {
  const text = Buffer.concat(chunks).toString('utf-8').trim()
  if (text.length <= max) return text
  return text.slice(0, max) + '…'
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

export function defaultErrorAlertStatePath(configDir: string): string {
  return join(configDir, 'error-alert-state.json')
}
