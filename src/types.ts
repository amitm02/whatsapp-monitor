import type { proto } from '@whiskeysockets/baileys'

export interface NotifyConfig {
  command?: string
  kind?: 'openclaw-agent'
  agent?: string
  sessionIdTemplate?: string
  behaviorFile?: string
  quietPeriodSec?: number
  timeoutSec?: number
  logFile?: string
  maxBufferedPerChat?: number
}

export interface ResolvedNotifyBase {
  quietPeriodSec: number
  timeoutSec: number
  logFile: string
  maxBufferedPerChat: number
}

export interface ResolvedNotifyCommand extends ResolvedNotifyBase {
  mode: 'command'
  command: string
}

export interface ResolvedNotifyOpenClaw extends ResolvedNotifyBase {
  mode: 'openclaw-agent'
  agent: string
  sessionIdTemplate: string
  behaviorFile: string
}

export interface ResolvedNotifyDisabled extends ResolvedNotifyBase {
  mode: 'disabled'
}

export type ResolvedNotify = ResolvedNotifyCommand | ResolvedNotifyOpenClaw | ResolvedNotifyDisabled

export interface MonitorConfig {
  allowedGroups: string[]
  allowedContacts: string[]
  authDir: string
  notify?: NotifyConfig
}

export interface NotificationPayload {
  chatId: string
  chatName?: string
  isGroup: boolean
  firstTimestamp: number
  lastTimestamp: number
  messageCount: number
  senderCount: number
  messages: MonitorMessage[]
}

export interface GroupInfo {
  id: string
  name: string
  participantCount: number
}

export interface ContactInfo {
  id: string
  name?: string
  pushName?: string
  lastMessageTimestamp?: number
}

export interface GroupMetadata {
  id: string
  subject: string
  owner?: string
  creation?: number
  participants: Participant[]
  description?: string
}

export interface Participant {
  id: string
  admin?: 'admin' | 'superadmin' | null
}

export interface MonitorMessage {
  id: string
  chatId: string
  chatName?: string
  sender: string
  senderName?: string
  timestamp: number
  text?: string
  type: MessageType
  upsertType: 'notify' | 'append' | 'unknown'
  isGroup: boolean
  quotedMessage?: QuotedMessage
  rawMessage?: unknown
}

export interface QuotedMessage {
  id: string
  sender: string
  text?: string
}

export type MessageType =
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'document'
  | 'sticker'
  | 'reaction'
  | 'poll'
  | 'location'
  | 'contact'
  | 'unknown'

export type MessageCallback = (message: MonitorMessage) => void

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'logged_out'

export type ConnectionCallback = (state: ConnectionState) => void

export type QRCallback = (qr: string) => void

export interface HistorySyncData {
  syncType: number
  chats: Array<{ id: string; lastMessageTimestamp?: number }>
  contacts: Array<{ id: string; name?: string; pushName?: string }>
}

export type HistorySyncCallback = (data: HistorySyncData) => void

// Raw history sync data directly from Baileys
export interface RawHistorySyncData {
  chats: unknown[]
  contacts: unknown[]
  messages: unknown[]
  syncType?: number
  progress?: number | null
  isLatest?: boolean
}

export type RawHistorySyncCallback = (data: RawHistorySyncData) => void

export type RawEventCallback = (event: string, data: unknown) => void

// Message update event data
export interface MessageUpdateData {
  messageId: string
  chatId: string
  status?: number // WAMessageStatus enum value
  statusLabel?: string // Human-readable status
  editedText?: string // New text if message was edited
  editTimestamp?: number
}

export type MessageUpdateCallback = (data: MessageUpdateData) => void

// Message delete event data
export interface MessageDeleteData {
  chatId: string
  messageIds: string[]
  isRevoke?: boolean // true if deleted for everyone
}

export type MessageDeleteCallback = (data: MessageDeleteData) => void

// Contact change event data
export interface ContactChangeData {
  contactId: string
  name?: string
  pushName?: string
  changeType: 'upsert' | 'update'
}

export type ContactChangeCallback = (data: ContactChangeData) => void

export type ReadyCallback = () => void

export type ActivityCallback = () => void

export interface WAMessage extends proto.IWebMessageInfo {}
