import { useEffect, useState } from 'react'
import type { Automation, AutomationRun, ChatMode } from '@core/api-types'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CalendarClock, CheckCircle2, Clock, Loader2, Pencil, Play, Plus, Square, Trash2, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Markdown } from '@/components/chat/Markdown'
import { TargetPicker } from '@/components/chat/TargetPicker'
import { api } from '@/lib/api'
import { SCHEDULE_PRESETS, scheduleLabel, targetLabel, timeAgo } from '@/lib/format'
import { keys, useAutomations, useProjects, useProviders, useRuns, type AutomationItem } from '@/lib/queries'
import { cn } from '@/lib/utils'

type Draft = Pick<Automation, 'name' | 'prompt' | 'projectId' | 'schedule' | 'mode' | 'target' | 'enabled'>

const EMPTY: Draft = { name: '', prompt: '', projectId: null, schedule: '0 9 * * *', mode: 'agent', target: 'auto', enabled: true }

const EXAMPLES: Draft[] = [
  { ...EMPTY, name: 'Morning tech brief', prompt: 'Search the web for the most important AI and developer-tool news from the last 24 hours. Give me 5 bullet points with links.', schedule: '0 9 * * *' },
  { ...EMPTY, name: 'Weekly repo health check', prompt: 'In the project folder, run the test suite and list any failing tests, outdated dependencies and TODO comments. Keep it short.', schedule: '0 9 * * 1' }
]

