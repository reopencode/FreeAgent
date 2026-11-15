import { useCallback, useEffect, useState } from 'react'
import { Menu, PanelLeftOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { useNav } from '@/lib/nav'
import { useSettings } from '@/lib/queries'
import { cn } from '@/lib/utils'
import { Sidebar } from './Sidebar'
import { ApprovalBanner } from './ApprovalBanner'
import { ChatView } from '@/views/ChatView'
import { AutomationsView } from '@/views/AutomationsView'
import { ProjectsView } from '@/views/ProjectsView'
import { CustomizeView } from '@/views/CustomizeView'

const MIN_WIDTH = 200
const MAX_WIDTH = 480
const DEFAULT_WIDTH = 256

const clampWidth = (w: number): number => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(w)))

function storedWidth(): number {
  const n = Number(localStorage.getItem('freeagent.sidebarWidth'))
  return Number.isFinite(n) && n > 0 ? clampWidth(n) : DEFAULT_WIDTH
}

function useThemeSync(): void {
  const { data } = useSettings()
  const theme = data?.theme ?? 'system'
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = (): void => {
      document.documentElement.classList.toggle('dark', theme === 'dark' || (theme === 'system' && mq.matches))
    }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [theme])
}

export function Shell(): React.JSX.Element {
  const { route } = useNav()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [open, setOpen] = useState(() => localStorage.getItem('freeagent.sidebar') !== 'closed')
  const [width, setWidth] = useState(storedWidth)
  const [dragging, setDragging] = useState(false)
  useThemeSync()

  useEffect(() => setMobileOpen(false), [route])

  const changeOpen = useCallback((next: boolean): void => {
    setOpen(next)
    localStorage.setItem('freeagent.sidebar', next ? 'open' : 'closed')
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        changeOpen(!open)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, changeOpen])

  const startDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const left = el.parentElement!.getBoundingClientRect().left
    let last = width
    setDragging(true)
    const move = (ev: PointerEvent): void => {
      last = clampWidth(ev.clientX - left)
      setWidth(last)
    }
    const end = (): void => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', end)
      el.removeEventListener('pointercancel', end)
      setDragging(false)
      localStorage.setItem('freeagent.sidebarWidth', String(last))
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', end)
    el.addEventListener('pointercancel', end)
  }

  const onHandleKey = (e: React.KeyboardEvent): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const next = clampWidth(width + (e.key === 'ArrowRight' ? 16 : -16))
    setWidth(next)
    localStorage.setItem('freeagent.sidebarWidth', String(next))
  }

  const mac = window.freeagent?.platform === 'darwin'

  return (
    <div className="flex h-full overflow-hidden">
      {open && (
        <aside className="relative hidden shrink-0 border-r bg-sidebar md:flex md:flex-col" style={{ width }}>
          {mac && <div className="h-7 shrink-0 [-webkit-app-region:drag]" />}
          <Sidebar onHide={() => changeOpen(false)} />
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            aria-valuemin={MIN_WIDTH}
            aria-valuemax={MAX_WIDTH}
            aria-valuenow={width}
            tabIndex={0}
            onPointerDown={startDrag}
            onKeyDown={onHandleKey}
            onDoubleClick={() => {
              setWidth(DEFAULT_WIDTH)
              localStorage.setItem('freeagent.sidebarWidth', String(DEFAULT_WIDTH))
            }}
            className={cn(
              'absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize touch-none transition-colors hover:bg-primary/30 focus-visible:bg-primary/40 focus-visible:outline-none',
              dragging && 'bg-primary/40'
            )}
          />
        </aside>
      )}
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-72 bg-sidebar p-0">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <Sidebar />
        </SheetContent>
      </Sheet>
      <main className="relative flex min-w-0 flex-1 flex-col">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b px-3 md:hidden">
          <Button variant="ghost" size="icon" onClick={() => setMobileOpen(true)} aria-label="Open navigation">
            <Menu />
          </Button>
          <span className="font-semibold">FreeAgent</span>
        </div>
        {!open && (
          <div className={cn('hidden h-12 shrink-0 items-center gap-2 border-b px-3 md:flex', mac && 'pl-20 [-webkit-app-region:drag]')}>
            <Button variant="ghost" size="icon" onClick={() => changeOpen(true)} aria-label="Show sidebar" title="Show sidebar (Ctrl+B)" className="[-webkit-app-region:no-drag]">
              <PanelLeftOpen />
            </Button>
          </div>
        )}
        <ApprovalBanner />
        <div className="min-h-0 flex-1">
          {route.view === 'chat' && <ChatView key={route.chatId ?? `new-${route.projectId ?? ''}`} chatId={route.chatId} projectId={route.projectId} />}
          {route.view === 'automations' && <AutomationsView />}
          {route.view === 'projects' && <ProjectsView projectId={route.projectId} />}
          {route.view === 'customize' && <CustomizeView tab={route.tab} />}
        </div>
      </main>
    </div>
  )
}
