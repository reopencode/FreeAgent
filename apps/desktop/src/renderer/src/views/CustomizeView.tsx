import { useEffect, useState } from 'react'
import type { AppSettings, ProviderSummary } from '@core/api-types'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  AppWindow,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  Globe,
  KeyRound,
  Loader2,
  LogIn,
  Plug,
  Plus,
  Trash2,
  Zap
} from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { useNav } from '@/lib/nav'
import { keys, useInfo, useMcpServers, useMemories, usePlugins, useProviders, useSettings, useSkills, useTools } from '@/lib/queries'
import { cn } from '@/lib/utils'

type Tab = 'providers' | 'integrations' | 'mcp' | 'general'

function openExternal(url: string): void {
  if (window.freeagent) void window.freeagent.openExternal(url)
  else window.open(url, '_blank', 'noopener')
}

function CopyField({ label, value, secret }: { label: string; value: string; secret?: boolean }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const [shown, setShown] = useState(!secret)
  return (
    <div className="grid gap-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <div className="flex gap-2">
        <code
          className={cn('min-w-0 flex-1 rounded-md border bg-muted px-2 py-1.5 font-mono text-xs break-all whitespace-pre-wrap', secret && !shown && 'cursor-pointer')}
          onClick={() => setShown(true)}
        >
          {shown ? value : '•'.repeat(24) + '  (click to show)'}
        </code>
        <Button
          variant="outline"
          size="icon"
          className="shrink-0"
          aria-label={`Copy ${label}`}
          onClick={() => {
            void navigator.clipboard.writeText(value)
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          }}
        >
          {copied ? <Check /> : <Copy />}
        </Button>
      </div>
    </div>
  )
}

