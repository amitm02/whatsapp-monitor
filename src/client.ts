import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  WASocket,
  proto,
} from '@whiskeysockets/baileys'
import pino from 'pino'
import { mkdir } from 'fs/promises'
import { readFileSync, copyFileSync, existsSync } from 'fs'
import { join } from 'path'
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

  constructor(config: MonitorConfig, options: ClientOptions = {}) {
    this.config = config
    this.verbose = options.verbose ?? false
    this.skipAllowlist = options.skipAllowlist ?? false
    this.browserName = options.browserName ?? 'whatsapp-monitor'
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

  private enqueueSaveCreds(saveCreds: () => Promise<void>, authDir: string): void {
    this.credsSaveQueue = this.credsSaveQueue
      .then(() => {
        this.backupCreds(authDir)
        return saveCreds()
      })
      .catch((err) => this.log(`Creds save error: ${err}`))
  }

  private computeBackoff(): number {
    const initial = 2000
    const max = 30000
    const factor = 1.8
    const jitter = 0.25
    const base = initial * Math.pow(factor, this.reconnectAttempts)
    const jitterMs = base * jitter * Math.random()
    return Math.min(max, Math.round(base + jitterMs))
  }

  async connect(): Promise<void> {
    await mkdir(this.config.authDir, { recursive: true })

    // Attempt to restore credentials from backup if corrupted
    this.maybeRestoreCredsFromBackup(this.config.authDir)

    const { state, saveCreds } = await useMultiFileAuthState(this.config.authDir)
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
      (this.socket.ws as unknown as { on: Function }).on('error', (err: Error) => {
        this.log(`WebSocket error: ${err.message}`)
      })
    }

    // Use queued credential saving to prevent corruption from concurrent saves
    this.socket.ev.on('creds.update', () => this.enqueueSaveCreds(saveCreds, this.config.authDir))


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
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut

        if (statusCode === DisconnectReason.loggedOut) {
          this.setConnectionState('logged_out')
        } else {
          this.setConnectionState('disconnected')
        }

        // Clean up old socket before reconnecting
        if (this.socket) {
          this.socket.end(undefined)
          this.socket = null
        }

        if (shouldReconnect) {
          this.reconnectAttempts++
          const backoffMs = this.computeBackoff()
          this.log(`Reconnecting in ${backoffMs}ms (attempt ${this.reconnectAttempts})`)
          setTimeout(() => this.connect(), backoffMs)
        }
      } else if (connection === 'open') {
        this.reconnectAttempts = 0 // Reset on successful connection
        this.setConnectionState('connected')

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
