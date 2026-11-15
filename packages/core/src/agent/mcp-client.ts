import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { McpServerConfig } from '../api-types'
import type { Store } from '../store'
import { truncate } from '../util'
import type { AgentTool } from './tools'

interface Connection {
  client: Client
  tools: AgentTool[]
  error?: string
}

export function mcpToolName(serverName: string, tool: string): string {
  const clean = (x: string): string => x.replace(/[^a-zA-Z0-9_-]/g, '_')
  return `mcp__${clean(serverName)}__${clean(tool)}`.slice(0, 64)
}

/** Connects to the MCP servers the user added and exposes their tools to the agent. */
export class McpManager {
  private connections = new Map<string, Connection>()
  private errors = new Map<string, string>()

  constructor(private readonly store: Store) {}

  status(): Record<string, { connected: boolean; tools: string[]; error?: string }> {
    const out: Record<string, { connected: boolean; tools: string[]; error?: string }> = {}
    for (const s of this.store.listMcpServers()) {
      const c = this.connections.get(s.id)
      out[s.id] = { connected: !!c, tools: c?.tools.map((t) => t.spec.name) ?? [], error: this.errors.get(s.id) }
    }
    return out
  }

  private async connect(cfg: McpServerConfig): Promise<Connection> {
    const client = new Client({ name: 'freeagent', version: '0.1.0' })
    const env = this.store.getMcpEnv(cfg.id)
    if (cfg.transport === 'stdio') {
      if (!cfg.command) throw new Error('Missing command')
      await client.connect(
        new StdioClientTransport({
          command: cfg.command,
          args: cfg.args,
          env: { ...(process.env as Record<string, string>), ...env },
          stderr: 'ignore'
        })
      )
    } else {
      if (!cfg.url) throw new Error('Missing URL')
      const headers: Record<string, string> = {}
      if (env.AUTHORIZATION) headers.Authorization = env.AUTHORIZATION
      await client.connect(new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers } }))
    }
    const listed = await client.listTools()
    const tools: AgentTool[] = listed.tools.map((t) => ({
      spec: {
        name: mcpToolName(cfg.name, t.name),
        description: `[${cfg.name}] ${t.description ?? t.name}`,
        parameters: (t.inputSchema as AgentTool['spec']['parameters']) ?? { type: 'object', properties: {} }
      },
      requiresApproval: !t.annotations?.readOnlyHint,
      summarize: (a) => `${cfg.name}.${t.name}(${JSON.stringify(a).slice(0, 120)})`,
      run: async (a) => {
        const res = await client.callTool({ name: t.name, arguments: a })
        const parts = (res.content as { type: string; text?: string }[] | undefined) ?? []
        const text = parts.map((p) => (p.type === 'text' ? p.text : `[${p.type} content]`)).join('\n')
        if (res.isError) throw new Error(text || 'MCP tool failed')
        return truncate(text || JSON.stringify(res.structuredContent ?? {}), 16_000)
      }
    }))
    return { client, tools }
  }

  /** Connects any enabled servers not yet connected and returns all their tools. */
  async tools(): Promise<AgentTool[]> {
    const configs = this.store.listMcpServers().filter((s) => s.enabled)
    const wanted = new Set(configs.map((c) => c.id))
    for (const [sid, c] of this.connections) {
      if (!wanted.has(sid)) {
        await c.client.close().catch(() => undefined)
        this.connections.delete(sid)
      }
    }
    await Promise.all(
      configs
        .filter((c) => !this.connections.has(c.id))
        .map(async (c) => {
          try {
            this.connections.set(c.id, await this.connect(c))
            this.errors.delete(c.id)
          } catch (err) {
            this.errors.set(c.id, err instanceof Error ? err.message : String(err))
          }
        })
    )
    return [...this.connections.values()].flatMap((c) => c.tools)
  }

  async reconnect(serverId: string): Promise<void> {
    const c = this.connections.get(serverId)
    if (c) await c.client.close().catch(() => undefined)
    this.connections.delete(serverId)
    this.errors.delete(serverId)
    await this.tools()
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.connections.values()].map((c) => c.client.close().catch(() => undefined)))
    this.connections.clear()
  }
}
