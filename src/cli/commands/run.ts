import { Command } from 'commander'
import { createClient } from '../utils.js'
import { Notifier } from '../../notifier.js'
import { Dispatcher, type DispatchResult } from '../../dispatcher.js'
import { resolveNotify } from '../../config.js'

export const runCommand = new Command('run')
  .description('Run as a persistent listener. Streams messages from allowed chats and invokes notify.command (if configured).')
  .option('-v, --verbose', 'Enable verbose debug output')
  .option('--no-notify', 'Skip notify command; still append to the JSONL log')
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

    const baseResolved = resolveNotify(config.notify)
    const notifyResolved: ReturnType<typeof resolveNotify> =
      options.notify === false && baseResolved.mode !== 'disabled'
        ? {
            mode: 'disabled',
            quietPeriodSec: baseResolved.quietPeriodSec,
            timeoutSec: baseResolved.timeoutSec,
            logFile: baseResolved.logFile,
            maxBufferedPerChat: baseResolved.maxBufferedPerChat,
          }
        : baseResolved

    if (notifyResolved.mode === 'disabled') {
      logInfo(
        options.notify === false
          ? 'notify disabled via --no-notify; notifications will only be written to the JSONL log.'
          : 'no notify configured; notifications will only be written to the JSONL log.'
      )
    } else if (notifyResolved.mode === 'openclaw-agent') {
      logInfo(`notify mode: openclaw-agent (agent=${notifyResolved.agent}, sessionIdTemplate=${notifyResolved.sessionIdTemplate})`)
      logInfo(`behaviorFile: ${notifyResolved.behaviorFile}`)
    } else {
      logInfo(`notify mode: command (${notifyResolved.command})`)
    }
    logInfo(`notify log: ${notifyResolved.logFile}`)
    logInfo(`quiet period: ${notifyResolved.quietPeriodSec}s (per chat)`)
    logInfo(`notify timeout: ${notifyResolved.timeoutSec === 0 ? 'disabled' : notifyResolved.timeoutSec + 's'}`)

    const dispatcher = new Dispatcher({
      notify: notifyResolved,
      verbose,
      onWarning: (msg) => console.error(`[warn] ${msg}`),
      onInfo: logInfo,
    })

    const notifier = new Notifier({
      quietPeriodSec: notifyResolved.quietPeriodSec,
      maxBufferedPerChat: notifyResolved.maxBufferedPerChat,
      dispatch: async (payload) => {
        const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf-8')
        const label = payload.chatName ? `"${payload.chatName}" (${payload.chatId})` : payload.chatId
        logInfo(
          `flushed batch chat=${label} msgs=${payload.messageCount} senders=${payload.senderCount} bytes=${bytes}`
        )
        const result = await dispatcher.dispatch(payload)
        if (result) {
          logFlushResult(logInfo, result)
        }
      },
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
      if (shuttingDown) {
        logInfo(`received second ${signal}; exiting immediately`)
        process.exit(1)
      }
      shuttingDown = true
      logInfo(`received ${signal}, shutting down`)
      try {
        await notifier.close()
        await dispatcher.shutdown({ drainTimeoutMs: 5000 })
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
  })

function logFlushResult(log: (msg: string) => void, result: DispatchResult): void {
  if (result.mode === 'disabled') {
    log(`notify logged only (mode=disabled) elapsed=${result.elapsedMs}ms`)
    return
  }
  if (result.spawnError) {
    log(`notify spawn failed: ${result.spawnError}`)
    return
  }
  if (result.timedOut) {
    log(`notify timed out elapsed=${result.elapsedMs}ms`)
    return
  }
  const exitLabel = result.signal ? `signal=${result.signal}` : `exit=${result.exitCode ?? '?'}`
  log(`notify ${exitLabel} elapsed=${result.elapsedMs}ms`)
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
