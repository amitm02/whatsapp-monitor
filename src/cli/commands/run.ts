import { Command } from 'commander'
import { createClient } from '../utils.js'
import { Notifier } from '../../notifier.js'
import { Dispatcher } from '../../dispatcher.js'
import { resolveNotifyDefaults } from '../../config.js'

export const runCommand = new Command('run')
  .description('Run as a persistent listener. Streams messages from allowed chats and invokes notify.command (if configured).')
  .option('-v, --verbose', 'Enable verbose debug output')
  .option('--no-notify', 'Skip notify.command; still append to the JSONL log')
  .action(async (options) => {
    const verbose = Boolean(options.verbose)
    const logInfo = (msg: string) => console.error(`[${new Date().toISOString()}] ${msg}`)
    const logDebug = (msg: string) => {
      if (verbose) console.error(`[DEBUG ${new Date().toISOString()}] ${msg}`)
    }

    const { client, config } = await createClient({ verbose })

    if (config.allowedGroups.length === 0 && config.allowedContacts.length === 0) {
      console.error('No chats in allowlist. Add chats using: whatsapp-monitor config add <id>')
      process.exit(1)
    }

    const notifyResolved = resolveNotifyDefaults(config.notify)
    const effectiveCommand = options.notify === false ? '' : notifyResolved.command

    if (!effectiveCommand) {
      logInfo(
        options.notify === false
          ? 'notify.command disabled via --no-notify; notifications will only be written to the JSONL log.'
          : 'No notify.command configured; notifications will only be written to the JSONL log.'
      )
    } else {
      logInfo(`notify.command: ${effectiveCommand}`)
    }
    logInfo(`notify log: ${notifyResolved.logFile}`)
    logInfo(`quiet period: ${notifyResolved.quietPeriodSec}s (per chat)`)

    const dispatcher = new Dispatcher({
      command: effectiveCommand,
      logFile: notifyResolved.logFile,
      verbose,
      onWarning: (msg) => console.error(`[warn] ${msg}`),
    })

    const notifier = new Notifier({
      quietPeriodSec: notifyResolved.quietPeriodSec,
      maxBufferedPerChat: notifyResolved.maxBufferedPerChat,
      dispatch: (payload) => dispatcher.dispatch(payload),
      onError: (err, ctx) => console.error(`[warn] notifier error in ${ctx}: ${formatError(err)}`),
    })

    client.onConnection((state) => {
      logInfo(`connection: ${state}`)
    })

    client.onReady(() => {
      logInfo('initial sync complete')
    })

    client.onMessage((msg) => {
      logDebug(`message ${msg.id} in ${msg.chatId}`)
      notifier.push(msg)
    })

    let shuttingDown = false
    const shutdown = async (signal: string) => {
      if (shuttingDown) return
      shuttingDown = true
      logInfo(`received ${signal}, shutting down`)
      try {
        await notifier.close()
        await dispatcher.drain()
      } catch (err) {
        console.error(`[warn] error during flush: ${formatError(err)}`)
      }
      try {
        await client.disconnect()
      } catch (err) {
        console.error(`[warn] error during disconnect: ${formatError(err)}`)
      }
      process.exit(0)
    }

    process.on('SIGINT', () => {
      void shutdown('SIGINT')
    })
    process.on('SIGTERM', () => {
      void shutdown('SIGTERM')
    })

    logInfo('connecting to WhatsApp...')
    await client.connect()

    await new Promise<void>(() => {})
  })

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
