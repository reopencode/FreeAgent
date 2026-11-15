import { COMMANDS, createBot } from './bot'
import { loadConfig } from './config'
import { FreeAgentClient } from './freeagent'
import { LinkStore } from './links'

async function main(): Promise<void> {
  const cfg = loadConfig()
  const client = new FreeAgentClient(cfg.freeagentUrl, cfg.freeagentToken)

  try {
    await client.health()
  } catch (err) {
    console.error(`FreeAgent is not reachable at ${cfg.freeagentUrl}: ${err instanceof Error ? err.message : String(err)}`)
    console.error('Start the desktop app or run "pnpm server", then try again.')
    process.exit(1)
  }

  if (cfg.allowedIds.size === 0) {
    console.warn('TELEGRAM_ALLOWED_IDS is empty: the bot is locked and replies to everyone that it is private. Set it to a comma-separated list of Telegram user ids.')
  }

  const bot = createBot({ token: cfg.botToken, allowedIds: cfg.allowedIds, client, links: new LinkStore(cfg.stateFile) })
  const stop = (): void => {
    void bot.stop()
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)

  await bot.api.setMyCommands(COMMANDS).catch(() => undefined)
  await bot.start({ onStart: (me) => console.log(`Telegram bot @${me.username} is running and connected to ${cfg.freeagentUrl}`) })
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