function AutomationDialog({ open, onOpenChange, initial, editingId }: { open: boolean; onOpenChange: (o: boolean) => void; initial: Draft; editingId?: string }): React.JSX.Element {
  const qc = useQueryClient()
  const projects = useProjects()
  const [d, setD] = useState<Draft>(initial)
  const [custom, setCustom] = useState(false)

  useEffect(() => {
    if (open) {
      const { name, prompt, projectId, schedule, mode, target, enabled } = initial
      setD({ name, prompt, projectId, schedule, mode, target, enabled })
      setCustom(!!initial.schedule && !SCHEDULE_PRESETS.some((p) => p.value === initial.schedule))
    }
  }, [open, initial])

  const save = useMutation({
    mutationFn: () => (editingId ? api.patch(`/api/automations/${editingId}`, d) : api.post('/api/automations', d)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.automations })
      toast.success(editingId ? 'Automation updated' : 'Automation created')
      onOpenChange(false)
    },
    onError: (e) => toast.error(e.message)
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editingId ? 'Edit automation' : 'New automation'}</DialogTitle>
          <DialogDescription>A saved prompt that runs on a schedule or when you click Run.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="a-name">Name</Label>
            <Input id="a-name" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="Morning news digest" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="a-prompt">Prompt</Label>
            <Textarea id="a-prompt" rows={5} value={d.prompt} onChange={(e) => setD({ ...d, prompt: e.target.value })} placeholder="What should the agent do each time?" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label>Schedule</Label>
              <Select
                value={custom ? '__custom' : (d.schedule ?? '__manual')}
                onValueChange={(v) => {
                  if (v === '__custom') setCustom(true)
                  else {
                    setCustom(false)
                    setD({ ...d, schedule: v === '__manual' ? null : v })
                  }
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SCHEDULE_PRESETS.map((p) => (
                    <SelectItem key={p.value || 'manual'} value={p.value || '__manual'}>
                      {p.label}
                    </SelectItem>
                  ))}
                  <SelectItem value="__custom">Custom cron…</SelectItem>
                </SelectContent>
              </Select>
              {custom && <Input value={d.schedule ?? ''} onChange={(e) => setD({ ...d, schedule: e.target.value || null })} placeholder="*/20 * * * *" className="font-mono" />}
            </div>
            <div className="grid gap-1.5">
              <Label>Mode</Label>
              <Select value={d.mode} onValueChange={(v) => setD({ ...d, mode: v as ChatMode })}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="chat">Chat (answer only)</SelectItem>
                  <SelectItem value="agent">Agent (can use tools)</SelectItem>
                  <SelectItem value="council">Council (several models)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>Project</Label>
              <Select value={d.projectId ?? 'none'} onValueChange={(v) => setD({ ...d, projectId: v === 'none' ? null : v })}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No project</SelectItem>
                  {(projects.data ?? []).map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>Provider</Label>
              <div className="rounded-md border">
                <TargetPicker value={d.target} onChange={(t) => setD({ ...d, target: t })} compact />
              </div>
            </div>
          </div>
          {d.mode === 'agent' && (
            <p className="text-xs text-muted-foreground">
              Steps that change files or run code wait for your approval (a banner appears at the top of the app) unless auto-approve is on in Customize → General.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!d.name.trim() || !d.prompt.trim() || save.isPending} onClick={() => save.mutate()}>
            {save.isPending && <Loader2 className="animate-spin" />}
            {editingId ? 'Save' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RunStatusIcon({ status }: { status: AutomationRun['status'] }): React.JSX.Element {
  if (status === 'running') return <Loader2 className="size-4 animate-spin text-muted-foreground" />
  if (status === 'success') return <CheckCircle2 className="size-4 text-emerald-600" />
  return <XCircle className="size-4 text-destructive" />
}

function RunHistory({ automation }: { automation: AutomationItem }): React.JSX.Element {
  const runs = useRuns(automation.id)
  const [selected, setSelected] = useState<string | undefined>()
  const run = runs.data?.find((r) => r.id === selected) ?? runs.data?.[0]
  if (runs.isLoading) return <Skeleton className="h-40 w-full" />
  if (!runs.data?.length) {
    return <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No runs yet. Click Run to try it now.</div>
  }
  return (
    <div className="grid gap-3 md:grid-cols-[200px_1fr]">
      <div className="flex flex-row gap-1 overflow-x-auto md:flex-col">
        {runs.data.map((r) => (
          <button
            key={r.id}
            onClick={() => setSelected(r.id)}
            className={cn('flex shrink-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent', run?.id === r.id && 'bg-accent')}
          >
            <RunStatusIcon status={r.status} />
            <span>{new Date(r.startedAt).toLocaleString()}</span>
          </button>
        ))}
      </div>
      {run && (
        <div className="min-w-0 rounded-lg border bg-card p-4">
          <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <RunStatusIcon status={run.status} />
            {run.status === 'running' ? 'Running…' : run.finishedAt ? `Took ${((run.finishedAt - run.startedAt) / 1000).toFixed(1)}s` : ''}
            {run.log.filter((e) => e.type === 'route').map((e, i) => e.type === 'route' && <Badge key={i} variant="outline">{e.providerId}</Badge>)}
            {run.log.filter((e) => e.type === 'tool_call').length > 0 && <span>{run.log.filter((e) => e.type === 'tool_call').length} tool calls</span>}
          </div>
          {run.error && <p className="mb-2 text-sm text-destructive">{run.error}</p>}
          {run.output ? <Markdown text={run.output} /> : run.status === 'running' ? <p className="text-sm text-muted-foreground">Waiting for output…</p> : null}
        </div>
      )}
    </div>
  )
}

export function AutomationsView(): React.JSX.Element {
  const qc = useQueryClient()
  const automations = useAutomations()
  const providers = useProviders()
  const [dialog, setDialog] = useState<{ open: boolean; initial: Draft; id?: string }>({ open: false, initial: EMPTY })
  const [expanded, setExpanded] = useState<string | undefined>()

  const invalidate = (): void => void qc.invalidateQueries({ queryKey: keys.automations })
  const run = useMutation({
    mutationFn: (id: string) => api.post(`/api/automations/${id}/run`),
    onSuccess: (_d, id) => {
      setExpanded(id)
      invalidate()
      void qc.invalidateQueries({ queryKey: keys.runs(id) })
      toast.success('Run started')
    },
    onError: (e) => toast.error(e.message)
  })
  const cancel = useMutation({ mutationFn: (id: string) => api.post(`/api/automations/${id}/cancel`), onSuccess: invalidate })
  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.patch(`/api/automations/${id}`, { enabled }),
    onSuccess: invalidate,
    onError: (e) => toast.error(e.message)
  })
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/automations/${id}`),
    onSuccess: () => {
      invalidate()
      toast.success('Automation deleted')
    }
  })

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="font-serif text-3xl tracking-tight">Automations</h1>
            <p className="mt-1 text-sm text-muted-foreground">Prompts that run on a schedule while FreeAgent is open.</p>
          </div>
          <Button onClick={() => setDialog({ open: true, initial: EMPTY })}>
            <Plus />
            New automation
          </Button>
        </div>

        {automations.isLoading && (
          <div className="space-y-3">
            <Skeleton className="h-24" />
            <Skeleton className="h-24" />
          </div>
        )}
        {automations.isError && <p className="text-sm text-destructive">Could not load automations: {automations.error.message}</p>}

        {automations.data?.length === 0 && (
          <div className="rounded-xl border border-dashed p-8 text-center">
            <CalendarClock className="mx-auto mb-3 size-8 text-muted-foreground" />
            <p className="font-medium">No automations yet</p>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">Start from an example or write your own. Each run is saved with its output.</p>
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              {EXAMPLES.map((ex) => (
                <Button key={ex.name} variant="outline" onClick={() => setDialog({ open: true, initial: ex })}>
                  {ex.name}
                </Button>
              ))}
            </div>
          </div>
        )}

        <div className="space-y-3">
          {automations.data?.map((a) => (
            <div key={a.id} className="rounded-xl border bg-card">
              <div className="flex flex-wrap items-start gap-3 p-4">
                <button className="min-w-0 flex-1 text-left" onClick={() => setExpanded(expanded === a.id ? undefined : a.id)}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{a.name}</span>
                    <Badge variant="secondary" className="font-normal capitalize">
                      {a.mode}
                    </Badge>
                    {a.running && (
                      <Badge className="gap-1 font-normal">
                        <Loader2 className="size-3 animate-spin" />
                        Running
                      </Badge>
                    )}
                  </div>
                  <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{a.prompt}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <Clock className="size-3" />
                      {scheduleLabel(a.schedule)}
                    </span>
                    {a.enabled && a.nextRunAt && <span>Next {timeAgo(a.nextRunAt)}</span>}
                    <span>Last run {timeAgo(a.lastRunAt)}</span>
                    <span>{targetLabel(a.target, providers.data)}</span>
                  </div>
                </button>
                <div className="flex items-center gap-1">
                  <Switch checked={a.enabled} onCheckedChange={(enabled) => toggle.mutate({ id: a.id, enabled })} aria-label="Enabled" />
                  {a.running ? (
                    <Button variant="ghost" size="icon" onClick={() => cancel.mutate(a.id)} aria-label="Cancel run">
                      <Square className="size-3.5" />
                    </Button>
                  ) : (
                    <Button variant="ghost" size="icon" onClick={() => run.mutate(a.id)} aria-label="Run now">
                      <Play />
                    </Button>
                  )}
                  <Button variant="ghost" size="icon" onClick={() => setDialog({ open: true, initial: a, id: a.id })} aria-label="Edit">
                    <Pencil />
                  </Button>
                  <Button variant="ghost" size="icon" onClick={() => remove.mutate(a.id)} aria-label="Delete">
                    <Trash2 />
                  </Button>
                </div>
              </div>
              {expanded === a.id && (
                <div className="border-t p-4">
                  <RunHistory automation={a} />
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
      <AutomationDialog open={dialog.open} initial={dialog.initial} editingId={dialog.id} onOpenChange={(open) => setDialog((s) => ({ ...s, open }))} />
    </div>
  )
}
