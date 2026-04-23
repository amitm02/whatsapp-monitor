import { Command } from 'commander'
import { existsSync } from 'fs'
import { join } from 'path'
import { loadConfig, resolveErrorAlerts, CONFIG_FILE, getConfigDir } from '../../config.js'
import { ErrorAlerter } from '../../error-alerts.js'

const errorAlertsCommand = new Command('error-alerts').description('Operator error-alert pipeline utilities')

errorAlertsCommand
  .command('test')
  .description('Fire a synthetic error alert through errorAlerts.command (for verifying wiring).')
  .option('-v, --verbose', 'Show extra output')
  .action(async (options) => {
    const verbose = Boolean(options.verbose)
    const info = (line: string) => console.log(line)
    const step = (line: string) => console.log(`[step] ${line}`)
    const fail = (line: string): never => {
      console.log(`[fail] ${line}`)
      console.log('[result] failed')
      process.exit(1)
    }

    info('error-alerts test (dry run)')

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

    const errorAlerts = resolveErrorAlerts(config!.errorAlerts)
    if (!errorAlerts.enabled) {
      fail('no errorAlerts.command is configured; nothing to test. Add an `errorAlerts` block to ~/.whatsapp-monitor/config.json.')
    }

    info(`[info] error-alerts command: sh -c "${errorAlerts.command}"`)
    info(`[info] error-alerts log:     ${errorAlerts.logFile}`)
    info(`[info] throttleSec:          ${errorAlerts.throttleSec}`)
    info(`[info] timeoutSec:           ${errorAlerts.timeoutSec === 0 ? 'disabled' : errorAlerts.timeoutSec}`)
    const t = errorAlerts.triggers
    const triggers: string[] = []
    if (t.conflict) triggers.push('conflict')
    if (t.loggedOut) triggers.push('loggedOut')
    if (t.extendedDisconnectAfterSec !== null) triggers.push(`extendedDisconnect(${t.extendedDisconnectAfterSec}s)`)
    if (t.dispatchFailuresAfter !== null) triggers.push(`dispatchFailures(${t.dispatchFailuresAfter} consecutive)`)
    if (t.notLinked) triggers.push('notLinked')
    info(`[info] triggers:             [${triggers.join(', ')}]`)

    const errorAlerter = new ErrorAlerter({
      errorAlerts,
      stateFile: join(getConfigDir(), '.error-alert-state.test.json'),
      onWarning: (msg) => console.log(`[warn] ${msg}`),
    })

    step(`appending to log: ${errorAlerts.logFile}`)
    step(`spawning child and waiting (timeout: ${errorAlerts.timeoutSec === 0 ? 'disabled' : errorAlerts.timeoutSec + 's'})`)

    const result = await errorAlerter.fire(
      'test',
      'This is a synthetic error alert from `whatsapp-monitor error-alerts test`. If you see this in your agent / notification channel, the error-alerts pipeline is working.',
      { source: 'error-alerts test' },
      { force: true }
    )

    if (!result.fired) {
      fail(`error-alerter did not fire (reason: ${result.reason ?? 'unknown'})`)
    }

    console.log('[ok]   log append')

    if (result.spawnError) {
      fail(`child spawn failed: ${result.spawnError}`)
    }
    if (result.timedOut) {
      fail(`child timed out after ${result.elapsedMs}ms (timeoutSec=${errorAlerts.timeoutSec})`)
    }

    const exitLabel = result.signal ? `signal=${result.signal}` : `code=${result.exitCode}`
    const ok = result.exitCode === 0
    console.log(`[${ok ? 'ok  ' : 'fail'}] child exited: ${exitLabel}, elapsed=${result.elapsedMs}ms`)

    if (result.stderrPreview) {
      console.log(`[info] stderr: ${verbose ? result.stderrPreview : truncate(result.stderrPreview, 200)}`)
    }

    if (!ok) {
      console.log('[result] failed')
      process.exit(1)
    }
    console.log('[result] ok')
    console.log('')
    console.log('note: error-alerts test verifies the pipeline spawn + exit, with throttling bypassed.')
    console.log('      it does NOT verify end-to-end delivery (e.g. the agent actually messaged you).')
    console.log('      for the real flow, force a trigger: stop competing WhatsApp Web device to test `conflict`,')
    console.log('      or simulate a broken notify.command to test `dispatchFailures`.')
  })

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max) + '…'
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

export { errorAlertsCommand }
