import type { ProviderSummary } from '@core/api-types'

export function timeAgo(ts: number | null | undefined): string {
  if (!ts) return 'never'
  const diff = Date.now() - ts
  const future = diff < 0
  const s = Math.abs(diff) / 1000
  const fmt = (n: number, unit: string): string => {
    const v = Math.round(n)
    return future ? `in ${v} ${unit}${v === 1 ? '' : 's'}` : `${v} ${unit}${v === 1 ? '' : 's'} ago`
  }
  if (s < 45) return future ? 'in a few seconds' : 'just now'
  if (s < 3600) return fmt(s / 60, 'minute')
  if (s < 86400) return fmt(s / 3600, 'hour')
  return fmt(s / 86400, 'day')
}

export const AUTO_LABELS: Record<string, string> = {
  auto: 'Auto',
  'auto-code': 'Auto · coding',
  'auto-fast': 'Auto · fast',
  'auto-long': 'Auto · long context',
  'auto-vision': 'Auto · vision',
  'auto-reasoning': 'Auto · reasoning'
}

export function targetLabel(target: string, providers?: ProviderSummary[]): string {
  if (AUTO_LABELS[target]) return AUTO_LABELS[target]
  const [pid, model] = target.split('::')
  const p = providers?.find((x) => x.id === pid)
  const name = p?.name ?? pid
  return model && model !== 'default' ? `${name} · ${model}` : name
}

export function providerName(id: string | undefined, providers?: ProviderSummary[]): string {
  if (!id) return 'Unknown'
  return providers?.find((p) => p.id === id)?.name ?? id
}

const CRON_LABELS: Record<string, string> = {
  '0 * * * *': 'Every hour',
  '*/15 * * * *': 'Every 15 minutes',
  '*/30 * * * *': 'Every 30 minutes',
  '0 9 * * *': 'Every day at 09:00',
  '0 18 * * *': 'Every day at 18:00',
  '0 9 * * 1': 'Every Monday at 09:00',
  '0 9 * * 1-5': 'Weekdays at 09:00'
}

export const SCHEDULE_PRESETS = [
  { value: '', label: 'Manual only' },
  ...Object.entries(CRON_LABELS).map(([value, label]) => ({ value, label }))
]

export function scheduleLabel(schedule: string | null): string {
  if (!schedule) return 'Manual only'
  return CRON_LABELS[schedule] ?? `Cron: ${schedule}`
}
