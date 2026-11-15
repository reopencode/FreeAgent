import { join } from 'node:path'
import { Approvals } from './agent/approvals'
import { McpManager } from './agent/mcp-client'
import { AgentRunner } from './agent/runner'
import { ChatService } from './chat-service'
import { ProviderRegistry } from './providers/registry'
import { defaultDataDir } from './paths'
import { closeScratchBrowser } from './providers/web/browser'
import { Router } from './router'
import { Secrets } from './secrets'
import { Store } from './store'

export { defaultDataDir }

export interface Core {
  dataDir: string
  store: Store
  registry: ProviderRegistry
  router: Router
  approvals: Approvals
  mcp: McpManager
  runner: AgentRunner
  chats: ChatService
  dispose(): Promise<void>
}


export function createCore(opts: { dataDir?: string; dbFile?: string; secrets?: Secrets } = {}): Core {
  const dataDir = opts.dataDir ?? defaultDataDir()
  const secrets = opts.secrets ?? Secrets.load(dataDir)
  const store = new Store(opts.dbFile ?? join(dataDir, 'freeagent.db'), secrets)
  const registry = new ProviderRegistry(store, dataDir)
  const router = new Router(registry, store)
  const approvals = new Approvals()
  const mcp = new McpManager(store)
  const runner = new AgentRunner({ router, registry, store, approvals, mcp })
  const chats = new ChatService(store, runner, dataDir)
  return {
    dataDir,
    store,
    registry,
    router,
    approvals,
    mcp,
    runner,
    chats,
    async dispose() {
      await registry.dispose()
      await mcp.closeAll()
      await closeScratchBrowser()
      store.close()
    }
  }
}
