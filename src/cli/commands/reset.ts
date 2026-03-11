import { Command } from 'commander'
import { rm } from 'fs/promises'
import { existsSync } from 'fs'
import { loadConfig } from '../../config.js'

export const resetCommand = new Command('reset')
  .description('Reset authentication (requires re-linking)')
  .option('-y, --yes', 'Skip confirmation prompt')
  .action(async (options) => {
    const config = await loadConfig()

    if (!existsSync(config.authDir)) {
      console.log('Nothing to reset.')
      return
    }

    console.log('This will delete:')
    console.log(`  - Auth directory: ${config.authDir}`)
    console.log('')

    if (!options.yes) {
      const readline = await import('readline')
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      })

      const answer = await new Promise<string>((resolve) => {
        rl.question('Are you sure? (y/N) ', resolve)
      })
      rl.close()

      if (answer.toLowerCase() !== 'y') {
        console.log('Aborted.')
        return
      }
    }

    await rm(config.authDir, { recursive: true })
    console.log('✓ Auth directory deleted')

    console.log('')
    console.log('Run "whatsapp-monitor link" to re-link your account.')
  })