const STATE_STYLE: Record<ProviderSummary['status']['state'], { label: string; className: string }> = {
  ready: { label: 'Ready', className: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400' },
  needs_setup: { label: 'Needs setup', className: 'bg-amber-500/15 text-amber-700 dark:text-amber-400' },
  unavailable: { label: 'Not installed', className: 'bg-muted text-muted-foreground' },
  error: { label: 'Error', className: 'bg-destructive/15 text-destructive' }
}

function SiteConfigDialog({ provider, open, onOpenChange }: { provider: ProviderSummary; open: boolean; onOpenChange: (o: boolean) => void }): React.JSX.Element {
  const [text, setText] = useState('')
  const [overridden, setOverridden] = useState(false)
  useEffect(() => {
    if (!open) return
    api
      .get<{ config: unknown; overridden: boolean }>(`/api/providers/${provider.id}/site`)
      .then((r) => {
        setText(JSON.stringify(r.config, null, 2))
        setOverridden(r.overridden)
      })
      .catch((e: Error) => toast.error(e.message))
  }, [open, provider.id])
  const save = useMutation({
    mutationFn: (body: unknown) => api.put<{ overridden: boolean; config: unknown }>(`/api/providers/${provider.id}/site`, body),
    onSuccess: (r) => {
      setOverridden(r.overridden)
      setText(JSON.stringify(r.config, null, 2))
      toast.success(r.overridden ? 'Selectors saved' : 'Reset to built-in selectors')
    },
    onError: (e) => toast.error(e.message)
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{provider.name} page selectors</DialogTitle>
          <DialogDescription>
            Websites change their markup. If sending or reading replies breaks, fix the CSS selectors here. If a popup keeps covering the chat box, put its close button&apos;s selector in <code>dismiss</code>. {overridden ? 'You are using a custom copy.' : 'These are the built-in defaults.'}
          </DialogDescription>
        </DialogHeader>
        <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={16} className="font-mono text-xs" spellCheck={false} />
        <DialogFooter>
          {overridden && (
            <Button variant="outline" onClick={() => save.mutate(null)}>
              Reset to defaults
            </Button>
          )}
          <Button
            onClick={() => {
              try {
                save.mutate(JSON.parse(text))
              } catch {
                toast.error('That is not valid JSON')
              }
            }}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ProviderRow({ p, index, count, onMove }: { p: ProviderSummary; index: number; count: number; onMove: (dir: -1 | 1) => void }): React.JSX.Element {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [secret, setSecret] = useState('')
  const [config, setConfig] = useState<Record<string, unknown>>(p.config)
  const [siteOpen, setSiteOpen] = useState(false)
  useEffect(() => setConfig(p.config), [p.config])

  const refresh = (): void => {
    void qc.invalidateQueries({ queryKey: keys.providers })
    void qc.invalidateQueries({ queryKey: keys.models })
  }
  const patch = useMutation({ mutationFn: (b: Record<string, unknown>) => api.patch(`/api/providers/${p.id}`, b), onSuccess: refresh, onError: (e) => toast.error(e.message) })
  const saveSecret = useMutation({
    mutationFn: (value: string | null) => api.put(`/api/providers/${p.id}/secret`, { secret: value }),
    onSuccess: () => {
      setSecret('')
      refresh()
      toast.success('Key saved (encrypted on this computer)')
    },
    onError: (e) => toast.error(e.message)
  })
  const test = useMutation({
    mutationFn: () => api.post<{ ok: boolean; message: string }>(`/api/providers/${p.id}/test`),
    onSuccess: (r) => {
      if (r.ok) toast.success(`${p.name}: ${r.message}`)
      else toast.error(`${p.name}: ${r.message}`)
      refresh()
    }
  })
  const connect = useMutation({
    mutationFn: () => api.post<{ message: string }>(`/api/providers/${p.id}/connect`),
    onSuccess: (r) => toast.info(r.message, { duration: 8000 }),
    onError: (e) => toast.error(e.message)
  })
  const check = useMutation({
    mutationFn: () => api.post<{ loggedIn: boolean }>(`/api/providers/${p.id}/check`),
    onSuccess: (r) => {
      if (r.loggedIn) toast.success(`Signed in to ${p.name}`)
      else toast.error(`Not signed in to ${p.name} yet`)
      refresh()
    },
    onError: (e) => toast.error(e.message)
  })
  const disconnect = useMutation({ mutationFn: () => api.post(`/api/providers/${p.id}/disconnect`), onSuccess: refresh })
  const isCustom = p.id.startsWith('custom_')
  const removeApi = useMutation({
    mutationFn: () => api.del(`/api/providers/${p.id}`),
    onSuccess: () => {
      refresh()
      toast.success(`${p.name} removed`)
    },
    onError: (e) => toast.error(e.message)
  })

  const st = STATE_STYLE[p.status.state]
  const configDirty = JSON.stringify(config) !== JSON.stringify(p.config)

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-xl border bg-card">
      <div className="flex items-center gap-3 p-3 sm:p-4">
        <div className="flex flex-col">
          <button className="text-muted-foreground hover:text-foreground disabled:opacity-30" disabled={index === 0} onClick={() => onMove(-1)} aria-label="Move up">
            <ArrowUp className="size-3.5" />
          </button>
          <button className="text-muted-foreground hover:text-foreground disabled:opacity-30" disabled={index === count - 1} onClick={() => onMove(1)} aria-label="Move down">
            <ArrowDown className="size-3.5" />
          </button>
        </div>
        <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{p.name}</span>
              <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', st.className)}>{st.label}</span>
              {p.experimental && (
                <Badge variant="outline" className="text-[11px] font-normal">
                  Experimental
                </Badge>
              )}
            </div>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{p.status.message ?? p.description}</p>
          </div>
          <span className="hidden text-xs text-muted-foreground sm:block">
            {p.usageToday.requests}
            {p.dailyLimit ? ` / ${p.dailyLimit}` : ''} today
          </span>
          <ChevronDown className={cn('size-4 text-muted-foreground transition-transform', open && 'rotate-180')} />
        </CollapsibleTrigger>
        <Switch checked={p.enabled} onCheckedChange={(enabled) => patch.mutate({ enabled })} aria-label={`Enable ${p.name}`} />
      </div>
      <CollapsibleContent>
        <div className="space-y-4 border-t p-4">
          <p className="text-sm text-muted-foreground">{p.description}</p>
          {p.setup.loginHint && <p className="rounded-md bg-muted p-2 text-xs">{p.setup.loginHint}</p>}

          {p.setup.secretLabel && (
            <div className="grid gap-1.5">
              <Label className="flex items-center gap-1.5">
                <KeyRound className="size-3.5" />
                {p.setup.secretLabel}
                {p.setup.secretOptional && <span className="font-normal text-muted-foreground">(optional)</span>}
                {p.hasSecret && <Badge variant="secondary">Saved</Badge>}
              </Label>
              <div className="flex flex-wrap gap-2">
                <Input type="password" className="min-w-48 flex-1" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={p.hasSecret ? 'Enter a new key to replace it' : 'Paste your key'} />
                <Button disabled={!secret.trim() || saveSecret.isPending} onClick={() => saveSecret.mutate(secret)}>
                  Save key
                </Button>
                {p.hasSecret && (
                  <Button variant="ghost" onClick={() => saveSecret.mutate(null)}>
                    Remove
                  </Button>
                )}
              </div>
              {p.setup.keyUrl && (
                <button className="flex w-fit items-center gap-1 text-xs text-primary hover:underline" onClick={() => openExternal(p.setup.keyUrl!)}>
                  Get a free key <ExternalLink className="size-3" />
                </button>
              )}
            </div>
          )}

          {p.setup.fields.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2">
              {p.setup.fields.map((f) =>
                f.type === 'boolean' ? (
                  <label key={f.key} className="flex items-center gap-2 text-sm">
                    <Switch checked={!!config[f.key]} onCheckedChange={(v) => setConfig({ ...config, [f.key]: v })} />
                    {f.label}
                  </label>
                ) : (
                  <div key={f.key} className="grid gap-1.5">
                    <Label className="text-xs">{f.label}</Label>
                    <Input
                      type={f.type === 'number' ? 'number' : 'text'}
                      value={(config[f.key] as string | number | undefined) ?? ''}
                      placeholder={f.placeholder}
                      onChange={(e) => setConfig({ ...config, [f.key]: f.type === 'number' ? (e.target.value === '' ? undefined : Number(e.target.value)) : e.target.value })}
                    />
                  </div>
                )
              )}
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            {configDirty && (
              <Button size="sm" onClick={() => patch.mutate({ config })}>
                Save settings
              </Button>
            )}
            <Button size="sm" variant="outline" disabled={test.isPending} onClick={() => test.mutate()}>
              {test.isPending ? <Loader2 className="animate-spin" /> : <Zap />}
              Test
            </Button>
            {p.kind === 'web' && (
              <>
                <Button size="sm" variant="outline" disabled={connect.isPending} onClick={() => connect.mutate()}>
                  <LogIn />
                  Sign in
                </Button>
                <Button size="sm" variant="outline" disabled={check.isPending} onClick={() => check.mutate()}>
                  {check.isPending ? <Loader2 className="animate-spin" /> : <Check />}
                  Check login
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setSiteOpen(true)}>
                  Selectors
                </Button>
                <Button size="sm" variant="ghost" onClick={() => disconnect.mutate()}>
                  Sign out
                </Button>
              </>
            )}
            {p.setup.docsUrl && (
              <Button size="sm" variant="ghost" onClick={() => openExternal(p.setup.docsUrl!)}>
                Docs <ExternalLink />
              </Button>
            )}
            {isCustom && (
              <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" disabled={removeApi.isPending} onClick={() => removeApi.mutate()} aria-label={`Remove ${p.name}`}>
                <Trash2 />
                Remove API
              </Button>
            )}
          </div>
          <div className="flex flex-wrap gap-1">
            {p.supportsTools && <Badge variant="secondary">Tool calling</Badge>}
            {p.tags.map((t) => (
              <Badge key={t} variant="outline" className="font-normal">
                {t}
              </Badge>
            ))}
          </div>
        </div>
      </CollapsibleContent>
      {p.kind === 'web' && <SiteConfigDialog provider={p} open={siteOpen} onOpenChange={setSiteOpen} />}
    </Collapsible>
  )
}

const SECTIONS: { kind: ProviderSummary['kind']; title: string; icon: typeof Globe; blurb: string }[] = [
  { kind: 'api', title: 'APIs', icon: Plug, blurb: 'Free API keys. Fast and reliable, with native tool calling.' },
  { kind: 'web', title: 'Websites', icon: Globe, blurb: 'Your free web accounts, driven through a real browser. Slower, and may break when a site changes.' },
  { kind: 'app', title: 'Apps', icon: AppWindow, blurb: 'Coding agents installed on this computer. FreeAgent hands them whole tasks.' }
]

const EMPTY_API_FORM = { name: '', baseUrl: '', model: '', secret: '' }

function AddApiDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }): React.JSX.Element {
  const qc = useQueryClient()
  const [form, setForm] = useState(EMPTY_API_FORM)
  const add = useMutation({
    mutationFn: () =>
      api.post<ProviderSummary>('/api/providers/custom', {
        name: form.name,
        baseUrl: form.baseUrl,
        model: form.model || undefined,
        secret: form.secret || undefined
      }),
    onSuccess: (p) => {
      void qc.invalidateQueries({ queryKey: keys.providers })
      void qc.invalidateQueries({ queryKey: keys.models })
      setForm(EMPTY_API_FORM)
      onOpenChange(false)
      toast.success(`${p.name} added`)
    },
    onError: (e) => toast.error(e.message)
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add API</DialogTitle>
          <DialogDescription>
            Any endpoint that serves OpenAI Chat Completions with streaming (<code>/chat/completions</code>). Paste the base URL from the provider&apos;s docs.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label>Name</Label>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Groq" />
          </div>
          <div className="grid gap-1.5">
            <Label>Base URL</Label>
            <Input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://api.groq.com/openai/v1" className="font-mono" />
          </div>
          <div className="grid gap-1.5">
            <Label>
              API key <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input type="password" value={form.secret} onChange={(e) => setForm({ ...form, secret: e.target.value })} placeholder="Paste your key" />
          </div>
          <div className="grid gap-1.5">
            <Label>
              Model <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder="Leave empty to use the first model from /models" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!form.name.trim() || !form.baseUrl.trim() || add.isPending} onClick={() => add.mutate()}>
            {add.isPending && <Loader2 className="animate-spin" />}
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ProvidersTab(): React.JSX.Element {
  const qc = useQueryClient()
  const providers = useProviders()
  const [addOpen, setAddOpen] = useState(false)
  const order = useMutation({
    mutationFn: (ids: string[]) => api.put<ProviderSummary[]>('/api/providers/order', { ids }),
    onSuccess: (data) => qc.setQueryData(keys.providers, data)
  })
  if (providers.isLoading) return <Skeleton className="h-64" />
  if (providers.isError) return <p className="text-sm text-destructive">Could not load providers: {providers.error.message}</p>
  const list = (providers.data ?? []).filter((p) => p.id !== 'mock').sort((a, b) => a.priority - b.priority)
  const ready = list.filter((p) => p.enabled && p.status.state === 'ready').length

  return (
    <div className="space-y-8">
      <p className="text-sm text-muted-foreground">
        {ready === 0 ? 'Nothing is ready yet. The quickest start is a free OpenRouter or Gemini key.' : `${ready} provider${ready === 1 ? '' : 's'} ready.`}{' '}
        Auto mode tries providers from top to bottom and falls back when one hits a limit. Use the arrows to change the order.
      </p>
      {SECTIONS.map((s) => {
        const items = list.filter((p) => p.kind === s.kind)
        return (
          <section key={s.kind}>
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <h2 className="flex items-center gap-2 font-medium">
                  <s.icon className="size-4" />
                  {s.title}
                </h2>
                <p className="text-xs text-muted-foreground">{s.blurb}</p>
              </div>
              {s.kind === 'api' && (
                <Button size="sm" variant="outline" className="shrink-0" onClick={() => setAddOpen(true)}>
                  <Plus />
                  Add API
                </Button>
              )}
            </div>
            <div className="space-y-2">
              {items.map((p, i) => (
                <ProviderRow
                  key={p.id}
                  p={p}
                  index={i}
                  count={items.length}
                  onMove={(dir) => {
                    const ids = list.map((x) => x.id)
                    const from = ids.indexOf(p.id)
                    const to = ids.indexOf(items[i + dir].id)
                    ;[ids[from], ids[to]] = [ids[to], ids[from]]
                    order.mutate(ids)
                  }}
                />
              ))}
            </div>
          </section>
        )
      })}
      <AddApiDialog open={addOpen} onOpenChange={setAddOpen} />
    </div>
  )
}

function IntegrationsTab(): React.JSX.Element {
  const info = useInfo()
  if (!info.data) return <Skeleton className="h-64" />
  const { gatewayUrl, token, mcpUrl } = info.data
  const base = gatewayUrl.replace(/\/v1$/, '')

  return (
    <div className="space-y-6">
      <section className="space-y-3 rounded-xl border bg-card p-5">
        <div>
          <h2 className="font-medium">Claude Code and other tools</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            FreeAgent serves OpenAI- and Anthropic-compatible endpoints backed by your free providers. Model names like <code>claude-sonnet</code> map to Auto · Code, and <code>haiku</code> maps to
            Auto · Fast.
          </p>
        </div>
        <CopyField label="Claude Code (run in a terminal)" value={`ANTHROPIC_BASE_URL=${base} ANTHROPIC_AUTH_TOKEN=${token} claude`} secret />
        <CopyField label="OpenAI-compatible base URL (Cursor, Continue, Aider, OpenCode…)" value={gatewayUrl} />
        <CopyField label="API key" value={token} secret />
        <CopyField label="MCP endpoint (streamable HTTP, use the key as a Bearer token)" value={mcpUrl} />
      </section>
    </div>
  )
}

function McpTab(): React.JSX.Element {
  const qc = useQueryClient()
  const mcp = useMcpServers()
  const tools = useTools()
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ name: '', transport: 'stdio' as 'stdio' | 'http', command: '', args: '', url: '', env: '' })
  const add = useMutation({
    mutationFn: () => {
      const env: Record<string, string> = {}
      for (const line of form.env.split('\n')) {
        const i = line.indexOf('=')
        if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim()
      }
      return api.post<{ status?: { error?: string } }>('/api/mcp-servers', {
        name: form.name,
        transport: form.transport,
        command: form.command,
        args: form.args.trim() ? form.args.trim().split(/\s+/) : [],
        url: form.url,
        env
      })
    },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: keys.mcp })
      void qc.invalidateQueries({ queryKey: keys.tools })
      setOpen(false)
      setForm({ name: '', transport: 'stdio', command: '', args: '', url: '', env: '' })
      if (r.status?.error) toast.error(`Added, but could not connect: ${r.status.error}`)
      else toast.success('MCP server connected')
    },
    onError: (e) => toast.error(e.message)
  })
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/mcp-servers/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.mcp })
      void qc.invalidateQueries({ queryKey: keys.tools })
    }
  })

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">Connect MCP servers to give the agent more tools in Agent mode.</p>
        <Button size="sm" onClick={() => setOpen(true)}>
          <Plus />
          Add server
        </Button>
      </div>
      {mcp.isLoading && <Skeleton className="h-24" />}
      {mcp.data?.servers.length === 0 && <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">No MCP servers yet.</div>}
      <div className="space-y-2">
        {mcp.data?.servers.map((s) => {
          const st = mcp.data.status[s.id]
          return (
            <div key={s.id} className="flex items-center gap-3 rounded-xl border bg-card p-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{s.name}</span>
                  {st?.connected ? (
                    <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">{st.tools.length} tools</Badge>
                  ) : (
                    <Badge variant="destructive">Not connected</Badge>
                  )}
                </div>
                <p className="truncate font-mono text-xs text-muted-foreground">{s.transport === 'http' ? s.url : [s.command, ...s.args].join(' ')}</p>
                {st?.error && <p className="text-xs text-destructive">{st.error}</p>}
              </div>
              <Button variant="ghost" size="icon" onClick={() => remove.mutate(s.id)} aria-label={`Remove ${s.name}`}>
                <Trash2 />
              </Button>
            </div>
          )
        })}
      </div>

      <section>
        <h2 className="mb-2 text-sm font-medium">Tools available to the agent</h2>
        <div className="divide-y rounded-xl border bg-card">
          {tools.data?.map((t) => (
            <div key={t.name} className="flex items-start gap-3 px-4 py-2.5">
              <code className="shrink-0 text-xs font-medium">{t.name}</code>
              <span className="min-w-0 flex-1 text-xs text-muted-foreground">{t.description}</span>
              {t.requiresApproval && (
                <Badge variant="outline" className="shrink-0 text-[11px] font-normal">
                  Asks first
                </Badge>
              )}
            </div>
          ))}
        </div>
      </section>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add MCP server</DialogTitle>
            <DialogDescription>Local servers run as a command. Remote servers use a streamable HTTP URL.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label>Name</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="filesystem" />
            </div>
            <div className="grid gap-1.5">
              <Label>Type</Label>
              <Select value={form.transport} onValueChange={(v) => setForm({ ...form, transport: v as 'stdio' | 'http' })}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="stdio">Local command (stdio)</SelectItem>
                  <SelectItem value="http">Remote URL (HTTP)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {form.transport === 'stdio' ? (
              <>
                <div className="grid gap-1.5">
                  <Label>Command</Label>
                  <Input value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} placeholder="npx" className="font-mono" />
                </div>
                <div className="grid gap-1.5">
                  <Label>Arguments</Label>
                  <Input value={form.args} onChange={(e) => setForm({ ...form, args: e.target.value })} placeholder="-y @modelcontextprotocol/server-memory" className="font-mono" />
                </div>
              </>
            ) : (
              <div className="grid gap-1.5">
                <Label>URL</Label>
                <Input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://example.com/mcp" className="font-mono" />
              </div>
            )}
            <div className="grid gap-1.5">
              <Label>Environment variables (one KEY=value per line, stored encrypted)</Label>
              <Textarea rows={3} value={form.env} onChange={(e) => setForm({ ...form, env: e.target.value })} className="font-mono text-xs" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button disabled={!form.name.trim() || add.isPending} onClick={() => add.mutate()}>
              {add.isPending && <Loader2 className="animate-spin" />}
              Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function PackSection({ kind }: { kind: 'skills' | 'plugins' }): React.JSX.Element {
  const qc = useQueryClient()
  const skills = useSkills()
  const plugins = usePlugins()
  const [name, setName] = useState('')
  const [body, setBody] = useState('')
  const isSkill = kind === 'skills'
  const key = isSkill ? keys.skills : keys.plugins
  const items = isSkill
    ? (skills.data ?? []).map((s) => ({ id: s.id, name: s.name, detail: s.summary }))
    : (plugins.data ?? []).map((p) => ({ id: p.id, name: p.name, detail: p.description }))
  const add = useMutation({
    mutationFn: () => api.post(isSkill ? '/api/skills' : '/api/plugins', { name, body }),
    onSuccess: () => {
      setName('')
      setBody('')
      void qc.invalidateQueries({ queryKey: key })
    },
    onError: (e) => toast.error(e.message)
  })
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`${isSkill ? '/api/skills' : '/api/plugins'}/${encodeURIComponent(id)}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
    onError: (e) => toast.error(e.message)
  })
  return (
    <section className="rounded-xl border bg-card p-5">
      <h2 className="font-medium">{isSkill ? 'Skills' : 'Plugins'}</h2>
      <p className="mb-3 text-xs text-muted-foreground">
        {isSkill
          ? 'Reusable notes the agent can open with read_skill. A project can also keep skills in .freeagent/skills in its working folder.'
          : 'Instruction packs. Turn one on for a project, or let the agent enable it for a single chat.'}
      </p>
      {items.length === 0 ? (
        <p className="mb-3 text-xs text-muted-foreground">None yet.</p>
      ) : (
        <ul className="mb-3 divide-y rounded-lg border">
          {items.map((item) => (
            <li key={item.id} className="flex items-center gap-2 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{item.name}</p>
                {item.detail && <p className="truncate text-xs text-muted-foreground">{item.detail}</p>}
              </div>
              <Button variant="ghost" size="icon" className="size-7" onClick={() => remove.mutate(item.id)} aria-label={`Delete ${item.name}`}>
                <Trash2 className="size-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="space-y-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" />
        <Textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} placeholder={'# Name\nOne line about when to use it.\n\nThe rest of the instructions.'} />
        <Button size="sm" disabled={!name.trim() || !body.trim() || add.isPending} onClick={() => add.mutate()}>
          {add.isPending && <Loader2 className="animate-spin" />}
          Add {isSkill ? 'skill' : 'plugin'}
        </Button>
      </div>
    </section>
  )
}

function MemorySection(): React.JSX.Element {
  const qc = useQueryClient()
  const memories = useMemories()
  const [text, setText] = useState('')
  const add = useMutation({
    mutationFn: () => api.post('/api/memories', { text }),
    onSuccess: () => {
      setText('')
      void qc.invalidateQueries({ queryKey: keys.memories })
    },
    onError: (e) => toast.error(e.message)
  })
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/memories/${encodeURIComponent(id)}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.memories }),
    onError: (e) => toast.error(e.message)
  })
  return (
    <section className="rounded-xl border bg-card p-5">
      <h2 className="font-medium">Memory</h2>
      <p className="mb-3 text-xs text-muted-foreground">Facts kept across chats. The agent saves one only when you ask it to remember.</p>
      {(memories.data ?? []).length === 0 ? (
        <p className="mb-3 text-xs text-muted-foreground">Nothing remembered yet.</p>
      ) : (
        <ul className="mb-3 divide-y rounded-lg border">
          {(memories.data ?? []).map((fact) => (
            <li key={fact.id} className="flex items-center gap-2 px-3 py-2">
              <p className="min-w-0 flex-1 text-sm">{fact.text}</p>
              <Button variant="ghost" size="icon" className="size-7" onClick={() => remove.mutate(fact.id)} aria-label="Forget fact">
                <Trash2 className="size-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Remember that I prefer short answers" maxLength={240} />
        <Button size="sm" disabled={!text.trim() || add.isPending} onClick={() => add.mutate()}>
          Save
        </Button>
      </div>
    </section>
  )
}

function GeneralTab(): React.JSX.Element {
  const qc = useQueryClient()
  const settings = useSettings()
  const info = useInfo()
  const [prompt, setPrompt] = useState('')
  useEffect(() => {
    if (settings.data) setPrompt(settings.data.systemPrompt)
  }, [settings.data?.systemPrompt]) // eslint-disable-line react-hooks/exhaustive-deps
  const update = useMutation({
    mutationFn: (patch: Partial<AppSettings>) => api.patch<AppSettings>('/api/settings', patch),
    onSuccess: (data) => qc.setQueryData(keys.settings, data),
    onError: (e) => toast.error(e.message)
  })
  if (!settings.data) return <Skeleton className="h-64" />
  const s = settings.data

  const Row = ({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }): React.JSX.Element => (
    <div className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      {children}
    </div>
  )

  return (
    <div className="space-y-6">
      <section className="rounded-xl border bg-card p-5">
        <Label className="font-medium">Personal instructions</Label>
        <p className="mb-2 text-xs text-muted-foreground">Sent with every chat, for every provider.</p>
        <Textarea rows={5} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="I'm a software engineer. Prefer concise answers with code." />
        <Button size="sm" className="mt-2" disabled={prompt === s.systemPrompt} onClick={() => update.mutate({ systemPrompt: prompt })}>
          Save
        </Button>
      </section>

      <PackSection kind="skills" />
      <PackSection kind="plugins" />
      <MemorySection />

      <section className="divide-y rounded-xl border bg-card px-5">
        <Row title="Theme" hint="Follows your system by default.">
          <Select value={s.theme} onValueChange={(v) => update.mutate({ theme: v as AppSettings['theme'] })}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">System</SelectItem>
              <SelectItem value="light">Light</SelectItem>
              <SelectItem value="dark">Dark</SelectItem>
            </SelectContent>
          </Select>
        </Row>
        <Row title="Auto-approve agent actions" hint="Let the agent write files and run commands without asking. Only turn this on if you trust the task.">
          <Switch checked={s.autoApprove} onCheckedChange={(v) => update.mutate({ autoApprove: v })} />
        </Row>
        <Row title="Fall back from a chosen provider" hint="If the provider you picked fails, try the next one instead of stopping.">
          <Switch checked={s.fallbackOnExplicit} onCheckedChange={(v) => update.mutate({ fallbackOnExplicit: v })} />
        </Row>
        <Row title="Show browser windows" hint="Show the browser while website providers work. When off, a window still opens by itself if a site asks for a human check.">
          <Switch checked={s.showBrowser} onCheckedChange={(v) => update.mutate({ showBrowser: v })} />
        </Row>
        <Row title="Web chat: send message only" hint="Website providers keep one site conversation per chat and type just your latest message into it. Skips personal/project instructions, and sends earlier turns only when a conversation has to be reopened. Agent mode always sends the instructions and tools.">
          <Switch checked={s.webPlainText} onCheckedChange={(v) => update.mutate({ webPlainText: v })} />
        </Row>
        <Row title="Council size" hint="How many providers answer in Council mode.">
          <Input type="number" min={2} max={6} className="w-20" value={s.councilSize} onChange={(e) => update.mutate({ councilSize: Math.max(2, Math.min(6, Number(e.target.value) || 3)) })} />
        </Row>
        <Row title="Max agent steps" hint="Stops runaway tool loops.">
          <Input type="number" min={1} max={100} className="w-20" value={s.maxAgentSteps} onChange={(e) => update.mutate({ maxAgentSteps: Math.max(1, Math.min(100, Number(e.target.value) || 25)) })} />
        </Row>
      </section>

      {info.data && (
        <section className="rounded-xl border bg-card p-5 text-sm">
          <p className="font-medium">Data folder</p>
          <p className="mb-2 text-xs text-muted-foreground">Chats, projects, encrypted keys and browser logins are stored here.</p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="rounded bg-muted px-2 py-1 font-mono text-xs break-all">{info.data.dataDir}</code>
            {window.freeagent && (
              <Button size="sm" variant="outline" onClick={() => void window.freeagent!.openPath(info.data.dataDir)}>
                Open
              </Button>
            )}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">FreeAgent {info.data.version}</p>
        </section>
      )}
    </div>
  )
}

export function CustomizeView({ tab = 'providers' }: { tab?: Tab }): React.JSX.Element {
  const { go } = useNav()
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
        <h1 className="mb-1 font-serif text-3xl tracking-tight">Customize</h1>
        <p className="mb-6 text-sm text-muted-foreground">Providers, integrations and how the agent behaves.</p>
        <Tabs value={tab} onValueChange={(t) => go({ view: 'customize', tab: t as Tab })}>
          <TabsList className="mb-6 w-full justify-start overflow-x-auto sm:w-auto">
            <TabsTrigger value="providers">Providers</TabsTrigger>
            <TabsTrigger value="integrations">Integrations</TabsTrigger>
            <TabsTrigger value="mcp">MCP servers</TabsTrigger>
            <TabsTrigger value="general">General</TabsTrigger>
          </TabsList>
          <TabsContent value="providers">
            <ProvidersTab />
          </TabsContent>
          <TabsContent value="integrations">
            <IntegrationsTab />
          </TabsContent>
          <TabsContent value="mcp">
            <McpTab />
          </TabsContent>
          <TabsContent value="general">
            <GeneralTab />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}
