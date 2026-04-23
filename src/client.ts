import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  BufferJSON,
  WASocket,
  proto,
} from '@whiskeysockets/baileys'
import pino from 'pino'
import { mkdir, open, rename, rm, chmod } from 'fs/promises'
import { readFileSync, copyFileSync, existsSync } from 'fs'
import { randomUUID } from 'crypto'
import { join, dirname } from 'path'
import { Boom } from '@hapi/boom'
import type {
  MonitorConfig,
  GroupInfo,
  ContactInfo,
  GroupMetadata,
  MonitorMessage,
  MessageCallback,
  ConnectionCallback,
  QRCallback,
  ConnectionState,
  MessageType,
  HistorySyncData,
  HistorySyncCallback,
  RawHistorySyncData,
  RawHistorySyncCallback,
  RawEventCallback,
  MessageUpdateData,
  MessageUpdateCallback,
  MessageDeleteData,
  MessageDeleteCallback,
  ContactChangeData,
  ContactChangeCallback,
  ReadyCallback,
  ActivityCallback,
} from './types.js'
import { isAllowed } from './config.js'
import { createDedupeCache, type DedupeCache } from './dedupe.js'

export interface ClientOptions {
  verbose?: boolean
  skipAllowlist?: boolean
  browserName?: string
  /**
   * Watchdog: if no event is received from WhatsApp within this many ms
   * while the socket reports connected, force a reconnect. 0 disables.
   * Default 10 minutes.
   */
  activityWatchdogMs?: number
}

function describeDisconnect(statusCode: number | undefined): string {
  if (statusCode == null) return 'unknown'
  if (statusCode === 440) return `streamConflict(440)`
  const reason = (DisconnectReason as unknown as Record<string, number>)
  for (const [name, code] of Object.entries(reason)) {
    if (code === statusCode) return `${name}(${statusCode})`
  }
  return `status=${statusCode}`
}

/**
 * Status codes we treat as terminal (no reconnect). Matches OpenClaw's
 * non-retryable list: 440 = "Unknown Stream Errored (conflict)" — another
 * linked device has taken over the session. Reconnecting just rotates the
 * winner; the operator has to close the competing WhatsApp Web session.
 */
function isNonRetryableStatus(statusCode: number | undefined): boolean {
  return statusCode === 440
}

/**
 * Atomic creds.json write. Writes to a temp file, fsyncs the file, renames
 * it over the target (atomic on POSIX), then fsyncs the directory. This
 * protects against mid-write crashes — if the process dies, creds.json is
 * either the old valid content or the new valid content, never truncated.
 *
 * Baileys' default multi-file auth state uses a plain writeFile which can
 * leave creds.json half-written if the process is killed at the wrong
 * moment. That matters because creds.json is the one file that can't be
 * regenerated without a full re-link (QR scan).
 */
async function writeCredsAtomically(authDir: string, creds: unknown): Promise<void> {
  const credsPath = join(authDir, 'creds.json')
  const tempPath = join(authDir, `.creds.${process.pid}.${randomUUID()}.tmp`)
  const json = JSON.stringify(creds, BufferJSON.replacer)
  const FILE_MODE = 0o600

  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(tempPath, 'w', FILE_MODE)
    await handle.writeFile(json, { encoding: 'utf-8' })
    await handle.sync()
    await handle.close()
    handle = undefined

    await rename(tempPath, credsPath)
    await chmod(credsPath, FILE_MODE).catch(() => {
      // best-effort on platforms that don't support chmod
    })

    // fsync the directory so the rename is durable.
    let dirHandle: Awaited<ReturnType<typeof open>> | undefined
    try {
      dirHandle = await open(dirname(credsPath), 'r')
      await dirHandle.sync()
    } catch {
      // directory fsync not supported on some platforms (e.g. Windows) — best-effort
    } finally {
      await dirHandle?.close().catch(() => {})
    }
  } catch (err) {
    await handle?.close().catch(() => {})
    await rm(tempPath, { force: true }).catch(() => {})
    throw err
  }
}

