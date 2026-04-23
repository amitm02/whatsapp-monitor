import { Command } from 'commander'
import { existsSync } from 'fs'
import { join } from 'path'
import { loadConfig, resolveAlerts, CONFIG_FILE, getConfigDir } from '../../config.js'
import { Alerter, defaultAlertStatePath } from '../../alerts.js'

const alertsCommand = new Command('alerts').description('Operator-alert pipeline utilities')

alertsCommand
  .command('test')
  .description('Fire a synthetic alert through alerts.command (for verifying wiring).')
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

    info('alerts test (dry run)')

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

    const alerts = resolveAlerts(config!.alerts)
    if (!alerts.enabled) {
      fail('no alerts.command is configured; nothing to test. Add an `alerts` block to ~/.whatsapp-monitor/config.json.')
    }

    info(`[info] alerts command: sh -c "${alerts.command}"`)
    info(`[info] alerts log:     ${alerts.logFile}`)
    info(`[info] throttleSec:    ${alerts.throttleSec}`)
    info(`[info] timeoutSec:     ${alerts.timeoutSec === 0 ? 'disabled' : alerts.timeoutSec}`)
    const t = alerts.triggers
    const triggers: string[] = []
    if (t.conflict) triggers.push('conflict')
    if (t.loggedOut) triggers.push('loggedOut')
    if (t.extendedDisconnectAfterSec !== null) triggers.push(`extendedDisconnect(${t.extendedDisconnectAfterSec}s)`)
    if (t.dispatchFailuresAfter !== null) triggers.push(`dispatchFailures(${t.dispatchFailuresAfter} consecutive)`)
    info(`[info] triggers:       [${triggers.join(', ')}]`)

    const alerter = new Alerter({
      alerts,
      stateFile: join(getConfigDir(), '.alert-state.test.json'),
      onWarning: (msg) => console.log(`[warn] ${msg}`),
    })

    step(`appending to log: ${alerts.logFile}`)
    step(`spawning child and waiting (timeout: ${alerts.timeoutSec === 0 ? 'disabled' : alerts.timeoutSec + 's'})`)

    const result = await alerter.fire(
      'test',
      'This is a synthetic alert from `whatsapp-monitor alerts test`. If you see this in your agent / notification channel, the alerts pipeline is working.',
      { source: 'alerts test' },
      { force: true }
    )

    if (!result.fired) {
      fail(`alerter did not fire (reason: ${result.reason ?? 'unknown'})`)
    }

    console.log('[ok]   log append')

    if (result.spawnError) {
      fail(`child spawn failed: ${result.spawnError}`)
    }
    if (result.timedOut) {
      fail(`child timed out after ${result.elapsedMs}ms (timeoutSec=${alerts.timeoutSec})`)
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
    console.log('note: alerts test verifies the alerts pipeline spawn + exit, with throttling bypassed.')
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

export { alertsCommand }
