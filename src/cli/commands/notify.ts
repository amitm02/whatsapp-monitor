import { Command } from 'commander'
import { existsSync } from 'fs'
import { loadConfig, resolveNotify, CONFIG_FILE } from '../../config.js'
import { Dispatcher, renderTemplate } from '../../dispatcher.js'
import type { NotificationPayload } from '../../types.js'

const notifyCommand = new Command('notify').description('Notify pipeline utilities')

notifyCommand
  .command('test')
  .description('Run the notify pipeline once with a synthetic payload (for verifying wiring).')
  .option('-v, --verbose', 'Show extra output (full stdout, full stderr)')
  .action(async (options) => {
    const verbose = Boolean(options.verbose)
    const info = (line: string) => console.log(line)
    const step = (line: string) => console.log(`[step] ${line}`)
    const fail = (line: string): never => {
      console.log(`[fail] ${line}`)
      console.log('[result] failed')
      process.exit(1)
    }

    info('notify test (dry run)')

    if (!existsSync(CONFIG_FILE)) {
      fail(`config file not found: ${CONFIG_FILE}`)
    }
    info(`[info] config loaded from ${CONFIG_FILE}`)

    let config
    try {
      config = await loadConfig()
    } catch (err) {
      fail(`config load failed: ${formatError(err)}`)
    }

    const notify = resolveNotify(config!.notify)
    info(`[info] notify mode: ${notify.mode}`)
    if (notify.mode === 'disabled') {
      fail('no notify.command or notify.kind is configured; nothing to test')
    }

    const payload = syntheticPayload()

    if (notify.mode === 'openclaw-agent') {
      const sessionId = renderTemplate(notify.sessionIdTemplate, payload)
      info(`[info] resolved target: openclaw agent --agent ${notify.agent} --session-id ${sessionId}`)
      info(`[info] behaviorFile:    ${notify.behaviorFile}`)
    } else if (notify.mode === 'command') {
      info(`[info] resolved target: sh -c "${notify.command}"`)
    }

    const json = JSON.stringify(payload)
    step(`generating synthetic payload (${payload.messageCount} message, ${Buffer.byteLength(json, 'utf-8')} bytes json)`)

    const dispatcher = new Dispatcher({
      notify,
      verbose,
      onWarning: (msg) => console.log(`[warn] ${msg}`),
    })

    step(`appending to log: ${notify.logFile}`)
    step(`spawning child and waiting (timeout: ${notify.timeoutSec === 0 ? 'disabled' : notify.timeoutSec + 's'})`)

    const result = await dispatcher.dispatch(payload)
    if (!result) {
      fail('dispatcher returned no result (dispatcher closed?)')
    }

    if (!result!.logAppended) {
      console.log(`[fail] log append failed: ${result!.logError ?? 'unknown error'}`)
    } else {
      console.log('[ok]   log append')
    }

    if (result!.spawnError) {
      fail(`child spawn failed: ${result!.spawnError}`)
    }

    if (result!.timedOut) {
      fail(`child timed out after ${result!.elapsedMs}ms (timeoutSec=${notify.timeoutSec})`)
    }

    const exitLabel = result!.signal ? `signal=${result!.signal}` : `code=${result!.exitCode}`
    const outcome = result!.exitCode === 0 ? 'ok' : 'fail'
    console.log(`[${outcome}${outcome === 'ok' ? '  ' : ''}] child exited: ${exitLabel}, elapsed=${result!.elapsedMs}ms, stdin=${result!.bytesWritten} bytes`)

    if (result!.stdoutPreview) {
      console.log(`[info] stdout: ${verbose ? result!.stdoutPreview : truncate(result!.stdoutPreview, 200)}`)
    }
    if (result!.stderrPreview) {
      console.log(`[info] stderr: ${verbose ? result!.stderrPreview : truncate(result!.stderrPreview, 200)}`)
    }

    if (result!.exitCode !== 0 || !result!.logAppended) {
      console.log('[result] failed')
      process.exit(1)
    }
    console.log('[result] ok')
    console.log('')
    console.log('note: notify test verifies monitor-side payload generation, log append, and child spawn+exit.')
    console.log('      it does NOT verify end-to-end alert delivery (e.g. that an agent replied on your Telegram).')
    console.log('      for full verification, run `whatsapp-monitor run` and send a real message to an allowed chat.')
  })

function syntheticPayload(): NotificationPayload {
  const now = Math.floor(Date.now() / 1000) * 1000
  return {
    chatId: 'test@g.us',
    chatName: 'whatsapp-monitor test',
    isGroup: true,
    firstTimestamp: now,
    lastTimestamp: now,
    messageCount: 1,
    senderCount: 1,
    messages: [
      {
        id: 'synthetic-1',
        chatId: 'test@g.us',
        chatName: 'whatsapp-monitor test',
        sender: 'synthetic@s.whatsapp.net',
        senderName: 'Tester',
        timestamp: now,
        text: 'This is a synthetic notification from `whatsapp-monitor notify test`.',
        type: 'text',
        upsertType: 'notify',
        isGroup: true,
      },
    ],
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max) + '…'
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

export { notifyCommand }
