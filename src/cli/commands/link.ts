import { Command } from 'commander'
import { createClient, displayQR } from '../utils.js'

export const linkCommand = new Command('link')
  .description('Link WhatsApp account via QR code or pairing code')
  .option('--phone <number>', 'Use pairing code instead of QR (phone number in E.164 format without +, e.g., 12345678901)')
  .action(async (options: { phone?: string }) => {
    const phoneNumber = options.phone

    if (phoneNumber) {
      // Validate phone number format
      if (!/^\d{7,15}$/.test(phoneNumber)) {
        console.error('Error: Phone number must be 7-15 digits in E.164 format without the + sign')
        console.error('Example: 12345678901 (country code + number)')
        process.exit(1)
      }

      console.log('Starting WhatsApp connection with pairing code...')
      console.log(`Phone number: ${phoneNumber}\n`)

      const { client } = await createClient()

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
          } catch (err) {
            console.error('Failed to request pairing code:', err instanceof Error ? err.message : err)
            process.exit(1)
          }
        }
      })

      client.onConnection((state) => {
        if (state === 'connected') {
          console.log('Connected! Waiting for sync to complete...')
          console.log('(Keep WhatsApp open on your phone until this finishes)')
        } else if (state === 'logged_out') {
          console.log('Session expired. Please try again.')
          process.exit(1)
        } else if (state === 'disconnected') {
          console.log('Disconnected. Reconnecting...')
        }
      })

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
    } else {
      // Original QR code flow
      console.log('Starting WhatsApp connection...')
      console.log('Scan the QR code with your WhatsApp app\n')

      const { client } = await createClient()

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
        console.log('\n✓ Successfully linked to WhatsApp!')
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
  })
