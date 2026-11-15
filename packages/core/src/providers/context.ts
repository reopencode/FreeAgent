import type { AppSettings } from '../api-types'

/** What a provider may read or persist about itself. */
export interface ProviderContext {
  dataDir: string
  config(): Record<string, unknown>
  saveConfig(patch: Record<string, unknown>): void
  secret(): string | undefined
  settings(): AppSettings
}

export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}
