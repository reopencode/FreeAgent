import { serve } from '@hono/node-server'
import { createCore } from '@freeagent/core'
import { createApp } from './app'
import { loadConfig } from './config'
import { Scheduler } from './scheduler'

const cfg = loadConfig()
const core = createCore({ dataDir: cfg.dataDir })
const scheduler = new Scheduler(core)
const app = createApp(core, cfg, scheduler)

const server = serve({ fetch: app.fetch, hostname: cfg.host, port: cfg.port }, (info) => {
  scheduler.start()
  const url = `http://${cfg.host}:${info.port}`
  console.log(`FreeAgent server ${cfg.version} listening on ${url}`)
  console.log(`Data directory: ${cfg.dataDir}`)
  if (!process.env.FREEAGENT_QUIET) {
    console.log(`Token: ${cfg.token}`)
    console.log(`Claude Code: ANTHROPIC_BASE_URL=${url} ANTHROPIC_AUTH_TOKEN=${cfg.token} claude`)
  }
  process.send?.({ type: 'ready', port: info.port })
})

let stopping = false
async function shutdown(): Promise<void> {
  if (stopping) return
  stopping = true
  scheduler.stop()
  server.close()
  await core.dispose().catch(() => undefined)
  process.exit(0)
}

process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
process.on('disconnect', () => void shutdown())
