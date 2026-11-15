export type ConnectionResult =
  | { ok: true; baseUrl: string; token: string; dataDir: string; external: boolean }
  | { ok: false; error: string }

declare global {
  interface Window {
    freeagent?: {
      platform: string
      connection: () => Promise<ConnectionResult>
      retry: () => Promise<ConnectionResult>
      pickFolder: () => Promise<string | null>
      openExternal: (url: string) => Promise<void>
      openPath: (path: string) => Promise<string>
    }
  }
}

export {}
