import { useMemo } from 'react'
import type { ProviderSummary } from '@core/api-types'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select'
import { AUTO_LABELS } from '@/lib/format'
import { useModels, useProviders } from '@/lib/queries'
import { cn } from '@/lib/utils'

const GROUPS: { kind: ProviderSummary['kind']; label: string }[] = [
  { kind: 'api', label: 'APIs' },
  { kind: 'web', label: 'Web plans' },
  { kind: 'app', label: 'Apps' }
]

function StatusDot({ state }: { state: ProviderSummary['status']['state'] }): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-block size-1.5 shrink-0 rounded-full',
        state === 'ready' ? 'bg-emerald-500' : state === 'needs_setup' ? 'bg-amber-500' : 'bg-muted-foreground/40'
      )}
    />
  )
}

/** Picks Auto (with a capability hint), a provider, and for APIs optionally a specific model. */
export function TargetPicker({ value, onChange, compact }: { value: string; onChange: (v: string) => void; compact?: boolean }): React.JSX.Element {
  const providers = useProviders()
  const models = useModels()
  const [providerPart, modelPart] = value.split('::')
  const isAuto = value in AUTO_LABELS
  const selected = providers.data?.find((p) => p.id === providerPart)

  const providerModels = useMemo(
    () => (models.data?.models ?? []).filter((m) => m.providerId === providerPart),
    [models.data, providerPart]
  )

  // The website model comes from the Model name in Customize; it is selected on the site before each chat.
  const webModelLabel = !isAuto && selected?.kind === 'web' ? providerModels.find((m) => m.id !== 'default')?.name : undefined

  return (
    <div className="flex min-w-0 items-center gap-1">
      <Select value={isAuto ? value : providerPart} onValueChange={(v) => onChange(v)}>
        <SelectTrigger size="sm" className={cn('h-8 max-w-52 border-none bg-transparent shadow-none hover:bg-accent', compact && 'max-w-40')} aria-label="Provider">
          <SelectValue placeholder="Auto" />
        </SelectTrigger>
        <SelectContent position="popper" align="start" className="max-h-96">
          <SelectGroup>
            <SelectLabel>Automatic</SelectLabel>
            {Object.entries(AUTO_LABELS).map(([k, label]) => (
              <SelectItem key={k} value={k}>
                {label}
              </SelectItem>
            ))}
          </SelectGroup>
          {GROUPS.map((g) => {
            const list = (providers.data ?? []).filter((p) => p.kind === g.kind && p.enabled && p.id !== 'mock')
            if (!list.length) return null
            return (
              <SelectGroup key={g.kind}>
                <SelectSeparator />
                <SelectLabel>{g.label}</SelectLabel>
                {list.map((p) => (
                  <SelectItem key={p.id} value={p.id} disabled={p.status.state === 'unavailable'}>
                    <StatusDot state={p.status.state} />
                    {p.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            )
          })}
          {providers.data?.some((p) => p.id === 'mock' && p.enabled) && (
            <SelectGroup>
              <SelectSeparator />
              <SelectItem value="mock">
                <StatusDot state="ready" />
                Offline demo
              </SelectItem>
            </SelectGroup>
          )}
        </SelectContent>
      </Select>
      {webModelLabel && (
        <span className="max-w-48 truncate px-1 text-sm text-muted-foreground" title={`Selected on the website: ${webModelLabel}. Change it in Customize → Providers.`} aria-label="Model">
          {webModelLabel}
        </span>
      )}
      {!isAuto && selected?.kind === 'api' && providerModels.length > 1 && (
        <Select value={modelPart ?? '__default'} onValueChange={(m) => onChange(m === '__default' ? providerPart : `${providerPart}::${m}`)}>
          <SelectTrigger size="sm" className="h-8 max-w-48 border-none bg-transparent text-muted-foreground shadow-none hover:bg-accent" aria-label="Model">
            <SelectValue placeholder="Default model" />
          </SelectTrigger>
          <SelectContent position="popper" align="start" className="max-h-96">
            <SelectItem value="__default">Default model</SelectItem>
            {providerModels.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                <span className="truncate">{m.name}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  )
}
