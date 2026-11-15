import { contextBridge, ipcRenderer } from 'electron'

const api = {
  platform: process.platform,
  connection: () => ipcRenderer.invoke('freeagent:connection'),
  retry: () => ipcRenderer.invoke('freeagent:retry'),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('freeagent:pick-folder'),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('freeagent:open-external', url),
  openPath: (path: string): Promise<string> => ipcRenderer.invoke('freeagent:open-path', path)
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('freeagent', api)
} else {
  // @ts-ignore (defined in index.d.ts)
  window.freeagent = api
}
