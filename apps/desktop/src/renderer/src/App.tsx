import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Loader2, RotateCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { setConnection } from '@/lib/api'
import { NavProvider } from '@/lib/nav'
import { Shell } from '@/components/Shell'
import { Logo } from '@/components/Logo'

type Boot = { state: 'loading' } | { state: 'ready' } | { state: 'error'; message: string }

/** Outside Electron (e.g. a browser pointed at a headless server) the connection comes from the URL. */
function connectionFromUrl(): { baseUrl: string; token: string } | null {
  const params = new URLSearchParams(window.location.search)
  const token = params.get('token') ?? localStorage.getItem('freeagent.token')
  const baseUrl = params.get('server') ?? localStorage.getItem('freeagent.server') ?? 'http://127.0.0.1:47821'
  if (!token) return null
  localStorage.setItem('freeagent.token', token)
  localStorage.setItem('freeagent.server', baseUrl)
  return { baseUrl, token }
}

function App(): React.JSX.Element {
  const [boot, setBoot] = useState<Boot>({ state: 'loading' })

  const connect = useCallback(async (retry = false) => {
    setBoot({ state: 'loading' })
    if (!window.freeagent) {
      const c = connectionFromUrl()
      if (!c) {
        setBoot({ state: 'error', message: 'Open this page with ?token=<your FreeAgent token>, or use the desktop app.' })
        return
      }
      setConnection(c)
      setBoot({ state: 'ready' })
      return
    }
    const res = retry ? await window.freeagent.retry() : await window.freeagent.connection()
    if (res.ok) {
      setConnection(res)
      setBoot({ state: 'ready' })
    } else setBoot({ state: 'error', message: res.error })
  }, [])

  useEffect(() => {
    void connect()
  }, [connect])

  if (boot.state === 'ready') {
    return (
      <NavProvider>
        <Shell />
      </NavProvider>
    )
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 p-8 text-center">
      <Logo className="size-12" />
      {boot.state === 'loading' ? (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Starting FreeAgent…
        </div>
      ) : (
        <div className="flex max-w-md flex-col items-center gap-3">
          <div className="flex items-center gap-2 font-medium text-destructive">
            <AlertTriangle className="size-4" />
            FreeAgent could not start its local server
          </div>
          <p className="text-sm break-words text-muted-foreground">{boot.message}</p>
          <Button onClick={() => void connect(true)}>
            <RotateCw />
            Try again
          </Button>
        </div>
      )}
    </div>
  )
}

export default App
