import { Command } from 'commander'
import { createClient } from '../utils.js'

export const eventsCommand = new Command('events')
  .description('Stream all raw Baileys events (for debugging)')
  .option('--timeout <seconds>', 'Max timeout in seconds (default: 60)', '60')
  .option('--idle <seconds>', 'Exit after N seconds of no events (default: 10)', '10')
  .option('-v, --verbose', 'Enable debug output')
  .action(async (options) => {
    const { client } = await createClient({ verbose: options.verbose })

    let eventCount = 0
    const maxTimeoutSec = parseInt(options.timeout, 10) || 60
    const idleSec = parseInt(options.idle, 10) || 10

    let idleTimer: NodeJS.Timeout | null = null
    let done = false

    const finish = async () => {
      if (done) return
      done = true

      if (idleTimer) clearTimeout(idleTimer)

      if (eventCount === 0) {
        console.log('\nNo events received.')
      } else {
        console.log(`\n─── Done (${eventCount} events received) ───`)
      }

      await client.disconnect()
      process.exit(0)
    }

    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(finish, idleSec * 1000)
    }

    client.onRawEvent((event, data) => {
      eventCount++
      console.log(JSON.stringify({ event, data, timestamp: Date.now() }))
      resetIdleTimer()
    })

    console.log(`Connecting and streaming events (${idleSec}s idle, ${maxTimeoutSec}s max)...`)

    await client.connect()

    // Wait for connection
    await new Promise<void>((resolve) => {
      const check = () => {
        if (client.isConnected()) {
          resolve()
        } else {
          setTimeout(check, 100)
        }
      }
      check()
    })

    // Start idle timer once connected
    resetIdleTimer()

    // Max timeout as fallback
    setTimeout(finish, maxTimeoutSec * 1000)

    // Keep process alive
    await new Promise<void>(() => {})
  })
