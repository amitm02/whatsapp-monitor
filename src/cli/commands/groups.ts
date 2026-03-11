import { Command } from 'commander'
import { createClient } from '../utils.js'

export const groupsCommand = new Command('groups')
  .description('List all groups with their IDs')
  .option('--json', 'Output as JSON')
  .option('-v, --verbose', 'Enable debug output')
  .action(async (options) => {
    const { client, config } = await createClient({ verbose: options.verbose })

    await client.connect()

    // Wait for connection
    await new Promise<void>((resolve) => {
      const check = () => {
        if (client.isConnected()) {
          resolve()
        } else {
          setTimeout(check, 100)
        }
      }
      check()
    })

    const groups = await client.listGroups()

    if (options.json) {
      console.log(JSON.stringify(groups, null, 2))
    } else {
      console.log('\nGroups:\n')
      console.log('─'.repeat(80))

      for (const group of groups) {
        const isAllowed = config.allowedGroups.includes(group.id)
        const status = isAllowed ? '✓' : ' '
        const participants = ` (${group.participantCount} members)`

        console.log(`[${status}] ${group.name}${participants}`)
        console.log(`    ID: ${group.id}`)
        console.log('')
      }

      console.log('─'.repeat(80))
      console.log(`\nTotal: ${groups.length} groups`)
      console.log('[✓] = In allowlist')
      console.log(
        '\nTo add a group to the allowlist, run: whatsapp-monitor config add <id>'
      )
    }

    await client.disconnect()
    process.exit(0)
  })
