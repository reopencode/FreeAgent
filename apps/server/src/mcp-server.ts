import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { applyTextDelta, type Core } from '@freeagent/core'
import { VERSION } from './config'
import type { Scheduler } from './scheduler'

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })
const fail = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true })

/** Tools FreeAgent offers to MCP clients such as Claude Desktop. */
export function createMcpServer(core: Core, scheduler: Scheduler): McpServer {
  const server = new McpServer({ name: 'freeagent', version: VERSION })

  server.registerTool(
    'list_providers',
    { description: 'List the AI providers FreeAgent can use (free APIs, web chat plans, local coding agents) and whether each is ready.', inputSchema: {} },
    async () => {
      const list = await core.registry.summaries()
      return text(
        list
          .filter((p) => p.id !== 'mock')
          .map((p) => `${p.id} (${p.kind}) — ${p.name}: ${p.enabled ? p.status.state : 'disabled'}${p.status.message ? ` · ${p.status.message}` : ''}`)
          .join('\n')
      )
    }
  )

  server.registerTool(
    'ask_provider',
    {
      description:
        'Ask a question through FreeAgent. With target "auto" it picks the best free provider and falls back on rate limits. Use mode "council" to ask several providers and merge their answers.',
      inputSchema: {
        prompt: z.string().describe('The full question or task'),
        target: z.string().optional().describe('auto, auto-code, auto-fast, auto-long, a provider id like web-grok or openrouter, or provider::model'),
        mode: z.enum(['chat', 'council']).optional(),
        project: z.string().optional().describe('Project id or name whose instructions and files should be used')
      }
    },
    async ({ prompt, target, mode, project }) => {
      try {
        const projectId = project ? core.store.listProjects().find((p) => p.id === project || p.name.toLowerCase() === project.toLowerCase())?.id : undefined
        const r = await core.chats.runOnce({ prompt, target: target ?? 'auto', mode: mode ?? 'chat', projectId })
        return text(`${r.text}\n\n— answered by ${r.meta.providerId ?? 'unknown'}${r.meta.model ? ` (${r.meta.model})` : ''}`)
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err))
      }
    }
  )

  server.registerTool(
    'run_automation',
    {
      description: 'Run one of the user\'s saved FreeAgent automations now and return its output.',
      inputSchema: { automation: z.string().describe('Automation id or name') }
    },
    async ({ automation }) => {
      const a = core.store.listAutomations().find((x) => x.id === automation || x.name.toLowerCase() === automation.toLowerCase())
      if (!a) return fail(`No automation named "${automation}". Available: ${core.store.listAutomations().map((x) => x.name).join(', ') || 'none'}`)
      try {
        const run = await scheduler.run(a.id)
        return run.status === 'success' ? text(run.output) : fail(run.error ?? 'Run failed')
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err))
      }
    }
  )

  server.registerTool(
    'search_projects',
    {
      description: 'Search FreeAgent projects and their chats by name. Returns project instructions and recent chat titles.',
      inputSchema: { query: z.string().optional() }
    },
    async ({ query }) => {
      const q = (query ?? '').toLowerCase()
      const projects = core.store.listProjects().filter((p) => !q || p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q))
      const chats = core.store.listChats({ query: query || undefined, limit: 15 })
      const lines = projects.map((p) => {
        const pc = core.store.listChats({ projectId: p.id, limit: 5 })
        return `Project ${p.name} (${p.id})${p.workspaceDir ? ` · folder ${p.workspaceDir}` : ''}\n  Instructions: ${p.instructions.slice(0, 300) || '(none)'}\n  Chats: ${pc.map((c) => c.title).join('; ') || '(none)'}`
      })
      if (q) lines.push(`Chats matching "${query}": ${chats.map((c) => c.title).join('; ') || '(none)'}`)
      return text(lines.join('\n\n') || 'No projects yet.')
    }
  )

  server.registerTool(
    'delegate_to_app',
    {
      description: 'Hand a coding task to a local coding agent (OpenCode, Kiro, Kilo or Claude Code) in a project folder. It can edit files.',
      inputSchema: {
        app: z.enum(['opencode', 'kiro', 'kilo', 'claude']),
        task: z.string(),
        project: z.string().optional().describe('Project id or name; its folder is used as the working directory')
      }
    },
    async ({ app, task, project }) => {
      const p = core.registry.get(app)
      if (!p) return fail(`Unknown app ${app}`)
      const st = await p.status()
      if (st.state !== 'ready') return fail(`${p.name} is not ready: ${st.message ?? st.state}`)
      const projectId = project ? core.store.listProjects().find((x) => x.id === project || x.name.toLowerCase() === project.toLowerCase())?.id : undefined
      let out = ''
      try {
        for await (const d of p.chat([{ role: 'user', content: task }], { cwd: core.chats.workspaceFor(projectId) })) if (d.type === 'text') out = applyTextDelta(out, d)
        return text(out.trim() || '(no output)')
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err))
      }
    }
  )

  return server
}
