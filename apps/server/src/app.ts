import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Hono, type Context, type Next } from 'hono'
import { cors } from 'hono/cors'
import { streamSSE } from 'hono/streaming'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import {
  AUTO_TARGETS,
  WEB_SITES,
  claudeDesktopConfigPath,
  claudeDesktopLinked,
  isCustomProviderId,
  loadSiteConfig,
  siteOverridePath,
  validateSiteConfig,
  chatToMarkdown,
  markdownFilename,
  readChatMedia,
  removeChatMedia,
  type AgentEvent,
  type AppSettings,
  type Attachment,
  type Automation,
  type ChatMode,
  type Core,
  type IncomingAttachment,
  type ModelOption,
  type ServerInfo
} from '@freeagent/core'
import { mcpStdioScript, type ServerConfig } from './config'
import { gatewayRoutes } from './gateway/routes'
import { createMcpServer } from './mcp-server'
import { Scheduler } from './scheduler'

const MODES: ChatMode[] = ['chat', 'agent', 'council']

function bad(c: Context, message: string, status = 400): Response {
  return c.json({ error: message }, status as 400)
}

function findAttachment(messages: { attachments?: Attachment[] }[], fileId: string): Attachment | undefined {
  for (const m of messages) {
    const hit = m.attachments?.find((a) => a.id === fileId)
    if (hit) return hit
  }
  return undefined
}

async function body<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T
  } catch {
    return {} as T
  }
}

export function serverInfo(cfg: ServerConfig): ServerInfo {
  const base = `http://${cfg.host === '0.0.0.0' ? '127.0.0.1' : cfg.host}:${cfg.port}`
  const env: Record<string, string> = { FREEAGENT_URL: base, FREEAGENT_TOKEN: cfg.token }
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
  return {
    version: cfg.version,
    port: cfg.port,
    dataDir: cfg.dataDir,
    token: cfg.token,
    gatewayUrl: base,
    mcpUrl: `${base}/mcp`,
    mcpStdio: { command: process.execPath, args: [mcpStdioScript()], env },
    claudeDesktopConfigPath: claudeDesktopConfigPath()
  }
}

