import { spawn, type ChildProcess } from 'child_process'
import { appendFile, mkdir, readFile } from 'fs/promises'
import { dirname } from 'path'
import type { NotificationPayload, ResolvedNotify } from './types.js'

export interface DispatcherOptions {
  notify: ResolvedNotify
  verbose?: boolean
  onWarning?: (msg: string) => void
  onInfo?: (msg: string) => void
}

interface ChatQueue {
  promise: Promise<void>
  depth: number
}

export interface DispatchResult {
  mode: ResolvedNotify['mode']
  ranChild: boolean
  exitCode: number | null
  signal: NodeJS.Signals | null
  elapsedMs: number
  bytesWritten: number
  stdoutPreview: string
  stderrPreview: string
  timedOut: boolean
  spawnError: string | null
  logAppended: boolean
  logError: string | null
}

const QUEUE_DEPTH_WARNING = 5
const SIGKILL_GRACE_MS = 2000

export class Dispatcher {
  private readonly opts: DispatcherOptions
  private readonly queues = new Map<string, ChatQueue>()
  private readonly children = new Set<ChildProcess>()
  private logReady: Promise<void> | null = null
  private closed = false

  constructor(opts: DispatcherOptions) {
    this.opts = opts
  }

  async dispatch(payload: NotificationPayload): Promise<DispatchResult | null> {
    if (this.closed) return null
    const existing = this.queues.get(payload.chatId)
    const previous = existing?.promise ?? Promise.resolve()
    const depth = (existing?.depth ?? 0) + 1
    if (depth === QUEUE_DEPTH_WARNING && this.opts.onWarning) {
      this.opts.onWarning(
        `Notify queue for ${payload.chatId} has ${depth} pending dispatches; notify command may be too slow`
      )
    }
    let captured: DispatchResult | null = null
    const next = previous
      .then(async () => {
        captured = await this.runOne(payload)
      })
      .finally(() => {
        const current = this.queues.get(payload.chatId)
        if (current && current.promise === next) {
          this.queues.delete(payload.chatId)
        }
      })
    this.queues.set(payload.chatId, { promise: next, depth })
    await next
    return captured
  }

  async drain(): Promise<void> {
    const pending = Array.from(this.queues.values()).map((q) => q.promise)
    await Promise.allSettled(pending)
  }

  async shutdown(opts: { drainTimeoutMs?: number } = {}): Promise<void> {
    this.closed = true
    const drainTimeoutMs = opts.drainTimeoutMs ?? 5000
    for (const child of this.children) {
      try {
        child.kill('SIGTERM')
      } catch {
        // process may already be gone
      }
    }
    await Promise.race([this.drain(), new Promise<void>((resolve) => setTimeout(resolve, drainTimeoutMs))])
    for (const child of this.children) {
      try {
        child.kill('SIGKILL')
      } catch {
        // nothing to do
      }
    }
    await this.drain()
  }

  private async runOne(payload: NotificationPayload): Promise<DispatchResult> {
    const json = JSON.stringify(payload)
    const logResult = await this.appendLog(json)
    const result: DispatchResult = {
      mode: this.opts.notify.mode,
      ranChild: false,
      exitCode: null,
      signal: null,
      elapsedMs: 0,
      bytesWritten: 0,
      stdoutPreview: '',
      stderrPreview: '',
      timedOut: false,
      spawnError: null,
      logAppended: logResult.ok,
      logError: logResult.error,
    }

    if (this.opts.notify.mode === 'disabled') return result

    if (this.opts.notify.mode === 'openclaw-agent') {
      const argv = await this.buildOpenClawArgv(payload, json)
      if (!argv) {
        result.spawnError = 'failed to build openclaw argv'
        return result
      }
      return this.execChild({ file: 'openclaw', args: argv.args, stdinPayload: argv.stdin, result, payload })
    }

    return this.execChild({
      file: 'sh',
      args: ['-c', this.opts.notify.command],
      stdinPayload: json,
      result,
      payload,
    })
  }

