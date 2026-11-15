import { homedir } from 'node:os'
import { join } from 'node:path'

export function defaultDataDir(): string {
  return process.env.FREEAGENT_DATA_DIR || join(homedir(), '.freeagent')
}
