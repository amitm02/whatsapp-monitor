import { Command } from 'commander'
import { loadConfig, resolveNotifyDefaults } from '../../config.js'
import { Dispatcher } from '../../dispatcher.js'
import type { NotificationPayload } from '../../types.js'

const notifyCommand = new Command('notify').description('Notify pipeline utilities')

notifyCommand
  .command('test')
  .description('Run notify.command once with a synthetic payload (for verifying wiring).')
  .option('-v, --verbose', 'Show extra output')
  .action(async (options) => {
    const verbose = Boolean(options.verbose)
    const config = await loadConfig()
    const notify = resolveNotifyDefaults(config.notify)

    if (!notify.command) {
      console.error('No notify.command configured in ~/.whatsapp-monitor/config.json.')
      console.error('Example:')
      console.error('  "notify": {')
      console.error('    "command": "tee -a /tmp/wam-test.jsonl"')
      console.error('  }')
      process.exit(1)
    }

    console.error(`notify.command: ${notify.command}`)
    console.error(`notify log:     ${notify.logFile}`)

    const dispatcher = new Dispatcher({
      command: notify.command,
      logFile: notify.logFile,
      verbose,
      onWarning: (msg) => console.error(`[warn] ${msg}`),
    })

    const payload = syntheticPayload()
    console.error('Dispatching synthetic payload...')
    await dispatcher.dispatch(payload)
    await dispatcher.drain()
    console.error('Done.')
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

export { notifyCommand }
