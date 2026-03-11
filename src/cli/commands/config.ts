import { Command } from 'commander'
import {
  loadConfig,
  addToAllowlist,
  removeFromAllowlist,
  getConfigPath,
} from '../../config.js'

export const configCommand = new Command('config')
  .description('Manage allowlist configuration')

configCommand
  .command('list')
  .description('Show current configuration')
  .action(async () => {
    const config = await loadConfig()

    console.log('\nWhatsApp Monitor Configuration')
    console.log('─'.repeat(50))
    console.log(`\nConfig file: ${getConfigPath()}`)
    console.log(`Auth directory: ${config.authDir}`)
    console.log('\nAllowed Groups:')
    if (config.allowedGroups.length === 0) {
      console.log('  (none)')
    } else {
      for (const id of config.allowedGroups) {
        console.log(`  - ${id}`)
      }
    }
    console.log('\nAllowed Contacts:')
    if (config.allowedContacts.length === 0) {
      console.log('  (none)')
    } else {
      for (const id of config.allowedContacts) {
        console.log(`  - ${id}`)
      }
    }
    console.log('')
  })

configCommand
  .command('add <id>')
  .description('Add a group or contact to the allowlist')
  .action(async (id: string) => {
    try {
      await addToAllowlist(id)
      console.log(`Added ${id} to allowlist`)
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`)
      process.exit(1)
    }
  })

configCommand
  .command('remove <id>')
  .description('Remove a group or contact from the allowlist')
  .action(async (id: string) => {
    await removeFromAllowlist(id)
    console.log(`Removed ${id} from allowlist`)
  })
