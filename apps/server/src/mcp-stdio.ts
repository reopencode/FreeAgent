import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { defaultDataDir } from '@freeagent/core/paths'
import { DEFAULT_PORT, VERSION, loadToken } from './config'

/**
 * stdio MCP server for Claude Desktop. It forwards every request to the running FreeAgent server,
 * which owns the database, logins and browser sessions.
 */
async function main(): Promise<void> {
  const url = process.env.FREEAGENT_URL || `http://127.0.0.1:${process.env.FREEAGENT_PORT || DEFAULT_PORT}`
  const token = process.env.FREEAGENT_TOKEN || loadToken(defaultDataDir())

  let client: Client | undefined
  const remote = async (): Promise<Client> => {
    if (client) return client
    const c = new Client({ name: 'freeagent-stdio-bridge', version: VERSION })
    await c.connect(new StreamableHTTPClientTransport(new URL('/mcp', url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
    client = c
    return c
  }
  const offline = (err: unknown): string =>
    `FreeAgent is not running at ${url}. Open the FreeAgent app (or run \`pnpm server\`) and try again. (${err instanceof Error ? err.message : String(err)})`

  const server = new Server({ name: 'freeagent', version: VERSION }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      return await (await remote()).listTools()
    } catch {
      client = undefined
      return {
        tools: [{ name: 'list_providers', description: 'List FreeAgent providers (FreeAgent app must be running).', inputSchema: { type: 'object' as const, properties: {} } }]
      }
    }
  })
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      return await (await remote()).callTool(req.params)
    } catch (err) {
      client = undefined
      return { content: [{ type: 'text', text: offline(err) }], isError: true }
    }
  })
  await server.connect(new StdioServerTransport())
}

main().catch((err) => {
  process.stderr.write(`freeagent mcp bridge failed: ${err instanceof Error ? err.stack : String(err)}\n`)
  process.exit(1)
})
