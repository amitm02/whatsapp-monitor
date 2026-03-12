import { WhatsAppMonitor } from '../client.js'
import { loadConfig, type MonitorConfig } from '../index.js'
import qrcode from 'qrcode-terminal'

export async function createClient(options: { verbose?: boolean; skipAllowlist?: boolean } = {}): Promise<{ client: WhatsAppMonitor; config: MonitorConfig }> {
  const config = await loadConfig()
  const client = new WhatsAppMonitor(config, { verbose: options.verbose, skipAllowlist: options.skipAllowlist })
  return { client, config }
}

export function displayQR(qr: string): void {
  qrcode.generate(qr, { small: true })
}

export function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString()
}

export function formatChatId(id: string): string {
  // Extract the phone number or group ID without the suffix
  if (id.endsWith('@g.us')) {
    return id.replace('@g.us', ' (group)')
  }
  if (id.endsWith('@s.whatsapp.net')) {
    return id.replace('@s.whatsapp.net', '')
  }
  return id
}
