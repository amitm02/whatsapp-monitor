import { Command } from 'commander'
import { createRequire } from 'module'
import { linkCommand } from './commands/link.js'
import { groupsCommand } from './commands/groups.js'
import { eventsCommand } from './commands/events.js'
import { configCommand } from './commands/config.js'
import { messagesCommand } from './commands/messages.js'
import { resetCommand } from './commands/reset.js'
import { runCommand } from './commands/run.js'
import { notifyCommand } from './commands/notify.js'

const require = createRequire(import.meta.url)
const { version } = require('../../package.json')

const program = new Command()

program
  .name('whatsapp-monitor')
  .description('Read-only WhatsApp monitoring service')
  .version(version)

program.addCommand(runCommand)
program.addCommand(notifyCommand)
program.addCommand(linkCommand)
program.addCommand(groupsCommand)
program.addCommand(configCommand)
program.addCommand(messagesCommand)
program.addCommand(eventsCommand)
program.addCommand(resetCommand)

program.parse()
