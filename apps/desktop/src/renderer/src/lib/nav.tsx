import { createContext, useContext, useState, type ReactNode } from 'react'

export type Route =
  | { view: 'chat'; chatId?: string; projectId?: string }
  | { view: 'automations'; automationId?: string }
  | { view: 'projects'; projectId?: string }
  | { view: 'customize'; tab?: 'providers' | 'integrations' | 'mcp' | 'general' }

interface Nav {
  route: Route
  go: (r: Route) => void
}

const NavContext = createContext<Nav | null>(null)

export function NavProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [route, setRoute] = useState<Route>({ view: 'chat' })
  return <NavContext.Provider value={{ route, go: setRoute }}>{children}</NavContext.Provider>
}

export function useNav(): Nav {
  const ctx = useContext(NavContext)
  if (!ctx) throw new Error('useNav outside NavProvider')
  return ctx
}
