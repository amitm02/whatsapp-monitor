import { Command } from 'commander'
import { createClient, displayQR } from '../utils.js'

export const linkCommand = new Command('link')
  .description('Display QR code to link WhatsApp account')
  .action(async () => {
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
  })
