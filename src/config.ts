import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join, dirname } from 'path'
import type { MonitorConfig } from './types.js'

const CONFIG_DIR = join(homedir(), '.whatsapp-monitor')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')
const DEFAULT_AUTH_DIR = join(CONFIG_DIR, 'auth')

const DEFAULT_CONFIG: MonitorConfig = {
  allowedGroups: [],
  allowedContacts: [],
  authDir: DEFAULT_AUTH_DIR,
}

export async function loadConfig(): Promise<MonitorConfig> {
  try {
    if (!existsSync(CONFIG_FILE)) {
      return { ...DEFAULT_CONFIG }
    }
    const content = await readFile(CONFIG_FILE, 'utf-8')
    const parsed = JSON.parse(content) as Partial<MonitorConfig>
    return {
      allowedGroups: parsed.allowedGroups ?? [],
      allowedContacts: parsed.allowedContacts ?? [],
      authDir: parsed.authDir ?? DEFAULT_AUTH_DIR,
    }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export async function saveConfig(config: MonitorConfig): Promise<void> {
  await mkdir(dirname(CONFIG_FILE), { recursive: true })
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8')
}

export async function addToAllowlist(id: string): Promise<void> {
  const config = await loadConfig()
  const isGroup = id.endsWith('@g.us')
  const isContact = id.endsWith('@s.whatsapp.net')

  if (!isGroup && !isContact) {
    throw new Error(
      'Invalid ID format. Must end with @g.us (group) or @s.whatsapp.net (contact)'
    )
  }

  if (isGroup) {
    if (!config.allowedGroups.includes(id)) {
      config.allowedGroups.push(id)
    }
  } else {
    if (!config.allowedContacts.includes(id)) {
      config.allowedContacts.push(id)
    }
  }

  await saveConfig(config)
}

export async function removeFromAllowlist(id: string): Promise<void> {
  const config = await loadConfig()

  config.allowedGroups = config.allowedGroups.filter((g) => g !== id)
  config.allowedContacts = config.allowedContacts.filter((c) => c !== id)

  await saveConfig(config)
}

export function isAllowed(chatId: string, config: MonitorConfig): boolean {
  // If both allowlists are empty, nothing is allowed (secure default)
  if (config.allowedGroups.length === 0 && config.allowedContacts.length === 0) {
    return false
  }

  return (
    config.allowedGroups.includes(chatId) ||
    config.allowedContacts.includes(chatId)
  )
}

export function getConfigPath(): string {
  return CONFIG_FILE
}

export function getConfigDir(): string {
  return CONFIG_DIR
}

export { CONFIG_DIR, CONFIG_FILE, DEFAULT_AUTH_DIR }