function formatErr(err: unknown): string {
  if (!err) return String(err)
  if (typeof err === 'string') return err
  if (typeof err !== 'object') return String(err)

  // Extract Boom payload if present — Baileys wraps disconnect errors in
  // Boom, so `err.output.payload.{error,message}` has the WhatsApp-server-
  // level reason that's more useful than the generic err.message.
  const e = err as {
    name?: unknown
    message?: unknown
    code?: unknown
    output?: { statusCode?: unknown; payload?: { error?: unknown; message?: unknown } }
  }
  const status = typeof e.output?.statusCode === 'number' ? e.output.statusCode : undefined
  const payloadError = typeof e.output?.payload?.error === 'string' ? e.output.payload.error : undefined
  const payloadMsg = typeof e.output?.payload?.message === 'string' ? e.output.payload.message : undefined
  const message = typeof e.message === 'string' ? e.message : undefined
  const codeText = typeof e.code === 'string' || typeof e.code === 'number' ? String(e.code) : undefined

  const parts: string[] = []
  if (status != null) parts.push(`status=${status}`)
  if (payloadError) parts.push(payloadError)
  if (payloadMsg && payloadMsg !== payloadError) parts.push(payloadMsg)
  if (message && message !== payloadMsg && message !== payloadError) parts.push(message)
  if (codeText) parts.push(`code=${codeText}`)

  if (parts.length > 0) return parts.join(' ')
  if (err instanceof Error) return `${err.name}: ${err.message}`
  return String(err)
}

// Store original console methods for libsignal noise suppression
const originalConsoleLog = console.log
const originalConsoleInfo = console.info
const originalConsoleError = console.error
let suppressLibsignalNoise = true

// Suppress libsignal's "Closing session" spam (can come via console.log or console.info)
console.log = (...args: unknown[]) => {
  if (suppressLibsignalNoise && typeof args[0] === 'string' && args[0].includes('Closing session')) {
    return
  }
  originalConsoleLog.apply(console, args)
}

console.info = (...args: unknown[]) => {
  if (suppressLibsignalNoise && typeof args[0] === 'string' && args[0].includes('Closing session')) {
    return
  }
  originalConsoleInfo.apply(console, args)
}

// Suppress libsignal's "Bad MAC" / "Failed to decrypt" console.error spam
console.error = (...args: unknown[]) => {
  if (suppressLibsignalNoise) {
    const msg = String(args[0])
    if (msg.includes('Failed to decrypt message') || msg.includes('Session error')) {
      return
    }
  }
  originalConsoleError.apply(console, args)
}

export function setLibsignalNoiseSupression(suppress: boolean): void {
  suppressLibsignalNoise = suppress
}

export class WhatsAppMonitor {
  private socket: WASocket | null = null
  private config: MonitorConfig
  private messageCallbacks: MessageCallback[] = []
  private connectionCallbacks: ConnectionCallback[] = []
  private qrCallbacks: QRCallback[] = []
  private historySyncCallbacks: HistorySyncCallback[] = []
  private rawHistorySyncCallbacks: RawHistorySyncCallback[] = []
  private rawEventCallbacks: RawEventCallback[] = []
  private messageUpdateCallbacks: MessageUpdateCallback[] = []
  private messageDeleteCallbacks: MessageDeleteCallback[] = []
  private contactChangeCallbacks: ContactChangeCallback[] = []
  private readyCallbacks: ReadyCallback[] = []
  private activityCallbacks: ActivityCallback[] = []
  private connectionState: ConnectionState = 'disconnected'
  private contacts: Map<string, ContactInfo> = new Map()
  private verbose: boolean = false
  private skipAllowlist: boolean = false
  private syncResolvers: Array<() => void> = []
  private hasSynced: boolean = false
  private credsSaveQueue: Promise<void> = Promise.resolve()
  private reconnectAttempts: number = 0
  private dedupeCache: DedupeCache
  private browserName: string
  private activityWatchdogMs: number
  private lastActivityAt: number = Date.now()
  private watchdogTimer: NodeJS.Timeout | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private reconnecting: boolean = false

  constructor(config: MonitorConfig, options: ClientOptions = {}) {
    this.config = config
    this.verbose = options.verbose ?? false
    this.skipAllowlist = options.skipAllowlist ?? false
    this.browserName = options.browserName ?? 'whatsapp-monitor'
    this.activityWatchdogMs = options.activityWatchdogMs ?? 10 * 60 * 1000
    // When verbose, show libsignal noise (Bad MAC errors, etc.)
    suppressLibsignalNoise = !this.verbose
    // Initialize dedupe cache (20 minute TTL, max 5000 messages)
    this.dedupeCache = createDedupeCache({ ttlMs: 20 * 60 * 1000, maxSize: 5000 })
  }

  private log(message: string): void {
    if (this.verbose) {
      console.error(`[DEBUG] ${new Date().toISOString()} - ${message}`)
    }
  }

  /** Always-on info-level logging (visible without --verbose). */
  private info(message: string): void {
    console.error(`[wa-monitor ${new Date().toISOString()}] ${message}`)
  }

