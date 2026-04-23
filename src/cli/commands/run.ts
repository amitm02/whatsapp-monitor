import { Command } from 'commander'
import { join } from 'path'
import { createClient } from '../utils.js'
import { Notifier } from '../../notifier.js'
import { Dispatcher, type DispatchResult } from '../../dispatcher.js'
import { resolveNotify, resolveErrorAlerts, getConfigDir } from '../../config.js'
import { acquireLock } from '../../lockfile.js'
import { writeRuntimeState, clearRuntimeState } from '../../runtime-state.js'
import { ErrorAlerter, defaultErrorAlertStatePath } from '../../error-alerts.js'

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

    const errorAlertsResolved = resolveErrorAlerts(config.errorAlerts)
    const errorAlerter = new ErrorAlerter({
      errorAlerts: errorAlertsResolved,
      stateFile: defaultErrorAlertStatePath(configDir),
      onWarning: (msg) => console.error(`[warn] ${msg}`),
    })
    if (errorAlertsResolved.enabled) {
      const t = errorAlertsResolved.triggers
      const triggersList: string[] = []
      if (t.conflict) triggersList.push('conflict')
      if (t.loggedOut) triggersList.push('loggedOut')
      if (t.extendedDisconnectAfterSec !== null)
        triggersList.push(`extendedDisconnect(${t.extendedDisconnectAfterSec}s)`)
      if (t.dispatchFailuresAfter !== null)
        triggersList.push(`dispatchFailures(${t.dispatchFailuresAfter} consecutive)`)
      logInfo(`error-alerts: enabled throttle=${errorAlertsResolved.throttleSec}s triggers=[${triggersList.join(', ')}]`)
      logInfo(`error-alerts log: ${errorAlertsResolved.logFile}`)
    } else {
      logInfo('error-alerts: disabled (no errorAlerts.command configured) — nothing will notify the operator on service issues')
    }

    const dispatcher = new Dispatcher({
      notify: notifyResolved,
      verbose,
      onWarning: (msg) => console.error(`[warn] ${msg}`),
      onInfo: logInfo,
    })

    let consecutiveDispatchFailures = 0
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
        // Update dispatch-failure counter. 'disabled' mode never "fails" —
        // we only track real dispatches (spawnError, timeout, non-zero exit).
        const threshold = errorAlertsResolved.triggers.dispatchFailuresAfter
        if (result && result.mode !== 'disabled' && threshold !== null) {
          const failed = Boolean(
            result.spawnError || result.timedOut || (result.exitCode != null && result.exitCode !== 0)
          )
          if (failed) {
            consecutiveDispatchFailures++
            if (consecutiveDispatchFailures === threshold) {
              const detail = result.spawnError
                ? `spawn error: ${result.spawnError}`
                : result.timedOut
                  ? `timed out after ${result.elapsedMs}ms`
                  : `exit=${result.exitCode}`
              void errorAlerter
                .fire(
                  'dispatchFailures',
                  `${threshold} consecutive notify dispatches failed. Latest: ${detail}. Notifications are not reaching the agent.`,
                  {
                    consecutiveFailures: consecutiveDispatchFailures,
                    lastResult: {
                      mode: result.mode,
                      exitCode: result.exitCode,
                      signal: result.signal,
                      timedOut: result.timedOut,
                      spawnError: result.spawnError,
                      stderrPreview: result.stderrPreview,
                    },
                  }
                )
                .catch((err) => logInfo(`error-alert fire threw: ${formatError(err)}`))
            }
          } else {
            if (consecutiveDispatchFailures >= threshold) {
              logInfo(`dispatch recovered after ${consecutiveDispatchFailures} failure(s)`)
            }
            consecutiveDispatchFailures = 0
          }
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

    // Track time in non-connected state for the extendedDisconnect error alert.
    // We start "connected" optimistically because a freshly-started service
    // hasn't had a real opportunity to fail yet — the extended-disconnect
    // clock should start from the first time we're NOT connected.
    let lastConnectedAt = Date.now()
    let extendedDisconnectAlerted = false

    client.onConnection((state) => {
      logInfo(`connection: ${state}`)
      syncRuntimeState()

      if (state === 'connected') {
        lastConnectedAt = Date.now()
        extendedDisconnectAlerted = false
      }
      if (state === 'conflict' && errorAlertsResolved.triggers.conflict) {
        void errorAlerter
          .fire(
            'conflict',
            'WhatsApp Web stream conflict (status 440): another linked device has taken over this session slot. The monitor has stopped reconnecting until the competing session is closed. Please investigate and restart the service.',
            { reconnectAttempts: client.getReconnectAttempts() }
          )
          .catch((err) => logInfo(`error-alert fire threw: ${formatError(err)}`))
      }
      if (state === 'logged_out' && errorAlertsResolved.triggers.loggedOut) {
        void errorAlerter
          .fire(
            'loggedOut',
            'WhatsApp session logged out. The monitor cannot reconnect until the device is re-linked. Run `whatsapp-monitor link` on the host.',
            {}
          )
          .catch((err) => logInfo(`error-alert fire threw: ${formatError(err)}`))
      }
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

      // Extended-disconnect check. Fires once per disconnect episode
      // (extendedDisconnectAlerted guard) + still throttled by the
      // ErrorAlerter layer — so a flapping connection can't machine-gun
      // alerts. Terminal states (conflict/logged_out) have their own error
      // alerts and are excluded here to avoid double-alerting.
      const extendedThresholdSec = errorAlertsResolved.triggers.extendedDisconnectAfterSec
      if (
        extendedThresholdSec !== null &&
        !extendedDisconnectAlerted &&
        state !== 'connected' &&
        state !== 'conflict' &&
        state !== 'logged_out'
      ) {
        const disconnectedForSec = Math.round((Date.now() - lastConnectedAt) / 1000)
        if (disconnectedForSec >= extendedThresholdSec) {
          extendedDisconnectAlerted = true
          void errorAlerter
            .fire(
              'extendedDisconnect',
              `WhatsApp monitor has been disconnected for ${disconnectedForSec}s (threshold: ${extendedThresholdSec}s). Current state: ${state}. Reconnect attempts: ${client.getReconnectAttempts()}. The service is still trying but has not succeeded.`,
              {
                disconnectedForSec,
                thresholdSec: extendedThresholdSec,
                state,
                reconnectAttempts: client.getReconnectAttempts(),
              }
            )
            .catch((err) => logInfo(`error-alert fire threw: ${formatError(err)}`))
        }
      }
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
