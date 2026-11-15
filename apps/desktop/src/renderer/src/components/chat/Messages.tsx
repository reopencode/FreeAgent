import { useState } from 'react'
import type { CouncilAnswer, RouteAttempt, ToolStep } from '@core/api-types'
import { useMutation } from '@tanstack/react-query'
import { AlertCircle, Check, ChevronRight, CircleSlash, Copy, Loader2, ShieldQuestion, Users, Wrench, X } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { api } from '@/lib/api'
import { providerName } from '@/lib/format'
import { useProviders } from '@/lib/queries'
import { cn } from '@/lib/utils'
import { Markdown } from './Markdown'

export interface AssistantView {
  content: string
  providerId?: string
  model?: string
  attempts?: RouteAttempt[]
  steps?: ToolStep[]
  council?: CouncilAnswer[]
  error?: string
  status?: string
  streaming?: boolean
  approvals?: Record<string, string>
  durationMs?: number
}

export function UserMessage({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-secondary px-4 py-2.5 text-[15px] leading-6 break-words whitespace-pre-wrap">{text}</div>
    </div>
  )
}

function argsPreview(args: string): string {
  try {
    const obj = JSON.parse(args) as Record<string, unknown>
    const first = obj.command ?? obj.path ?? obj.url ?? obj.query ?? obj.task ?? obj.code
    if (typeof first === 'string') return first.split('\n')[0].slice(0, 120)
    return JSON.stringify(obj).slice(0, 120)
  } catch {
    return args.slice(0, 120)
  }
}

function StepIcon({ status }: { status: ToolStep['status'] }): React.JSX.Element {
  if (status === 'running') return <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
  if (status === 'pending_approval') return <ShieldQuestion className="size-3.5 text-amber-600" />
  if (status === 'done') return <Check className="size-3.5 text-emerald-600" />
  if (status === 'denied') return <CircleSlash className="size-3.5 text-muted-foreground" />
  return <X className="size-3.5 text-destructive" />
}

function ToolStepCard({ step, approvalId }: { step: ToolStep; approvalId?: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const decide = useMutation({
    mutationFn: (approved: boolean) => api.post(`/api/approvals/${approvalId}`, { approved }),
    onError: (e) => toast.error(e.message)
  })
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg border bg-card/60 text-sm">
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-left">
        <StepIcon status={step.status} />
        <Wrench className="size-3.5 text-muted-foreground" />
        <span className="font-mono text-xs font-medium">{step.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{argsPreview(step.args)}</span>
        <ChevronRight className={cn('size-4 text-muted-foreground transition-transform', open && 'rotate-90')} />
      </CollapsibleTrigger>
      {step.status === 'pending_approval' && approvalId && (
        <div className="flex flex-wrap items-center gap-2 border-t bg-amber-500/5 px-3 py-2">
          <span className="flex-1 text-xs text-muted-foreground">This step can change files or run code. Allow it?</span>
          <Button size="sm" variant="outline" disabled={decide.isPending} onClick={() => decide.mutate(false)}>
            Deny
          </Button>
          <Button size="sm" disabled={decide.isPending} onClick={() => decide.mutate(true)}>
            Allow
          </Button>
        </div>
      )}
      <CollapsibleContent>
        <div className="space-y-2 border-t px-3 py-2">
          <div>
            <div className="mb-1 text-[11px] font-medium text-muted-foreground uppercase">Input</div>
            <pre className="max-h-48 overflow-auto rounded bg-muted/60 p-2 font-mono text-xs whitespace-pre-wrap">{prettyJson(step.args)}</pre>
          </div>
          {step.output !== undefined && (
            <div>
              <div className="mb-1 text-[11px] font-medium text-muted-foreground uppercase">Output</div>
              <pre className="max-h-64 overflow-auto rounded bg-muted/60 p-2 font-mono text-xs whitespace-pre-wrap">{step.output}</pre>
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function prettyJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2)
  } catch {
    return s
  }
}

function CouncilPanel({ answers }: { answers: CouncilAnswer[] }): React.JSX.Element {
  const providers = useProviders()
  const [open, setOpen] = useState(false)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg border bg-card/60 text-sm">
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-left">
        <Users className="size-3.5 text-muted-foreground" />
        <span className="flex-1 text-xs font-medium">
          Council: {answers.filter((a) => !a.error).length} of {answers.length} answered
          <span className="ml-1 font-normal text-muted-foreground">({answers.map((a) => providerName(a.providerId, providers.data)).join(', ')})</span>
        </span>
        <ChevronRight className={cn('size-4 text-muted-foreground transition-transform', open && 'rotate-90')} />
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-3 border-t px-3 py-3">
        {answers.map((a) => (
          <div key={a.providerId}>
            <div className="mb-1 text-xs font-medium">
              {providerName(a.providerId, providers.data)}
              {a.model && a.model !== 'default' && <span className="font-normal text-muted-foreground"> · {a.model}</span>}
            </div>
            {a.error ? <p className="text-xs text-destructive">{a.error}</p> : <Markdown text={a.text} />}
          </div>
        ))}
      </CollapsibleContent>
    </Collapsible>
  )
}

export function AssistantMessage({ view }: { view: AssistantView }): React.JSX.Element {
  const providers = useProviders()
  const fallbacks = (view.attempts ?? []).filter((a) => a.error)
  const copy = (): void => {
    void navigator.clipboard.writeText(view.content).then(() => toast.success('Copied'))
  }
  return (
    <div className="group flex flex-col gap-2">
      {view.council && view.council.length > 0 && <CouncilPanel answers={view.council} />}
      {view.steps?.map((s) => <ToolStepCard key={s.id} step={s} approvalId={view.approvals?.[s.id]} />)}
      {view.content && <Markdown text={view.content} />}
      {view.streaming && !view.error && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          {view.status ?? (view.content ? 'Writing…' : 'Thinking…')}
        </div>
      )}
      {view.error && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span className="break-words">{view.error}</span>
        </div>
      )}
      {(view.providerId || view.content) && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          {view.providerId && (
            <Badge variant="outline" className="font-normal">
              {providerName(view.providerId, providers.data)}
              {view.model && view.model !== 'default' && <span className="text-muted-foreground"> · {view.model}</span>}
            </Badge>
          )}
          {fallbacks.length > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="outline" className="border-amber-500/40 font-normal text-amber-700 dark:text-amber-400">
                  {fallbacks.length} fallback{fallbacks.length > 1 ? 's' : ''}
                </Badge>
              </TooltipTrigger>
              <TooltipContent className="max-w-sm">
                {fallbacks.map((f, i) => (
                  <div key={i}>
                    {providerName(f.providerId, providers.data)}: {f.error}
                  </div>
                ))}
              </TooltipContent>
            </Tooltip>
          )}
          {view.durationMs !== undefined && <span>{(view.durationMs / 1000).toFixed(1)}s</span>}
          {!view.streaming && view.content && (
            <Button variant="ghost" size="icon" className="size-6 opacity-0 group-hover:opacity-100" onClick={copy} aria-label="Copy reply">
              <Copy className="size-3.5" />
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
