import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Clock, FolderKanban, MessageSquarePlus, MoreHorizontal, PanelLeftClose, Search, SlidersHorizontal, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { useNav, type Route } from '@/lib/nav'
import { keys, useChats, useProviders } from '@/lib/queries'
import { cn } from '@/lib/utils'
import { Logo } from './Logo'

const NAV: { label: string; icon: typeof Clock; route: Route; match: Route['view'] }[] = [
  { label: 'New chat', icon: MessageSquarePlus, route: { view: 'chat' }, match: 'chat' },
  { label: 'Automations', icon: Clock, route: { view: 'automations' }, match: 'automations' },
  { label: 'Projects', icon: FolderKanban, route: { view: 'projects' }, match: 'projects' },
  { label: 'Customize', icon: SlidersHorizontal, route: { view: 'customize' }, match: 'customize' }
]

function groupByDay(ts: number): string {
  const d = new Date(ts)
  const today = new Date()
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  if (ts >= start) return 'Today'
  if (ts >= start - 86400_000) return 'Yesterday'
  if (ts >= start - 7 * 86400_000) return 'Previous 7 days'
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}

export function Sidebar({ onHide }: { onHide?: () => void }): React.JSX.Element {
  const { route, go } = useNav()
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 200)
    return () => clearTimeout(timer)
  }, [query])
  const chats = useChats(debounced)
  const providers = useProviders()
  const qc = useQueryClient()

  const readyCount = (providers.data ?? []).filter((p) => p.enabled && p.status.state === 'ready' && p.id !== 'mock').length

  const del = useMutation({
    mutationFn: (id: string) => api.del(`/api/chats/${id}`),
    onSuccess: (_d, id) => {
      void qc.invalidateQueries({ queryKey: keys.chats })
      if (route.view === 'chat' && route.chatId === id) go({ view: 'chat' })
    },
    onError: (e) => toast.error(e.message)
  })

  const groups = useMemo(() => {
    const out: { label: string; items: NonNullable<typeof chats.data> }[] = []
    for (const c of chats.data ?? []) {
      const label = groupByDay(c.updatedAt)
      const g = out.find((x) => x.label === label)
      if (g) g.items.push(c)
      else out.push({ label, items: [c] })
    }
    return out
  }, [chats.data])

  return (
    <div className="flex h-full min-h-0 flex-col text-sidebar-foreground">
      <div className="flex items-center gap-2 px-4 pt-4 pb-3">
        <Logo />
        <span className="flex-1 text-[15px] font-semibold tracking-tight">FreeAgent</span>
        {onHide && (
          <Button variant="ghost" size="icon" className="size-7 text-muted-foreground" onClick={onHide} aria-label="Hide sidebar" title="Hide sidebar (Ctrl+B)">
            <PanelLeftClose />
          </Button>
        )}
      </div>

      <nav className="flex flex-col gap-0.5 px-2">
        {NAV.map((item) => {
          const active = item.match === route.view && !(item.match === 'chat' && route.view === 'chat' && route.chatId)
          return (
            <button
              key={item.label}
              onClick={() => go(item.route)}
              className={cn(
                'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors hover:bg-sidebar-accent',
                active && 'bg-sidebar-accent font-medium'
              )}
            >
              <item.icon className={cn('size-4', item.label === 'New chat' && 'text-primary')} />
              {item.label}
            </button>
          )
        })}
      </nav>

      <div className="mt-4 px-4 pb-1 text-xs font-medium text-muted-foreground">Recents</div>
      <div className="relative mx-2 mb-1">
        <Search className="pointer-events-none absolute top-2 left-2 size-3.5 text-muted-foreground" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search chats"
          aria-label="Search chats"
          className="h-8 w-full rounded-md border bg-transparent pr-2 pl-7 text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>
      <ScrollArea className="min-h-0 flex-1 px-2">
        {chats.isLoading && (
          <div className="flex flex-col gap-2 px-2 py-1">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-6 w-full" />
            ))}
          </div>
        )}
        {chats.isError && <p className="px-2 py-1 text-xs text-destructive">Could not load chats.</p>}
        {chats.data?.length === 0 && (
          <p className="px-2 py-1 text-xs text-muted-foreground">{debounced ? 'No chats match that search.' : 'Your conversations will show up here.'}</p>
        )}
        {groups.map((g) => (
          <div key={g.label} className="mb-2">
            <div className="px-2 pt-2 pb-1 text-[11px] text-muted-foreground/80">{g.label}</div>
            {g.items.map((c) => {
              const active = route.view === 'chat' && route.chatId === c.id
              return (
                <div key={c.id} className={cn('group flex items-center rounded-md hover:bg-sidebar-accent', active && 'bg-sidebar-accent')}>
                  <button className="min-w-0 flex-1 truncate px-2 py-1.5 text-left text-[13px]" onClick={() => go({ view: 'chat', chatId: c.id })} title={c.title}>
                    {c.title}
                  </button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="size-7 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100" aria-label="Chat actions">
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem variant="destructive" onClick={() => del.mutate(c.id)}>
                        <Trash2 />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              )
            })}
          </div>
        ))}
      </ScrollArea>

      <button
        onClick={() => go({ view: 'customize', tab: 'providers' })}
        className="m-2 flex items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-muted-foreground hover:bg-sidebar-accent"
      >
        <span className={cn('size-2 rounded-full', readyCount ? 'bg-emerald-500' : 'bg-amber-500')} />
        {providers.isLoading ? 'Checking providers…' : readyCount ? `${readyCount} provider${readyCount === 1 ? '' : 's'} ready` : 'No providers set up yet'}
      </button>
    </div>
  )
}
