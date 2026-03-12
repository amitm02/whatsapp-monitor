import { Command } from 'commander'
import { createClient, formatTimestamp } from '../utils.js'

export const messagesCommand = new Command('messages')
  .description('Stream messages and events from allowed chats')
  .option('--json', 'Output as JSON (one event per line)')
  .option('--timeout <seconds>', 'Safety timeout in seconds (default: 120)', '120')
  .option('--idle <seconds>', 'Idle timeout in seconds before exiting (default: 5)', '5')
  .option('-f, --follow', 'Keep monitoring indefinitely')
  .option('--queued-only', 'Exit immediately after receiving queued messages (no idle timer)')
  .option('-v, --verbose', 'Enable verbose debug output')
  .action(async (options) => {
    const verbose = options.verbose
    const log = (msg: string) => {
      if (verbose) {
        console.error(`[DEBUG] ${new Date().toISOString()} - ${msg}`)
      }
    }

    const { client, config } = await createClient({ verbose })

    // Check if there are any allowed chats
    if (config.allowedGroups.length === 0 && config.allowedContacts.length === 0) {
      console.error(
        'No chats in allowlist. Add chats using: whatsapp-monitor config add <id>'
      )
      process.exit(1)
    }

    const follow = options.follow
    const queuedOnly = options.queuedOnly
    const maxTimeoutSec = parseInt(options.timeout, 10) || 120
    const idleSec = parseInt(options.idle, 10) || 5

    let eventCount = 0
    let done = false
    let timeoutTimer: NodeJS.Timeout | null = null
    let idleTimer: NodeJS.Timeout | null = null
    let ready = false

    const finish = async () => {
      log(`finish() called, done=${done}`)
      if (done) return
      done = true

      if (timeoutTimer) clearTimeout(timeoutTimer)
      if (idleTimer) clearTimeout(idleTimer)

      if (!options.json) {
        if (eventCount === 0) {
          console.log('\nNo events received.')
        } else {
          console.log(`\n─── Done (${eventCount} events received) ───`)
        }
      }

      log('Disconnecting client')
      await client.disconnect()
      log('Exiting process')
      process.exit(0)
    }

    const resetIdleTimer = () => {
      if (follow || !ready) return
      if (idleTimer) clearTimeout(idleTimer)
      log(`Resetting idle timer (${idleSec}s)`)
      idleTimer = setTimeout(() => {
        log('Idle timer fired')
        finish()
      }, idleSec * 1000)
    }

    const recordEvent = () => {
      eventCount++
    }

    if (!options.json) {
      if (follow) {
        console.log('Connecting to WhatsApp...')
      } else if (queuedOnly) {
        console.log('Connecting and retrieving queued messages...')
      } else {
        console.log(`Connecting and streaming queued messages (${idleSec}s idle timeout)...`)
      }
    }

    client.onConnection((state) => {
      log(`Connection state changed: ${state}`)
      if (state === 'connected') {
        if (!options.json && follow) {
          console.log('\n✓ Connected! Monitoring messages from:')
          for (const id of config.allowedGroups) {
            console.log(`  - ${id}`)
          }
          for (const id of config.allowedContacts) {
            console.log(`  - ${id}`)
          }
          console.log('\nPress Ctrl+C to stop\n')
          console.log('─'.repeat(80))
        }
      } else if (state === 'disconnected') {
        if (!options.json && follow) {
          console.log('Disconnected. Reconnecting...')
        }
      }
    })

    client.onMessage((msg) => {
      recordEvent()
      if (options.json) {
        console.log(JSON.stringify({ event: 'message', data: msg }))
      } else {
        const chatLabel = msg.chatName ? `"${msg.chatName}" (${msg.chatId})` : msg.chatId
        const senderLabel = msg.senderName ? `${msg.senderName} (${msg.sender})` : msg.sender
        const timeLabel = formatTimestamp(msg.timestamp)
        const upsertLabel = msg.upsertType === 'append' ? ' [queued]' : ''

        const chatType = msg.isGroup ? 'Group' : 'DM'
        console.log(`\n[${timeLabel}] MESSAGE${upsertLabel}`)
        console.log(`${chatType}: ${chatLabel}`)
        console.log(`From: ${senderLabel}`)
        console.log(`Type: ${msg.type}`)
        if (msg.text) {
          console.log(`Text: ${msg.text}`)
        }
        if (msg.quotedMessage) {
          console.log(`  ↳ Replying to: ${msg.quotedMessage.text || '(media)'}`)
        }
        if (options.verbose && msg.rawMessage) {
          console.log(`Raw: ${JSON.stringify(msg.rawMessage)}`)
        }
        console.log('─'.repeat(80))
      }
    })

    client.onMessageUpdate((data) => {
      recordEvent()
      if (options.json) {
        console.log(JSON.stringify({ event: 'message_update', data }))
      } else {
        const timeLabel = formatTimestamp(Date.now())
        if (data.editedText) {
          console.log(`\n[${timeLabel}] EDIT ${data.chatId}`)
          console.log(`Message ${data.messageId} edited to: "${data.editedText}"`)
        } else if (data.statusLabel) {
          console.log(`\n[${timeLabel}] STATUS ${data.chatId}`)
          console.log(`Message ${data.messageId}: ${data.statusLabel}`)
        } else {
          console.log(`\n[${timeLabel}] UPDATE ${data.chatId}`)
          console.log(`Message ${data.messageId} updated`)
        }
        console.log('─'.repeat(80))
      }
    })

    client.onMessageDelete((data) => {
      recordEvent()
      if (options.json) {
        console.log(JSON.stringify({ event: 'message_delete', data }))
      } else {
        const timeLabel = formatTimestamp(Date.now())
        if (data.messageIds.length === 0) {
          console.log(`\n[${timeLabel}] CLEARED ${data.chatId}`)
          console.log('All messages cleared')
        } else {
          console.log(`\n[${timeLabel}] DELETED ${data.chatId}`)
          console.log(`Message(s): ${data.messageIds.join(', ')}`)
          if (data.isRevoke) {
            console.log('(Deleted for everyone)')
          }
        }
        console.log('─'.repeat(80))
      }
    })


    // Reset idle timer on any activity (before filtering)
    client.onActivity(() => {
      resetIdleTimer()
    })

    // In non-follow mode, start idle timer when sync completes
    if (!follow) {
      log('Registering onReady callback')
      client.onReady(() => {
        log('onReady fired')
        ready = true
        if (queuedOnly) {
          log('Queued-only mode: exiting immediately')
          finish()
        } else {
          log('Starting idle timer')
          resetIdleTimer()
        }
      })

      // Safety timeout in case sync never completes
      log(`Setting safety timeout: ${maxTimeoutSec}s`)
      timeoutTimer = setTimeout(() => {
        log('Safety timeout fired')
        if (!options.json) {
          console.error('\nTimeout waiting for sync completion')
        }
        finish()
      }, maxTimeoutSec * 1000)
    } else {
      log('Follow mode enabled, not registering onReady')
    }

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

    process.on('SIGINT', async () => {
      if (!options.json) {
        console.log('\nDisconnecting...')
      }
      await client.disconnect()
      process.exit(0)
    })

    // Keep process alive
    await new Promise<void>(() => {})
  })