  /** Returns ms since the last event from WhatsApp (any event, not just messages). */
  getIdleMs(): number {
    return Date.now() - this.lastActivityAt
  }

  getLastActivityAt(): number {
    return this.lastActivityAt
  }

  getReconnectAttempts(): number {
    return this.reconnectAttempts
  }

  private shouldFilter(chatId: string): boolean {
    if (this.skipAllowlist) return false
    return !isAllowed(chatId, this.config)
  }

  private maybeRestoreCredsFromBackup(authDir: string): void {
    const credsPath = join(authDir, 'creds.json')
    const backupPath = join(authDir, 'creds.json.bak')

    if (existsSync(credsPath)) {
      try {
        const raw = readFileSync(credsPath, 'utf-8')
        JSON.parse(raw)
        return // Creds valid, no restore needed
      } catch {
        this.log('creds.json is corrupted, attempting restore from backup')
      }
    }

    if (existsSync(backupPath)) {
      try {
        const backupRaw = readFileSync(backupPath, 'utf-8')
        JSON.parse(backupRaw) // Validate backup is valid JSON
        copyFileSync(backupPath, credsPath)
        this.log('Restored creds.json from backup')
      } catch {
        this.log('Backup creds.json.bak is also invalid')
      }
    }
  }

  private backupCreds(authDir: string): void {
    const credsPath = join(authDir, 'creds.json')
    const backupPath = join(authDir, 'creds.json.bak')

    try {
      if (!existsSync(credsPath)) return
      const raw = readFileSync(credsPath, 'utf-8')
      JSON.parse(raw) // Validate before backup
      copyFileSync(credsPath, backupPath)
    } catch {
      // Keep existing backup if current creds invalid
    }
  }

  private enqueueSaveCreds(creds: unknown, authDir: string): void {
    this.credsSaveQueue = this.credsSaveQueue
      .then(async () => {
        // Backup-before-write protects against the case where the in-flight
        // atomic write's temp-file creation itself fails (very rare) — the
        // previous .bak stays valid as a last-resort recovery source.
        this.backupCreds(authDir)
        try {
          await writeCredsAtomically(authDir, creds)
        } catch (err) {
          this.info(`creds save failed: ${formatErr(err)}`)
          throw err
        }
      })
      .catch(() => {
        // Swallow — we logged above. Don't poison the queue with a rejected
        // promise, or the next enqueue .then() chain inherits the rejection.
      })
  }

  private computeBackoff(): number {
    const initial = 2000
    const max = 30000
    const factor = 1.8
    const jitter = 0.25
    // Clamp attempts so Math.pow can't overflow and backoff always stabilizes at `max`.
    const attempts = Math.min(this.reconnectAttempts, 10)
    const base = initial * Math.pow(factor, attempts)
    const jitterMs = base * jitter * Math.random()
    return Math.min(max, Math.round(base + jitterMs))
  }

  private markActivity(): void {
    this.lastActivityAt = Date.now()
  }