export function createApp(core: Core, cfg: ServerConfig, scheduler: Scheduler): Hono {
  const app = new Hono()
  const running = new Map<string, AbortController>()
  const { store, registry } = core

  app.use('*', cors({ origin: (o) => o ?? '*', allowHeaders: ['Authorization', 'Content-Type', 'x-api-key', 'anthropic-version', 'mcp-session-id', 'mcp-protocol-version'], exposeHeaders: ['mcp-session-id'] }))

  const auth = async (c: Context, next: Next): Promise<Response | void> => {
    const header = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? c.req.header('x-api-key') ?? c.req.query('token')
    if (header !== cfg.token) return c.json({ error: 'Unauthorized. Send the FreeAgent token as a Bearer token or x-api-key.' }, 401)
    await next()
  }

  app.get('/health', (c) => c.json({ ok: true, version: cfg.version }))
  app.use('/api/*', auth)
  app.use('/v1/*', auth)
  app.use('/mcp', auth)

  app.route('/v1', gatewayRoutes(core))

  app.all('/mcp', async (c) => {
    const server = createMcpServer(core, scheduler)
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    await server.connect(transport)
    return transport.handleRequest(c.req.raw)
  })

  app.get('/api/info', (c) => c.json(serverInfo(cfg)))

  // Settings

  app.get('/api/settings', (c) => c.json(store.getSettings()))
  app.patch('/api/settings', async (c) => c.json(store.updateSettings(await body<Partial<AppSettings>>(c))))

  // Chats

  app.get('/api/chats', (c) => c.json(store.listChats({ projectId: c.req.query('projectId') || undefined, query: c.req.query('q') || undefined, limit: Number(c.req.query('limit')) || 100 })))

  app.post('/api/chats', async (c) => {
    const b = await body<{ title?: string; projectId?: string | null; mode?: ChatMode; target?: string }>(c)
    if (b.mode && !MODES.includes(b.mode)) return bad(c, 'Invalid mode')
    if (b.projectId && !store.getProject(b.projectId)) return bad(c, 'Project not found', 404)
    return c.json(store.createChat(b), 201)
  })

  app.get('/api/chats/:id', (c) => {
    const chat = store.getChat(c.req.param('id'))
    if (!chat) return bad(c, 'Chat not found', 404)
    return c.json({ chat, messages: store.listMessages(chat.id), running: running.has(chat.id) })
  })

  app.patch('/api/chats/:id', async (c) => {
    const b = await body<{ title?: string; mode?: ChatMode; target?: string; projectId?: string | null }>(c)
    if (b.mode && !MODES.includes(b.mode)) return bad(c, 'Invalid mode')
    const chat = store.updateChat(c.req.param('id'), b)
    return chat ? c.json(chat) : bad(c, 'Chat not found', 404)
  })

  app.delete('/api/chats/:id', async (c) => {
    const chatId = c.req.param('id')
    running.get(chatId)?.abort()
    // Closes the website conversation the chat kept open, so a deleted chat leaves no tab behind.
    await core.registry.endSession(chatId)
    removeChatMedia(core.dataDir, chatId)
    store.deleteChat(chatId)
    return c.json({ ok: true })
  })

  app.get('/api/chats/:id/export', (c) => {
    const chat = store.getChat(c.req.param('id'))
    if (!chat) return bad(c, 'Chat not found', 404)
    const filename = markdownFilename(chat.title)
    return c.body(chatToMarkdown(chat, store.listMessages(chat.id)), 200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`
    })
  })

  app.get('/api/media/:chatId/:fileId', (c) => {
    const chatId = c.req.param('chatId')
    const fileId = c.req.param('fileId')
    if (!store.getChat(chatId)) return bad(c, 'Chat not found', 404)
    const attachment = findAttachment(store.listMessages(chatId), fileId)
    const data = attachment && readChatMedia(core.dataDir, chatId, fileId)
    if (!attachment || !data) return bad(c, 'File not found', 404)
    return c.body(new Uint8Array(data), 200, { 'Content-Type': attachment.mime || 'application/octet-stream', 'Cache-Control': 'private, max-age=3600' })
  })

  const streamRun = (c: Context, chatId: string, run: (emit: (ev: AgentEvent) => void, signal: AbortSignal) => Promise<unknown>): Response | Promise<Response> => {
    if (!store.getChat(chatId)) return bad(c, 'Chat not found', 404)
    if (running.has(chatId)) return bad(c, 'This chat is already answering. Stop it first.', 409)
    const controller = new AbortController()
    running.set(chatId, controller)
    return streamSSE(c, async (stream) => {
      stream.onAbort(() => controller.abort())
      let writes = Promise.resolve()
      const emit = (ev: AgentEvent): void => {
        writes = writes.then(() => stream.writeSSE({ event: ev.type, data: JSON.stringify(ev) })).catch(() => undefined)
      }
      try {
        await run(emit, controller.signal)
      } catch (err) {
        emit({ type: 'error', message: err instanceof Error ? err.message : String(err) })
        emit({ type: 'done', message: null })
      } finally {
        running.delete(chatId)
        await writes
      }
    })
  }

  app.post('/api/chats/:id/messages', async (c) => {
    const chatId = c.req.param('id')
    const b = await body<{ content?: string; mode?: ChatMode; target?: string; attachments?: IncomingAttachment[] }>(c)
    if (b.mode && !MODES.includes(b.mode)) return bad(c, 'Invalid mode')
    const hasFiles = Array.isArray(b.attachments) && b.attachments.length > 0
    if (!b.content?.trim() && !hasFiles) return bad(c, 'Message is empty')
    return streamRun(c, chatId, (emit, signal) => core.chats.send(chatId, { content: b.content ?? '', attachments: b.attachments, mode: b.mode, target: b.target, signal, emit }))
  })

  app.post('/api/chats/:id/edit', async (c) => {
    const chatId = c.req.param('id')
    const b = await body<{ messageId?: string; content?: string; mode?: ChatMode; target?: string; attachments?: IncomingAttachment[] }>(c)
    if (!b.messageId) return bad(c, 'messageId is required')
    if (b.mode && !MODES.includes(b.mode)) return bad(c, 'Invalid mode')
    const hasFiles = Array.isArray(b.attachments) && b.attachments.length > 0
    if (!b.content?.trim() && !hasFiles) return bad(c, 'Message is empty')
    return streamRun(c, chatId, (emit, signal) => core.chats.edit(chatId, b.messageId!, { content: b.content ?? '', attachments: b.attachments, mode: b.mode, target: b.target, signal, emit }))
  })

  app.post('/api/chats/:id/regenerate', async (c) => {
    const chatId = c.req.param('id')
    const b = await body<{ mode?: ChatMode; target?: string }>(c)
    if (b.mode && !MODES.includes(b.mode)) return bad(c, 'Invalid mode')
    return streamRun(c, chatId, (emit, signal) => core.chats.regenerate(chatId, { mode: b.mode, target: b.target, signal, emit }))
  })

  app.post('/api/chats/:id/abort', (c) => {
    const ctl = running.get(c.req.param('id'))
    ctl?.abort()
    return c.json({ ok: !!ctl })
  })

  // Approvals

  app.get('/api/approvals', (c) => c.json(core.approvals.list()))
  app.post('/api/approvals/:id', async (c) => {
    const b = await body<{ approved?: boolean }>(c)
    return c.json({ ok: core.approvals.resolve(c.req.param('id'), !!b.approved) })
  })

  // Projects

  app.get('/api/projects', (c) =>
    c.json(store.listProjects().map((p) => ({ ...p, chatCount: store.listChats({ projectId: p.id, limit: 1000 }).length, fileCount: store.listProjectFiles(p.id).length })))
  )

  app.post('/api/projects', async (c) => {
    const b = await body<{ name?: string; description?: string; instructions?: string; workspaceDir?: string | null }>(c)
    if (!b.name?.trim()) return bad(c, 'Name is required')
    if (b.workspaceDir && !existsSync(b.workspaceDir)) return bad(c, 'That folder does not exist')
    return c.json(store.createProject({ ...b, name: b.name.trim() }), 201)
  })

  app.get('/api/projects/:id', (c) => {
    const p = store.getProject(c.req.param('id'))
    if (!p) return bad(c, 'Project not found', 404)
    return c.json({ project: p, files: store.listProjectFiles(p.id), chats: store.listChats({ projectId: p.id }), workspace: core.chats.workspaceFor(p.id) })
  })

  app.patch('/api/projects/:id', async (c) => {
    const b = await body<{ name?: string; description?: string; instructions?: string; workspaceDir?: string | null }>(c)
    if (b.workspaceDir && !existsSync(b.workspaceDir)) return bad(c, 'That folder does not exist')
    const p = store.updateProject(c.req.param('id'), b)
    return p ? c.json(p) : bad(c, 'Project not found', 404)
  })

  app.delete('/api/projects/:id', (c) => {
    store.deleteProject(c.req.param('id'))
    return c.json({ ok: true })
  })

  app.post('/api/projects/:id/files', async (c) => {
    const p = store.getProject(c.req.param('id'))
    if (!p) return bad(c, 'Project not found', 404)
    const b = await body<{ name?: string; content?: string }>(c)
    if (!b.name || typeof b.content !== 'string') return bad(c, 'name and content are required')
    if (b.content.length > 2_000_000) return bad(c, 'File is too large (2 MB text limit)')
    return c.json(store.addProjectFile(p.id, b.name, b.content), 201)
  })

  app.delete('/api/project-files/:id', (c) => {
    store.deleteProjectFile(c.req.param('id'))
    return c.json({ ok: true })
  })

  // Automations

  const withNext = (a: Automation): Automation & { running: boolean } => ({ ...a, nextRunAt: scheduler.nextRun(a.id), running: scheduler.isRunning(a.id) })

  app.get('/api/automations', (c) => c.json(store.listAutomations().map(withNext)))

  app.post('/api/automations', async (c) => {
    const b = await body<Partial<Automation>>(c)
    if (!b.name?.trim() || !b.prompt?.trim()) return bad(c, 'Name and prompt are required')
    if (b.mode && !MODES.includes(b.mode)) return bad(c, 'Invalid mode')
    const err = Scheduler.validate(b.schedule)
    if (err) return bad(c, `Invalid schedule: ${err}`)
    const a = store.createAutomation({ ...b, name: b.name.trim(), prompt: b.prompt.trim() } as Automation)
    scheduler.schedule(a)
    return c.json(withNext(a), 201)
  })

  app.patch('/api/automations/:id', async (c) => {
    const b = await body<Partial<Automation>>(c)
    if (b.mode && !MODES.includes(b.mode)) return bad(c, 'Invalid mode')
    const err = Scheduler.validate(b.schedule)
    if (err) return bad(c, `Invalid schedule: ${err}`)
    const a = store.updateAutomation(c.req.param('id'), b)
    if (!a) return bad(c, 'Automation not found', 404)
    scheduler.schedule(a)
    return c.json(withNext(a))
  })

  app.delete('/api/automations/:id', (c) => {
    scheduler.cancel(c.req.param('id'))
    scheduler.unschedule(c.req.param('id'))
    store.deleteAutomation(c.req.param('id'))
    return c.json({ ok: true })
  })

  app.post('/api/automations/:id/run', (c) => {
    const a = store.getAutomation(c.req.param('id'))
    if (!a) return bad(c, 'Automation not found', 404)
    if (scheduler.isRunning(a.id)) return bad(c, 'Already running', 409)
    void scheduler.run(a.id).catch(() => undefined)
    return c.json({ ok: true }, 202)
  })

  app.post('/api/automations/:id/cancel', (c) => c.json({ ok: scheduler.cancel(c.req.param('id')) }))
  app.get('/api/automations/:id/runs', (c) => c.json(store.listRuns(c.req.param('id'))))

  // Providers

  app.get('/api/providers', async (c) => c.json(await registry.summaries()))

  app.get('/api/models', async (c) => {
    const out: ModelOption[] = []
    await Promise.all(
      registry.list().map(async (p) => {
        if (!registry.enabled(p.id)) return
        for (const m of await p.models().catch(() => [])) out.push({ providerId: p.id, id: m.id, name: m.name, tags: m.tags })
      })
    )
    return c.json({ auto: AUTO_TARGETS, models: out })
  })

  app.post('/api/providers/custom', async (c) => {
    const b = await body<{ name?: string; baseUrl?: string; model?: string; secret?: string }>(c)
    try {
      const p = registry.createCustom({ name: b.name ?? '', baseUrl: b.baseUrl ?? '', model: b.model, secret: b.secret })
      return c.json(await registry.summary(p), 201)
    } catch (err) {
      return bad(c, err instanceof Error ? err.message : String(err), 400)
    }
  })

  app.delete('/api/providers/:id', (c) => {
    const pid = c.req.param('id')
    if (!isCustomProviderId(pid)) return bad(c, 'Only custom APIs can be removed', 400)
    if (!registry.removeCustom(pid)) return bad(c, 'Unknown provider', 404)
    return c.json({ ok: true })
  })

  app.patch('/api/providers/:id', async (c) => {
    const pid = c.req.param('id')
    if (!registry.get(pid)) return bad(c, 'Unknown provider', 404)
    const b = await body<{ enabled?: boolean; priority?: number; config?: Record<string, unknown> }>(c)
    store.updateProviderSettings(pid, b)
    return c.json(await registry.summary(registry.get(pid)!))
  })

  app.put('/api/providers/:id/secret', async (c) => {
    const pid = c.req.param('id')
    if (!registry.get(pid)) return bad(c, 'Unknown provider', 404)
    const b = await body<{ secret?: string | null }>(c)
    store.setProviderSecret(pid, b.secret?.trim() || null)
    return c.json(await registry.summary(registry.get(pid)!))
  })

  app.put('/api/providers/order', async (c) => {
    const b = await body<{ ids?: string[] }>(c)
    ;(b.ids ?? []).forEach((pid, i) => {
      if (registry.get(pid)) store.updateProviderSettings(pid, { priority: (i + 1) * 10 })
    })
    return c.json(await registry.summaries())
  })

  app.post('/api/providers/:id/test', async (c) => {
    const p = registry.get(c.req.param('id'))
    if (!p) return bad(c, 'Unknown provider', 404)
    const started = Date.now()
    try {
      const st = await p.status()
      if (st.state !== 'ready') return c.json({ ok: false, message: st.message ?? st.state })
      const model = await p.defaultModel()
      const text = await core.router.direct(p, model, [{ role: 'user', content: 'Reply with exactly: pong' }], { signal: AbortSignal.timeout(p.kind === 'api' ? 60_000 : 240_000) })
      return c.json({ ok: true, message: `Replied in ${((Date.now() - started) / 1000).toFixed(1)}s: ${text.trim().slice(0, 120)}` })
    } catch (err) {
      return c.json({ ok: false, message: err instanceof Error ? err.message : String(err) })
    }
  })

  app.get('/api/providers/:id/models', async (c) => c.json(await registry.modelsFor(c.req.param('id'))))

  app.post('/api/providers/:id/connect', (c) => {
    const web = registry.web(c.req.param('id'))
    if (!web) return bad(c, 'Only web providers can connect', 400)
    void web.connect().catch(() => undefined)
    return c.json({ ok: true, message: 'A browser window is opening. Sign in, then close the window.' }, 202)
  })

  app.post('/api/providers/:id/check', async (c) => {
    const web = registry.web(c.req.param('id'))
    if (!web) return bad(c, 'Only web providers can be checked', 400)
    const loggedIn = await web.checkLogin()
    return c.json({ loggedIn, summary: await registry.summary(web) })
  })

  app.post('/api/providers/:id/disconnect', async (c) => {
    const web = registry.web(c.req.param('id'))
    if (!web) return bad(c, 'Only web providers can disconnect', 400)
    await web.disconnect()
    return c.json(await registry.summary(web))
  })

  const siteIdFor = (providerId: string): string | undefined => WEB_SITES.find((s) => `web-${s.id.replace(/-web$/, '')}` === providerId)?.id

  app.get('/api/providers/:id/site', (c) => {
    const siteId = siteIdFor(c.req.param('id'))
    if (!siteId) return bad(c, 'Not a web provider', 404)
    return c.json({ config: loadSiteConfig(cfg.dataDir, siteId), defaults: WEB_SITES.find((s) => s.id === siteId), overridden: existsSync(siteOverridePath(cfg.dataDir, siteId)) })
  })

  app.put('/api/providers/:id/site', async (c) => {
    const siteId = siteIdFor(c.req.param('id'))
    if (!siteId) return bad(c, 'Not a web provider', 404)
    const b = await body<Record<string, unknown> | null>(c)
    const file = siteOverridePath(cfg.dataDir, siteId)
    if (!b || Object.keys(b).length === 0) {
      rmSync(file, { force: true })
      return c.json({ config: loadSiteConfig(cfg.dataDir, siteId), overridden: false })
    }
    const errors = validateSiteConfig(b)
    if (errors.length) return bad(c, errors.join('; '))
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(b, null, 2))
    return c.json({ config: loadSiteConfig(cfg.dataDir, siteId), overridden: true })
  })

  // MCP servers the agent can use

  app.get('/api/mcp-servers', (c) => c.json({ servers: store.listMcpServers(), status: core.mcp.status() }))

  app.post('/api/mcp-servers', async (c) => {
    const b = await body<{ id?: string; name?: string; transport?: 'stdio' | 'http'; command?: string; args?: string[]; url?: string; env?: Record<string, string>; enabled?: boolean }>(c)
    if (!b.name?.trim()) return bad(c, 'Name is required')
    if (b.transport !== 'stdio' && b.transport !== 'http') return bad(c, 'Transport must be stdio or http')
    if (b.transport === 'stdio' && !b.command?.trim()) return bad(c, 'Command is required')
    if (b.transport === 'http' && !/^https?:\/\//.test(b.url ?? '')) return bad(c, 'A valid URL is required')
    const s = store.upsertMcpServer({ ...b, name: b.name.trim(), transport: b.transport })
    await core.mcp.reconnect(s.id)
    return c.json({ server: s, status: core.mcp.status()[s.id] })
  })

  app.delete('/api/mcp-servers/:id', async (c) => {
    store.deleteMcpServer(c.req.param('id'))
    await core.mcp.tools()
    return c.json({ ok: true })
  })

  app.get('/api/tools', async (c) => c.json((await core.runner.tools()).map((t) => ({ name: t.spec.name, description: t.spec.description, requiresApproval: t.requiresApproval }))))

  // Integrations

  app.get('/api/integrations/claude-desktop', (c) => c.json({ linked: claudeDesktopLinked(), configPath: claudeDesktopConfigPath(), entry: serverInfo(cfg).mcpStdio }))

  app.post('/api/integrations/claude-desktop', async (c) => {
    const b = await body<{ remove?: boolean }>(c)
    const file = claudeDesktopConfigPath()
    let config: { mcpServers?: Record<string, unknown> } = {}
    if (existsSync(file)) {
      try {
        config = JSON.parse(readFileSync(file, 'utf8'))
      } catch {
        return bad(c, `Could not parse ${file}. Fix or delete it and try again.`)
      }
    }
    config.mcpServers = config.mcpServers ?? {}
    if (b.remove) delete config.mcpServers.freeagent
    else config.mcpServers.freeagent = serverInfo(cfg).mcpStdio
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(config, null, 2))
    return c.json({ linked: !b.remove, configPath: file, message: b.remove ? 'Removed. Restart Claude Desktop.' : 'Added. Restart Claude Desktop to load FreeAgent.' })
  })

  app.notFound((c) => c.json({ error: 'Not found' }, 404))
  app.onError((err, c) => c.json({ error: err.message }, 500))

  return app
}
