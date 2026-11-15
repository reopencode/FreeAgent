import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultDataDir } from '@freeagent/core/paths'

export interface ServerConfig {
  host: string
  port: number
  dataDir: string
  token: string
  version: string
}

export const VERSION = '0.1.0'
export const DEFAULT_PORT = 47821

/** Stable bearer token, so Claude Desktop and other clients keep working across restarts. */
export function loadToken(dataDir: string): string {
  if (process.env.FREEAGENT_TOKEN) return process.env.FREEAGENT_TOKEN
  const file = join(dataDir, 'token')
  if (existsSync(file)) return readFileSync(file, 'utf8').trim()
  mkdirSync(dataDir, { recursive: true })
  const token = 'fa_' + randomBytes(24).toString('base64url')
  writeFileSync(file, token, { mode: 0o600 })
  try {
    chmodSync(file, 0o600)
  } catch {
    // Windows ignores POSIX modes.
  }
  return token
}

export function loadConfig(): ServerConfig {
  const dataDir = defaultDataDir()
  return {
    host: process.env.FREEAGENT_HOST || '127.0.0.1',
    port: Number(process.env.FREEAGENT_PORT || DEFAULT_PORT),
    dataDir,
    token: loadToken(dataDir),
    version: VERSION
  }
}

/** Path of the stdio MCP bridge that Claude Desktop launches. */
export function mcpStdioScript(): string {
  if (process.env.FREEAGENT_MCP_STDIO) return process.env.FREEAGENT_MCP_STDIO
  const here = dirname(fileURLToPath(import.meta.url))
  const sibling = join(here, 'mcp-stdio.js')
  if (existsSync(sibling)) return sibling
  return join(here, '..', 'dist', 'mcp-stdio.js')
}
