import type { MonitorMessage, NotificationPayload } from './types.js'

export interface NotifierOptions {
  quietPeriodSec: number
  maxBufferedPerChat: number
  dispatch: (payload: NotificationPayload) => void | Promise<void>
  onError?: (err: unknown, context: string) => void
}

interface ChatBuffer {
  messages: MonitorMessage[]
  timer: NodeJS.Timeout | null
}

export class Notifier {
  private readonly opts: NotifierOptions
  private readonly buffers = new Map<string, ChatBuffer>()
  private closed = false

  constructor(opts: NotifierOptions) {
    this.opts = opts
  }

  push(message: MonitorMessage): void {
    if (this.closed) return

    if (this.opts.quietPeriodSec <= 0) {
      void this.safeDispatch(buildPayload([message]))
      return
    }

    const existing = this.buffers.get(message.chatId)
    if (existing) {
      if (existing.timer) clearTimeout(existing.timer)
      existing.messages.push(message)
      if (existing.messages.length >= this.opts.maxBufferedPerChat) {
        this.flushChatNow(message.chatId)
        return
      }
      existing.timer = this.scheduleFlush(message.chatId)
      return
    }

    const buffer: ChatBuffer = {
      messages: [message],
      timer: this.scheduleFlush(message.chatId),
    }
    this.buffers.set(message.chatId, buffer)
  }

  async flush(chatId?: string): Promise<void> {
    if (chatId !== undefined) {
      await this.flushChat(chatId)
      return
    }
    const ids = Array.from(this.buffers.keys())
    for (const id of ids) {
      await this.flushChat(id)
    }
  }

  async close(): Promise<void> {
    this.closed = true
    await this.flush()
  }

  private scheduleFlush(chatId: string): NodeJS.Timeout {
    return setTimeout(() => {
      this.flushChatNow(chatId)
    }, this.opts.quietPeriodSec * 1000)
  }

  private flushChatNow(chatId: string): void {
    void this.flushChat(chatId)
  }

  private async flushChat(chatId: string): Promise<void> {
    const buffer = this.buffers.get(chatId)
    if (!buffer) return
    if (buffer.timer) clearTimeout(buffer.timer)
    this.buffers.delete(chatId)
    if (buffer.messages.length === 0) return
    await this.safeDispatch(buildPayload(buffer.messages))
  }

  private async safeDispatch(payload: NotificationPayload): Promise<void> {
    try {
      await this.opts.dispatch(payload)
    } catch (err) {
      if (this.opts.onError) {
        this.opts.onError(err, `dispatch chat ${payload.chatId}`)
      }
    }
  }
}

function buildPayload(messages: MonitorMessage[]): NotificationPayload {
  const first = messages[0]
  const last = messages[messages.length - 1]
  const senders = new Set(messages.map((m) => m.sender))
  return {
    chatId: first.chatId,
    chatName: first.chatName ?? last.chatName,
    isGroup: first.isGroup,
    firstTimestamp: first.timestamp,
    lastTimestamp: last.timestamp,
    messageCount: messages.length,
    senderCount: senders.size,
    messages,
  }
}
