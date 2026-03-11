import type { proto } from '@whiskeysockets/baileys'

export interface MonitorConfig {
  allowedGroups: string[]
  allowedContacts: string[]
  authDir: string
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
