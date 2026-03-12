import { Command } from 'commander'
import { createRequire } from 'module'
import { linkCommand } from './commands/link.js'
import { groupsCommand } from './commands/groups.js'
import { eventsCommand } from './commands/events.js'
import { configCommand } from './commands/config.js'
import { messagesCommand } from './commands/messages.js'
import { resetCommand } from './commands/reset.js'

const require = createRequire(import.meta.url)
const { version } = require('../../package.json')

const program = new Command()

program
  .name('whatsapp-monitor')
  .description('Read-only WhatsApp monitoring tool')
  .version(version)

program.addCommand(linkCommand)
program.addCommand(groupsCommand)
program.addCommand(eventsCommand)
program.addCommand(configCommand)
program.addCommand(messagesCommand)
program.addCommand(resetCommand)

program.parse()