  private async buildOpenClawArgv(
    payload: NotificationPayload,
    json: string
  ): Promise<{ args: string[]; stdin: string } | null> {
    if (this.opts.notify.mode !== 'openclaw-agent') return null
    const { agent, sessionIdTemplate, behaviorFile } = this.opts.notify
    const sessionId = renderTemplate(sessionIdTemplate, payload)
    let brief = ''
    try {
      brief = (await readFile(behaviorFile, 'utf-8')).trim()
    } catch (err) {
      if (this.opts.onWarning) {
        this.opts.onWarning(`Could not read behaviorFile ${behaviorFile}: ${formatError(err)}`)
      }
      brief = `(no behavior brief found at ${behaviorFile})`
    }
    const message = brief ? `${brief}\n\n---\n\n${json}` : json
    return {
      args: ['agent', '--agent', agent, '--session-id', sessionId, '--message', message],
      stdin: '',
    }
  }

  private async appendLog(line: string): Promise<{ ok: boolean; error: string | null }> {
    if (!this.logReady) {
      this.logReady = mkdir(dirname(this.opts.notify.logFile), { recursive: true }).then(() => undefined)
    }
    try {
      await this.logReady
      await appendFile(this.opts.notify.logFile, line + '\n', 'utf-8')
      return { ok: true, error: null }
    } catch (err) {
      const msg = formatError(err)
      if (this.opts.onWarning) {
        this.opts.onWarning(`Failed to append to notify log: ${msg}`)
      }
      return { ok: false, error: msg }
    }
  }

  private execChild(params: {
    file: string
    args: string[]
    stdinPayload: string
    result: DispatchResult
    payload: NotificationPayload
  }): Promise<DispatchResult> {
    const { file, args, stdinPayload, result, payload } = params
    const timeoutSec = this.opts.notify.timeoutSec
    const start = Date.now()

    return new Promise<DispatchResult>((resolve) => {
      const child = spawn(file, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          WAM_CHAT_ID: payload.chatId,
          WAM_CHAT_NAME: payload.chatName ?? '',
          WAM_IS_GROUP: payload.isGroup ? 'true' : 'false',
          WAM_MESSAGE_COUNT: String(payload.messageCount),
          WAM_FIRST_TS: String(payload.firstTimestamp),
          WAM_LAST_TS: String(payload.lastTimestamp),
        },
      })
      this.children.add(child)
      result.ranChild = true

      let settled = false
      let termTimer: NodeJS.Timeout | null = null
      let killTimer: NodeJS.Timeout | null = null

      if (timeoutSec > 0) {
        termTimer = setTimeout(() => {
          if (settled) return
          result.timedOut = true
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

      const stderrChunks: Buffer[] = []
      const stdoutChunks: Buffer[] = []
      child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk))
      child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk))

      const finish = () => {
        if (settled) return
        settled = true
        if (termTimer) clearTimeout(termTimer)
        if (killTimer) clearTimeout(killTimer)
        this.children.delete(child)
        result.elapsedMs = Date.now() - start
        result.stdoutPreview = previewBuffer(stdoutChunks)
        result.stderrPreview = previewBuffer(stderrChunks)
        resolve(result)
      }

      child.on('error', (err) => {
        result.spawnError = formatError(err)
        finish()
      })

      child.on('close', (code, signal) => {
        result.exitCode = code
        result.signal = signal
        finish()
      })

      if (child.stdin) {
        child.stdin.on('error', () => {
          // Ignore EPIPE when the command doesn't read stdin.
        })
        try {
          const buf = Buffer.from(stdinPayload, 'utf-8')
          result.bytesWritten = buf.length
          child.stdin.end(buf)
        } catch {
          // If writing fails we'll still let the child finish naturally.
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

function renderTemplate(template: string, payload: NotificationPayload): string {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  const date = `${y}-${m}-${d}`
  const week = `${y}-W${String(isoWeek(now)).padStart(2, '0')}`
  const chatIdSlug = payload.chatId.replace(/[^A-Za-z0-9]/g, '_')
  return template
    .replaceAll('{date}', date)
    .replaceAll('{week}', week)
    .replaceAll('{chatId}', payload.chatId)
    .replaceAll('{chatIdSlug}', chatIdSlug)
}

function isoWeek(d: Date): number {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const dayNum = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  return Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

export { renderTemplate }