  private startWatchdog(): void {
    if (this.watchdogTimer || this.activityWatchdogMs <= 0) return
    const intervalMs = Math.max(30_000, Math.floor(this.activityWatchdogMs / 4))
    this.watchdogTimer = setInterval(() => {
      // Only act if we believe we're connected. During connect/reconnect, the
      // `connection.update` handler owns reconnect scheduling.
      if (this.connectionState !== 'connected') return
      const idle = this.getIdleMs()
      if (idle >= this.activityWatchdogMs) {
        this.info(`watchdog: no WhatsApp events for ${Math.round(idle / 1000)}s while state=connected — forcing reconnect`)
        this.forceReconnect('watchdog-idle')
      }
    }, intervalMs)
    // Keep timer from preventing process exit if it somehow outlives the service.
    if (this.watchdogTimer.unref) this.watchdogTimer.unref()
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer)
      this.watchdogTimer = null
    }
  }

  private forceReconnect(reason: string): void {
    if (this.reconnecting) return
    this.reconnecting = true
    this.info(`reconnect: tearing down socket (reason=${reason})`)
    try {
      this.socket?.end(new Error(`force-reconnect: ${reason}`))
    } catch (err) {
      this.info(`reconnect: socket.end threw: ${formatErr(err)}`)
    }
    this.socket = null
    this.setConnectionState('disconnected')
    this.reconnectAttempts++
    const backoffMs = this.computeBackoff()
    this.info(`reconnect: scheduled in ${backoffMs}ms (attempt ${this.reconnectAttempts}, reason=${reason})`)
    this.scheduleReconnect(backoffMs)
  }

  private scheduleReconnect(delayMs: number): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.reconnecting = false
      this.connect().catch((err) => {
        this.info(`reconnect: connect() threw: ${formatErr(err)} — retrying in ${this.computeBackoff()}ms`)
        this.reconnectAttempts++
        this.scheduleReconnect(this.computeBackoff())
      })
    }, delayMs)
    if (this.reconnectTimer.unref) this.reconnectTimer.unref()
  }

  async connect(): Promise<void> {
    await mkdir(this.config.authDir, { recursive: true })

    // Attempt to restore credentials from backup if corrupted
    this.maybeRestoreCredsFromBackup(this.config.authDir)

    const { state } = await useMultiFileAuthState(this.config.authDir)
    const { version } = await fetchLatestBaileysVersion()
    this.log(`connect: using Baileys version ${version.join('.')}`)

    this.setConnectionState('connecting')

    this.socket = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
      },
      browser: [this.browserName, 'Chrome', '120.0.0'],
      printQRInTerminal: false,
      logger: pino({ level: this.verbose ? 'debug' : 'silent' }),
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      shouldSyncHistoryMessage: () => true,
    })

    // Add WebSocket error handler to prevent crashes
    if (this.socket.ws && typeof (this.socket.ws as unknown as { on?: Function }).on === 'function') {
      const ws = this.socket.ws as unknown as { on: Function }
      ws.on('error', (err: Error) => {
        this.info(`websocket error: ${err.message}`)
      })
      ws.on('close', (code: number, reason: Buffer | string) => {
        const reasonStr = Buffer.isBuffer(reason) ? reason.toString('utf-8') : String(reason ?? '')
        this.log(`websocket closed: code=${code} reason="${reasonStr}"`)
      })
    }

    // Use queued, atomic credential saving. Baileys' default saveCreds uses a
    // plain writeFile which can truncate creds.json on an abrupt crash; we
    // replace it with a temp-file+fsync+rename path instead.
    this.socket.ev.on('creds.update', () => this.enqueueSaveCreds(state.creds, this.config.authDir))


    this.socket.ev.on('connection.update', (update) => {
      this.emitRawEvent('connection.update', update)
      const { connection, lastDisconnect, qr, isOnline } = update

      if (qr) {
        this.qrCallbacks.forEach((cb) => cb(qr))
      }

      if (connection) {
        this.log(`connection.update: state=${connection}`)
      }

      // isOnline is emitted when sync completes and client goes online
      if (isOnline !== undefined) {
        this.log(`connection.update: isOnline=${isOnline}`)
        if (isOnline && !this.hasSynced) {
          // Sync completed (or was skipped), resolve waiters
          this.log('connection.update: sync completed (isOnline=true)')
          this.hasSynced = true
          this.syncResolvers.forEach((resolve) => resolve())
          this.syncResolvers = []

          // Fire ready callbacks
          this.log('connection.update: firing ready callbacks')
          this.readyCallbacks.forEach((cb) => cb())
        }
      }

      if (connection === 'close') {
        const err = lastDisconnect?.error as Boom | Error | undefined
        const statusCode = (err as Boom)?.output?.statusCode
        const errMsg = err ? formatErr(err) : 'no error provided'
        const reasonLabel = describeDisconnect(statusCode)
        const loggedOut = statusCode === DisconnectReason.loggedOut
        const nonRetryable = isNonRetryableStatus(statusCode)
        const shouldReconnect = !loggedOut && !nonRetryable

        this.info(`connection closed: reason=${reasonLabel} error="${errMsg}" willReconnect=${shouldReconnect}`)

        if (loggedOut) {
          this.setConnectionState('logged_out')
          this.stopWatchdog()
        } else if (nonRetryable) {
          this.setConnectionState('conflict')
          this.stopWatchdog()
        } else {
          this.setConnectionState('disconnected')
        }

        // Clean up old socket before reconnecting
        if (this.socket) {
          try {
            this.socket.end(undefined)
          } catch (e) {
            this.info(`socket.end during close threw: ${formatErr(e)}`)
          }
          this.socket = null
        }

        if (shouldReconnect) {
          this.reconnectAttempts++
          const backoffMs = this.computeBackoff()
          this.info(`reconnect: scheduled in ${backoffMs}ms (attempt ${this.reconnectAttempts}, reason=${reasonLabel})`)
          this.reconnecting = false
          this.scheduleReconnect(backoffMs)
        } else if (loggedOut) {
          this.info('not reconnecting: session logged out — re-link with `whatsapp-monitor link`')
        } else {
          // 440 stream conflict — another linked device grabbed the session.
          this.info(
            'not reconnecting: session conflict (status 440). Another WhatsApp Web device has taken over this session. ' +
              'Close the competing WhatsApp Web session (browser/desktop app/other linked device), then restart this service.'
          )
        }
      } else if (connection === 'open') {
        if (this.reconnectAttempts > 0) {
          this.info(`connection open: recovered after ${this.reconnectAttempts} reconnect attempt(s)`)
        } else {
          this.info('connection open')
        }
        this.reconnectAttempts = 0 // Reset on successful connection
        this.reconnecting = false
        this.markActivity()
        this.setConnectionState('connected')
        this.startWatchdog()

        // Fallback: if no sync events within 5 seconds, consider ready
        // This handles reconnection cases where Baileys skips sync
        setTimeout(() => {
          if (!this.hasSynced) {
            this.log('connection.update: no sync events received, marking ready')
            this.hasSynced = true
            this.syncResolvers.forEach((resolve) => resolve())
            this.syncResolvers = []
            this.readyCallbacks.forEach((cb) => cb())
          }
        }, 5000)
      } else if (connection === 'connecting') {
        this.info('connection: connecting...')
      }
    })

    this.socket.ev.on('messages.upsert', async ({ messages, type }) => {
      this.emitRawEvent('messages.upsert', { messages, type })
      this.emitActivity()

      for (const msg of messages) {
        const chatId = msg.key.remoteJid
        const messageId = msg.key.id
        if (!chatId || !messageId) continue

        // Update contact pushName from incoming messages
        const senderId = msg.key.participant || chatId
        if (msg.pushName && senderId.endsWith('@s.whatsapp.net')) {
          const existing = this.contacts.get(senderId)
          if (existing) {
            this.contacts.set(senderId, { ...existing, pushName: msg.pushName })
          } else {
            this.contacts.set(senderId, { id: senderId, pushName: msg.pushName })
          }
        }

        // Filter based on allowlist (unless skipAllowlist is set)
        if (this.shouldFilter(chatId)) continue

        // Dedupe check: skip if we've seen this message recently
        // (placed after allowlist to avoid caching messages we don't care about)
        const dedupeKey = `${chatId}:${messageId}`
        if (this.dedupeCache.check(dedupeKey)) {
          this.log(`Skipping duplicate message: ${dedupeKey}`)
          continue
        }

        const upsertType = type === 'notify' || type === 'append' ? type : 'unknown'
        const monitorMsg = await this.parseMessage(msg, upsertType)
        if (monitorMsg) {
          this.messageCallbacks.forEach((cb) => cb(monitorMsg))
        }
      }
    })

    this.socket.ev.on('messages.update', (updates) => {
      this.emitRawEvent('messages.update', updates)
      for (const update of updates) {
        const chatId = update.key?.remoteJid
        const messageId = update.key?.id
        if (!chatId || !messageId) continue
        if (this.shouldFilter(chatId)) continue

        const statusLabels: Record<number, string> = {
          0: 'error',
          1: 'pending',
          2: 'server_ack',
          3: 'delivery_ack',
          4: 'read',
          5: 'played',
        }

        const status = update.update?.status
        const editedConversation = update.update?.message?.protocolMessage?.editedMessage?.conversation
        const editedExtended = update.update?.message?.protocolMessage?.editedMessage?.extendedTextMessage?.text

        const data: MessageUpdateData = {
          messageId,
          chatId,
          status: status ?? undefined,
          statusLabel: status != null ? statusLabels[status] : undefined,
          editedText: editedConversation ?? editedExtended ?? undefined,
          editTimestamp: update.update?.messageTimestamp ? Number(update.update.messageTimestamp) * 1000 : undefined,
        }
        this.messageUpdateCallbacks.forEach((cb) => cb(data))
      }
    })

    this.socket.ev.on('messages.media-update', (updates) => {
      this.emitRawEvent('messages.media-update', updates)
    })

    this.socket.ev.on('messages.delete', (data) => {
      this.emitRawEvent('messages.delete', data)
      // Handle both single delete and batch delete formats
      if ('keys' in data && Array.isArray(data.keys)) {
        // Batch delete: { keys: WAMessageKey[] }
        const grouped = new Map<string, string[]>()
        for (const key of data.keys) {
          const chatId = key.remoteJid
          const messageId = key.id
          if (!chatId || !messageId) continue
          if (this.shouldFilter(chatId)) continue
          if (!grouped.has(chatId)) {
            grouped.set(chatId, [])
          }
          grouped.get(chatId)!.push(messageId)
        }
        for (const [chatId, messageIds] of grouped) {
          const deleteData: MessageDeleteData = {
            chatId,
            messageIds,
            isRevoke: true,
          }
          this.messageDeleteCallbacks.forEach((cb) => cb(deleteData))
        }
      } else if ('jid' in data && 'all' in data) {
        // Clear chat: { jid: string, all: true }
        const chatId = (data as { jid: string }).jid
        if (this.shouldFilter(chatId)) return
        const deleteData: MessageDeleteData = {
          chatId,
          messageIds: [],
          isRevoke: false,
        }
        this.messageDeleteCallbacks.forEach((cb) => cb(deleteData))
      }
    })

    this.socket.ev.on('contacts.upsert', (contacts) => {
      this.emitRawEvent('contacts.upsert', contacts)
      this.log(`contacts.upsert: received ${contacts.length} contacts`)
      for (const contact of contacts) {
        const id = contact.id
        if (!id || !id.endsWith('@s.whatsapp.net')) continue

        this.contacts.set(id, {
          id,
          name: contact.name || contact.notify || contact.verifiedName,
          pushName: contact.notify,
        })

        const changeData: ContactChangeData = {
          contactId: id,
          name: contact.name || contact.verifiedName,
          pushName: contact.notify,
          changeType: 'upsert',
        }
        this.contactChangeCallbacks.forEach((cb) => cb(changeData))
      }
    })

    this.socket.ev.on('contacts.update', (updates) => {
      this.emitRawEvent('contacts.update', updates)
      this.log(`contacts.update: received ${updates.length} updates`)
      for (const update of updates) {
        const id = update.id
        if (!id) continue

        const existing = this.contacts.get(id)
        if (existing) {
          this.contacts.set(id, {
            ...existing,
            name: update.name ?? existing.name,
            pushName: update.notify ?? existing.pushName,
          })
        } else if (id.endsWith('@s.whatsapp.net')) {
          // Create new contact entry if it has useful info
          if (update.name || update.notify) {
            this.contacts.set(id, {
              id,
              name: update.name,
              pushName: update.notify,
            })
          }
        }

        const changeData: ContactChangeData = {
          contactId: id,
          name: update.name,
          pushName: update.notify,
          changeType: 'update',
        }
        this.contactChangeCallbacks.forEach((cb) => cb(changeData))
      }
    })

    this.socket.ev.on('messaging-history.set', (data) => {
      this.emitRawEvent('messaging-history.set', data)
      const { chats, contacts, messages, syncType, progress, isLatest } = data
      this.log(`messaging-history.set: syncType=${syncType}, progress=${progress}, isLatest=${isLatest}, received ${chats.length} chats, ${contacts.length} contacts, ${messages.length} messages`)

      // Invoke raw history sync callbacks first (unfiltered, untransformed)
      const rawData: RawHistorySyncData = {
        chats,
        contacts,
        messages,
        syncType,
        progress,
        isLatest,
      }
      this.rawHistorySyncCallbacks.forEach((cb) => cb(rawData))

      // Store contacts from history sync (merge with existing to preserve push names)
      for (const contact of contacts) {
        if (!contact.id || !contact.id.endsWith('@s.whatsapp.net')) continue
        const existing = this.contacts.get(contact.id)
        this.contacts.set(contact.id, {
          id: contact.id,
          name: contact.name || contact.notify || contact.verifiedName || existing?.name,
          pushName: contact.notify || existing?.pushName,
        })
      }

      // Invoke history sync callbacks with transformed data
      const syncData: HistorySyncData = {
        syncType: syncType ?? 0,
        chats: chats
          .filter((c) => c.id)
          .map((c) => ({
            id: c.id!,
            lastMessageTimestamp: c.lastMessageRecvTimestamp ?? undefined,
          })),
        contacts: contacts
          .filter((c) => c.id)
          .map((c) => ({
            id: c.id!,
            name: c.name || c.verifiedName,
            pushName: c.notify,
          })),
      }
      this.historySyncCallbacks.forEach((cb) => cb(syncData))

      // Notify sync waiters and fire ready callbacks (if not already done by isOnline)
      if (!this.hasSynced) {
        this.log('messaging-history.set: sync completed')
        this.hasSynced = true
        this.syncResolvers.forEach((resolve) => resolve())
        this.syncResolvers = []

        // Fire ready callbacks
        this.log('messaging-history.set: firing ready callbacks')
        this.readyCallbacks.forEach((cb) => cb())
      }

    })
  }

  async disconnect(): Promise<void> {
    this.stopWatchdog()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.socket) {
      this.socket.end(undefined)
      this.socket = null
      this.setConnectionState('disconnected')
    }
  }

  async requestPairingCode(phoneNumber: string): Promise<string> {
    if (!this.socket) {
      throw new Error('Not connected')
    }
    return await this.socket.requestPairingCode(phoneNumber)
  }

  async listGroups(): Promise<GroupInfo[]> {
    if (!this.socket) {
      throw new Error('Not connected')
    }

    const groups: GroupInfo[] = []

    // Use direct API to fetch all groups with full metadata
    const groupsData = await this.socket.groupFetchAllParticipating()
    for (const [id, metadata] of Object.entries(groupsData)) {
      groups.push({
        id,
        name: metadata.subject || '(No name)',
        participantCount: metadata.participants.length,
      })
    }

    this.log(`listGroups: found ${groups.length} groups`)

    // Sort alphabetically by name
    return groups.sort((a, b) => a.name.localeCompare(b.name))
  }

  async getGroupMetadata(groupId: string): Promise<GroupMetadata> {
    if (!this.socket) {
      throw new Error('Not connected')
    }

    const metadata = await this.socket.groupMetadata(groupId)

    return {
      id: metadata.id,
      subject: metadata.subject,
      owner: metadata.owner,
      creation: metadata.creation,
      description: metadata.desc,
      participants: metadata.participants.map((p) => ({
        id: p.id,
        admin: p.admin,
      })),
    }
  }

  async getRecentMessages(chatId: string, limit: number = 50): Promise<MonitorMessage[]> {
    if (!this.socket) {
      throw new Error('Not connected')
    }

    // Check allowlist
    if (!isAllowed(chatId, this.config)) {
      throw new Error('Chat is not in allowlist')
    }

    const messages: MonitorMessage[] = []

    // Use store to fetch messages - this requires message history sync
    // For now, we'll return an empty array with a note that real-time monitoring is preferred
    // Baileys doesn't provide a straightforward way to fetch message history without store

    return messages
  }

  onMessage(callback: MessageCallback): () => void {
    this.messageCallbacks.push(callback)
    return () => {
      this.messageCallbacks = this.messageCallbacks.filter((cb) => cb !== callback)
    }
  }

  onConnection(callback: ConnectionCallback): () => void {
    this.connectionCallbacks.push(callback)
    return () => {
      this.connectionCallbacks = this.connectionCallbacks.filter((cb) => cb !== callback)
    }
  }

  onQR(callback: QRCallback): () => void {
    this.qrCallbacks.push(callback)
    return () => {
      this.qrCallbacks = this.qrCallbacks.filter((cb) => cb !== callback)
    }
  }

  onHistorySync(callback: HistorySyncCallback): () => void {
    this.historySyncCallbacks.push(callback)
    return () => {
      this.historySyncCallbacks = this.historySyncCallbacks.filter((cb) => cb !== callback)
    }
  }

  onRawHistorySync(callback: RawHistorySyncCallback): () => void {
    this.rawHistorySyncCallbacks.push(callback)
    return () => {
      this.rawHistorySyncCallbacks = this.rawHistorySyncCallbacks.filter((cb) => cb !== callback)
    }
  }

  onRawEvent(callback: RawEventCallback): () => void {
    this.rawEventCallbacks.push(callback)
    return () => {
      this.rawEventCallbacks = this.rawEventCallbacks.filter((cb) => cb !== callback)
    }
  }

  onMessageUpdate(callback: MessageUpdateCallback): () => void {
    this.messageUpdateCallbacks.push(callback)
    return () => {
      this.messageUpdateCallbacks = this.messageUpdateCallbacks.filter((cb) => cb !== callback)
    }
  }

  onMessageDelete(callback: MessageDeleteCallback): () => void {
    this.messageDeleteCallbacks.push(callback)
    return () => {
      this.messageDeleteCallbacks = this.messageDeleteCallbacks.filter((cb) => cb !== callback)
    }
  }

  onContactChange(callback: ContactChangeCallback): () => void {
    this.contactChangeCallbacks.push(callback)
    return () => {
      this.contactChangeCallbacks = this.contactChangeCallbacks.filter((cb) => cb !== callback)
    }
  }

  onReady(callback: ReadyCallback): () => void {
    this.readyCallbacks.push(callback)
    return () => {
      this.readyCallbacks = this.readyCallbacks.filter((cb) => cb !== callback)
    }
  }

  onActivity(callback: ActivityCallback): () => void {
    this.activityCallbacks.push(callback)
    return () => {
      this.activityCallbacks = this.activityCallbacks.filter((cb) => cb !== callback)
    }
  }

  private emitActivity(): void {
    this.activityCallbacks.forEach((cb) => cb())
  }

  private emitRawEvent(event: string, data: unknown): void {
    // Every Baileys event counts as liveness — this is the watchdog's signal.
    this.markActivity()
    this.rawEventCallbacks.forEach((cb) => cb(event, data))
  }

  getConnectionState(): ConnectionState {
    return this.connectionState
  }

  isConnected(): boolean {
    return this.connectionState === 'connected'
  }

  waitForSync(timeoutMs: number = 120000): Promise<void> {
    if (this.hasSynced) {
      this.log('waitForSync: already synced')
      return Promise.resolve()
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.log('waitForSync: timeout reached')
        this.syncResolvers = this.syncResolvers.filter((r) => r !== resolve)
        resolve()
      }, timeoutMs)

      const wrappedResolve = () => {
        clearTimeout(timeout)
        this.log('waitForSync: sync completed')
        resolve()
      }

      this.syncResolvers.push(wrappedResolve)
    })
  }

  private setConnectionState(state: ConnectionState): void {
    this.connectionState = state
    this.connectionCallbacks.forEach((cb) => cb(state))
  }

  private async parseMessage(msg: proto.IWebMessageInfo, upsertType: 'notify' | 'append' | 'unknown' = 'unknown'): Promise<MonitorMessage | null> {
    const chatId = msg.key.remoteJid
    if (!chatId) return null

    const isGroup = chatId.endsWith('@g.us')
    const sender = isGroup ? msg.key.participant || '' : chatId
    const timestamp = Number(msg.messageTimestamp) * 1000

    const { text, type } = this.extractMessageContent(msg.message)

    let chatName: string | undefined
    if (isGroup && this.socket) {
      try {
        const metadata = await this.socket.groupMetadata(chatId)
        chatName = metadata.subject
      } catch {
        // Ignore errors fetching group metadata
      }
    }

    let quotedMessage: MonitorMessage['quotedMessage']
    const contextInfo = this.getContextInfo(msg.message)
    if (contextInfo?.quotedMessage) {
      const quotedContent = this.extractMessageContent(contextInfo.quotedMessage)
      quotedMessage = {
        id: contextInfo.stanzaId || '',
        sender: contextInfo.participant || '',
        text: quotedContent.text,
      }
    }

    return {
      id: msg.key.id || '',
      chatId,
      chatName,
      sender,
      senderName: msg.pushName || undefined,
      timestamp,
      text,
      type,
      upsertType,
      isGroup,
      quotedMessage,
      rawMessage: msg,
    }
  }

  private extractMessageContent(
    message: proto.IMessage | null | undefined
  ): { text?: string; type: MessageType } {
    if (!message) {
      return { type: 'unknown' }
    }

    if (message.conversation) {
      return { text: message.conversation, type: 'text' }
    }

    if (message.extendedTextMessage) {
      return { text: message.extendedTextMessage.text || undefined, type: 'text' }
    }

    if (message.imageMessage) {
      return { text: message.imageMessage.caption || undefined, type: 'image' }
    }

    if (message.videoMessage) {
      return { text: message.videoMessage.caption || undefined, type: 'video' }
    }

    if (message.audioMessage) {
      return { type: 'audio' }
    }

    if (message.documentMessage) {
      return { text: message.documentMessage.fileName || undefined, type: 'document' }
    }

    if (message.stickerMessage) {
      return { type: 'sticker' }
    }

    if (message.reactionMessage) {
      return { text: message.reactionMessage.text || undefined, type: 'reaction' }
    }

    if (message.pollCreationMessage || message.pollCreationMessageV2 || message.pollCreationMessageV3) {
      const poll = message.pollCreationMessage || message.pollCreationMessageV2 || message.pollCreationMessageV3
      return { text: poll?.name || undefined, type: 'poll' }
    }

    if (message.locationMessage) {
      return { type: 'location' }
    }

    if (message.contactMessage || message.contactsArrayMessage) {
      return { type: 'contact' }
    }

    return { type: 'unknown' }
  }

  private getContextInfo(
    message: proto.IMessage | null | undefined
  ): proto.IContextInfo | null | undefined {
    if (!message) return null

    return (
      message.extendedTextMessage?.contextInfo ||
      message.imageMessage?.contextInfo ||
      message.videoMessage?.contextInfo ||
      message.audioMessage?.contextInfo ||
      message.documentMessage?.contextInfo ||
      null
    )
  }
}
