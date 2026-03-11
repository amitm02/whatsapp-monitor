export { WhatsAppMonitor } from './client.js'
export {
  loadConfig,
  saveConfig,
  addToAllowlist,
  removeFromAllowlist,
  isAllowed,
  getConfigPath,
  getConfigDir,
  CONFIG_DIR,
  CONFIG_FILE,
  DEFAULT_AUTH_DIR,
} from './config.js'
export type {
  MonitorConfig,
  GroupInfo,
  ContactInfo,
  GroupMetadata,
  Participant,
  MonitorMessage,
  QuotedMessage,
  MessageType,
  MessageCallback,
  ConnectionState,
  ConnectionCallback,
  QRCallback,
  HistorySyncData,
  HistorySyncCallback,
} from './types.js'
