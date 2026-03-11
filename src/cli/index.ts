import { Command } from 'commander'
import { linkCommand } from './commands/link.js'
import { groupsCommand } from './commands/groups.js'
import { eventsCommand } from './commands/events.js'
import { configCommand } from './commands/config.js'
import { messagesCommand } from './commands/messages.js'
import { resetCommand } from './commands/reset.js'

const program = new Command()

program
  .name('whatsapp-monitor')
  .description('Read-only WhatsApp monitoring tool')
  .version('1.0.0')

program.addCommand(linkCommand)
program.addCommand(groupsCommand)
program.addCommand(eventsCommand)
program.addCommand(configCommand)
program.addCommand(messagesCommand)
program.addCommand(resetCommand)

program.parse()
