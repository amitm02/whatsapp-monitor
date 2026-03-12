import { Command } from 'commander'
import { rm } from 'fs/promises'
import { existsSync } from 'fs'
import { createClient, displayQR } from '../utils.js'
import { loadConfig, hasExistingAuth } from '../../config.js'

export const linkCommand = new Command('link')
  .description('Link WhatsApp account')
  .option('--qr', 'Link via QR code (default)')
  .option('--code', 'Link via pairing code (for agent use)')
  .option('--phone <number>', 'Phone number in E.164 format without + (required with --code)')
  .option('--name <name>', 'Device name shown in WhatsApp (default: whatsapp-monitor)')
  .option('--reset', 'Reset existing auth before linking')
  .option('-v, --verbose', 'Enable verbose debug output')
  .action(async (options: { qr?: boolean; code?: boolean; phone?: string; name?: string; reset?: boolean; verbose?: boolean }) => {
    // Validate mutually exclusive options
    if (options.qr && options.code) {
      console.error('Error: --qr and --code are mutually exclusive')
      process.exit(1)
    }

    // --code requires --phone
    if (options.code && !options.phone) {
      console.error('Error: --code requires --phone <number>')
      console.error('Example: whatsapp-monitor link --code --phone 12345678901')
      process.exit(1)
    }

    // Validate phone number format if provided
    if (options.phone && !/^\d{7,15}$/.test(options.phone)) {
      console.error('Error: Phone number must be 7-15 digits in E.164 format without the + sign')
      console.error('Example: 12345678901 (country code + number)')
      process.exit(1)
    }

    const config = await loadConfig()

    // Handle --reset: delete auth dir silently
    if (options.reset && existsSync(config.authDir)) {
      await rm(config.authDir, { recursive: true })
    }

    // Check for existing credentials (after potential reset)
    if (hasExistingAuth(config.authDir)) {
      console.error('Error: Existing authentication found.')
      console.error('To link a new device, either:')
      console.error('  - Use --reset flag: whatsapp-monitor link --reset ...')
      console.error('  - Or reset manually: whatsapp-monitor reset')
      process.exit(1)
    }

    // Determine mode: --code for pairing code, otherwise QR (default)
    if (options.code) {
      await linkWithPairingCode(options.phone!, options.name, options.verbose)
    } else {
      await linkWithQR(options.name, options.verbose)
    }
  })

async function linkWithPairingCode(phoneNumber: string, deviceName?: string, verbose?: boolean): Promise<void> {
  console.log('Requesting pairing code...')
  console.log(`Phone number: ${phoneNumber}\n`)

  const { client } = await createClient({ browserName: deviceName, verbose })

  let pairingCodeRequested = false

  client.onQR(async () => {
    // QR event indicates we're ready to request a pairing code
    if (!pairingCodeRequested) {
      pairingCodeRequested = true
      try {
        const code = await client.requestPairingCode(phoneNumber)
        console.log('\n========================================')
        console.log('           PAIRING CODE')
        console.log('========================================')
        console.log(`\n           ${code}\n`)
        console.log('========================================\n')
        console.log('Enter this code in WhatsApp on your phone:')
        console.log('1. Open WhatsApp')
        console.log('2. Go to Settings > Linked Devices > Link a Device')
        console.log('3. Tap "Link with phone number instead"')
        console.log('4. Enter the pairing code above\n')
        console.log('Waiting for you to enter the code...')
      } catch (err) {
        console.error('Failed to request pairing code:', err instanceof Error ? err.message : err)
        process.exit(1)
      }
    }
  })

  client.onConnection((state) => {
    if (state === 'connected') {
      console.log('\nConnected! Waiting for sync to complete...')
    } else if (state === 'logged_out') {
      console.log('Session expired or invalid. Please try again.')
      process.exit(1)
    } else if (state === 'disconnected') {
      // Only show this if we already displayed the code
      if (pairingCodeRequested) {
        console.log('Disconnected. Reconnecting...')
      }
    }
  })

  // Wait for full sync completion before exiting
  client.onReady(() => {
    console.log('\nSuccessfully linked to WhatsApp!')
    console.log('Your session has been saved. You can now use other commands.')
    process.exit(0)
  })

  await client.connect()

  process.on('SIGINT', async () => {
    console.log('\nDisconnecting...')
    await client.disconnect()
    process.exit(0)
  })
}

async function linkWithQR(deviceName?: string, verbose?: boolean): Promise<void> {
  console.log('Starting WhatsApp connection...')
  console.log('Scan the QR code with your WhatsApp app\n')

  const { client } = await createClient({ browserName: deviceName, verbose })

  client.onQR((qr) => {
    displayQR(qr)
  })

  client.onConnection((state) => {
    if (state === 'connected') {
      console.log('\nConnected! Waiting for sync to complete...')
      console.log('(Keep WhatsApp open on your phone until this finishes)')
    } else if (state === 'logged_out') {
      console.log('Session expired. Waiting for new QR code...')
    } else if (state === 'disconnected') {
      console.log('Disconnected. Reconnecting...')
    }
  })

  // Wait for full sync completion before exiting
  client.onReady(() => {
    console.log('\nSuccessfully linked to WhatsApp!')
    console.log('Your session has been saved. You can now use other commands.')
    process.exit(0)
  })

  await client.connect()

  // Keep the process running
  process.on('SIGINT', async () => {
    console.log('\nDisconnecting...')
    await client.disconnect()
    process.exit(0)
  })
}
