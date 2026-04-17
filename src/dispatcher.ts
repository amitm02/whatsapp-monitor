import { spawn } from 'child_process'
import { appendFile, mkdir } from 'fs/promises'
import { dirname } from 'path'
import type { NotificationPayload } from './types.js'

export interface DispatcherOptions {
  command: string
  logFile: string
  verbose?: boolean
  onWarning?: (msg: string) => void
}

interface ChatQueue {
  promise: Promise<void>
  depth: number
}

const QUEUE_DEPTH_WARNING = 5

export class Dispatcher {
  private readonly opts: DispatcherOptions
  private readonly queues = new Map<string, ChatQueue>()
  private logReady: Promise<void> | null = null

  constructor(opts: DispatcherOptions) {
    this.opts = opts
  }

  async dispatch(payload: NotificationPayload): Promise<void> {
    const existing = this.queues.get(payload.chatId)
    const previous = existing?.promise ?? Promise.resolve()
    const depth = (existing?.depth ?? 0) + 1
    if (depth === QUEUE_DEPTH_WARNING && this.opts.onWarning) {
      this.opts.onWarning(
        `Notify queue for ${payload.chatId} has ${depth} pending dispatches; notify command may be too slow`
      )
    }
    const next = previous.then(() => this.runOne(payload)).finally(() => {
      const current = this.queues.get(payload.chatId)
      if (current && current.promise === next) {
        this.queues.delete(payload.chatId)
      }
    })
    this.queues.set(payload.chatId, { promise: next, depth })
    await next
  }

  async drain(): Promise<void> {
    const pending = Array.from(this.queues.values()).map((q) => q.promise)
    await Promise.allSettled(pending)
  }

  private async runOne(payload: NotificationPayload): Promise<void> {
    const json = JSON.stringify(payload)
    await this.appendLog(json)
    if (!this.opts.command) return
    await this.execCommand(payload, json)
  }

  private async appendLog(line: string): Promise<void> {
    if (!this.logReady) {
      this.logReady = mkdir(dirname(this.opts.logFile), { recursive: true }).then(() => undefined)
    }
    try {
      await this.logReady
      await appendFile(this.opts.logFile, line + '\n', 'utf-8')
    } catch (err) {
      if (this.opts.onWarning) {
        this.opts.onWarning(`Failed to append to notify log: ${formatError(err)}`)
      }
    }
  }

  private execCommand(payload: NotificationPayload, json: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const child = spawn('sh', ['-c', this.opts.command], {
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

      const stderrChunks: Buffer[] = []
      const stdoutChunks: Buffer[] = []
      child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk))
      child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk))

      child.on('error', (err) => {
        if (this.opts.onWarning) {
          this.opts.onWarning(`notify.command spawn failed: ${formatError(err)}`)
        }
        resolve()
      })

      child.on('close', (code, signal) => {
        if (code === 0) {
          if (this.opts.verbose && this.opts.onWarning && stdoutChunks.length > 0) {
            this.opts.onWarning(
              `notify.command stdout (chat ${payload.chatId}): ${Buffer.concat(stdoutChunks).toString('utf-8').trim()}`
            )
          }
        } else if (this.opts.onWarning) {
          const stderr = Buffer.concat(stderrChunks).toString('utf-8').trim()
          const reason = signal ? `signal ${signal}` : `exit ${code}`
          const suffix = stderr ? `: ${stderr}` : ''
          this.opts.onWarning(`notify.command failed for chat ${payload.chatId} (${reason})${suffix}`)
        }
        resolve()
      })

      if (child.stdin) {
        child.stdin.on('error', () => {
          // Ignore EPIPE when the command doesn't read stdin.
        })
        child.stdin.end(json)
      } else {
        resolve()
      }
    })
  }
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
