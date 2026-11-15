import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface TelegramConfig {
  botToken: string
  allowedIds: Set<number>
  freeagentUrl: string
  freeagentToken: string
  stateFile: string
}

export function parseAllowedIds(raw: string | undefined): Set<number> {
  const ids = new Set<number>()
  for (const part of (raw ?? '').split(/[\s,]+/)) {
    if (!part) continue
    const n = Number(part)
    if (!Number.isSafeInteger(n)) throw new Error(`TELEGRAM_ALLOWED_IDS contains "${part}", which is not a numeric Telegram user id.`)
    ids.add(n)
  }
  return ids
}

export function isAllowed(allowed: ReadonlySet<number>, userId: number | undefined): boolean {
  return userId !== undefined && allowed.has(userId)
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): TelegramConfig {
  const botToken = env.TELEGRAM_BOT_TOKEN?.trim()
  if (!botToken) throw new Error('TELEGRAM_BOT_TOKEN is not set. Create a bot with @BotFather and export its token.')

  const dataDir = env.FREEAGENT_DATA_DIR?.trim() || join(homedir(), '.freeagent')
  let freeagentToken = env.FREEAGENT_TOKEN?.trim()
  if (!freeagentToken) {
    const tokenFile = join(dataDir, 'token')
    try {
      freeagentToken = readFileSync(tokenFile, 'utf8').trim()
    } catch {
      throw new Error(`FREEAGENT_TOKEN is not set and ${tokenFile} could not be read. Start FreeAgent once or set FREEAGENT_TOKEN.`)
    }
  }
  if (!freeagentToken) throw new Error('The FreeAgent token is empty.')

  return {
    botToken,
    allowedIds: parseAllowedIds(env.TELEGRAM_ALLOWED_IDS),
    freeagentUrl: (env.FREEAGENT_URL?.trim() || 'http://127.0.0.1:47821').replace(/\/+$/, ''),
    freeagentToken,
    stateFile: env.TELEGRAM_STATE_FILE?.trim() || join(dataDir, 'telegram-links.json')
  }
}
