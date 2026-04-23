import { Command } from 'commander'
import { join } from 'path'
import { createClient } from '../utils.js'
import { Notifier } from '../../notifier.js'
import { Dispatcher, type DispatchResult } from '../../dispatcher.js'
import { resolveNotify, getConfigDir } from '../../config.js'
import { acquireLock } from '../../lockfile.js'
import { writeRuntimeState, clearRuntimeState } from '../../runtime-state.js'

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

    // Process-level crash guards: keep the service alive through unexpected
    // errors that would otherwise terminate the Node process. We log loudly
    // so the cause is visible in stderr/logs, but we don't exit — the
    // persistent service should attempt to keep monitoring.
    process.on('uncaughtException', (err) => {
      logInfo(`uncaughtException: ${formatError(err)}${err instanceof Error && err.stack ? '\n' + err.stack : ''}`)
    })
    process.on('unhandledRejection', (reason) => {
      logInfo(`unhandledRejection: ${formatError(reason)}`)
    })

    const { client, config } = await createClient({ verbose })

    if (config.allowedGroups.length === 0 && config.allowedContacts.length === 0) {
      console.error('No chats in allowlist. Add chats using: whatsapp-monitor config add <id>')
      process.exit(1)
    }

    // Exclusive PID-file lock. Two concurrent `run` processes sharing the
    // same auth dir would fight over the same WhatsApp Web slot and produce
    // a status 440 loop, so we refuse to start if another live instance is
    // already running. Stale locks (crashed process, file never cleaned up)
    // are detected and cleared automatically.
    const configDir = getConfigDir()
    const lockPath = join(configDir, 'run.lock')
    const runtimeStatePath = join(configDir, 'runtime-state.json')
    const lock = acquireLock(lockPath)
    if (!lock.ok) {
      console.error(
        `Another \`whatsapp-monitor run\` is already running (pid ${lock.existingPid}).\n` +
          `If you believe it's stuck, kill it first:  kill ${lock.existingPid}\n` +
          `Lock file: ${lockPath}`
      )
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

    const startedAt = Date.now()
    const syncRuntimeState = () => {
      writeRuntimeState(runtimeStatePath, {
        pid: process.pid,
        startedAt,
        updatedAt: Date.now(),
        connectionState: client.getConnectionState(),
        lastActivityAt: client.getLastActivityAt(),
        reconnectAttempts: client.getReconnectAttempts(),
      })
    }
    syncRuntimeState()

    client.onConnection((state) => {
      logInfo(`connection: ${state}`)
      syncRuntimeState()
    })

    client.onReady(() => {
      logInfo('initial sync complete')
    })

    client.onMessage((msg) => {
      logDebug(`message ${msg.id} in ${msg.chatId}`)
      notifier.push(msg)
    })

    // Liveness heartbeat: periodically log connection state + idle time so
    // the next silent-stop incident has a timeline in stderr/journal.
    const HEARTBEAT_MS = 5 * 60 * 1000
    const heartbeat = setInterval(() => {
      const state = client.getConnectionState()
      const idleMs = client.getIdleMs()
      const idleSec = Math.round(idleMs / 1000)
      logInfo(`heartbeat: state=${state} idleSince=${idleSec}s lastActivity=${new Date(client.getLastActivityAt()).toISOString()}`)
      syncRuntimeState()
    }, HEARTBEAT_MS)
    if (heartbeat.unref) heartbeat.unref()

    let shuttingDown = false
    const shutdown = async (signal: string) => {
      if (shuttingDown) {
        logInfo(`received second ${signal}; exiting immediately`)
        process.exit(1)
      }
      shuttingDown = true
      logInfo(`received ${signal}, shutting down`)
      clearInterval(heartbeat)
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
      clearRuntimeState(runtimeStatePath)
      lock.release()
      process.exit(0)
    }

    // Best-effort cleanup on unexpected exit paths (uncaught throws, etc.).
    // The signal handlers above are the primary path; these are safety nets.
    process.on('exit', () => {
      clearRuntimeState(runtimeStatePath)
      lock.release()
    })

    process.on('SIGINT', () => {
      void shutdown('SIGINT')
    })
    process.on('SIGTERM', () => {
      void shutdown('SIGTERM')
    })

    logInfo('connecting to WhatsApp...')
    try {
      await client.connect()
    } catch (err) {
      // Initial connect failed (e.g. transient network error). The client's
      // reconnect machinery only fires off `connection.update: close`, which
      // won't happen if we never got that far — retry here until we succeed,
      // so the service stays persistent instead of exiting.
      logInfo(`initial connect failed: ${formatError(err)} — will retry`)
      const attemptReconnect = async () => {
        if (shuttingDown) return
        try {
          await client.connect()
          logInfo('connected after initial-connect retry')
        } catch (e) {
          logInfo(`initial-connect retry failed: ${formatError(e)} — retrying in 10s`)
          setTimeout(() => void attemptReconnect(), 10_000).unref?.()
        }
      }
      setTimeout(() => void attemptReconnect(), 5_000).unref?.()
    }
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
