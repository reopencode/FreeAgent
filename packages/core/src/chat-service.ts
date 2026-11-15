import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentEvent, ChatMode, StoredMessage } from './api-types'
import type { AgentRunner, RunResult } from './agent/runner'
import type { Store } from './store'
import type { ChatMessage } from './types'
import { applyTextDelta, truncate } from './util'

const PROJECT_FILES_BUDGET = 40_000
const HISTORY_LIMIT = 40

export class ChatService {
  constructor(
    private readonly store: Store,
    private readonly runner: AgentRunner,
    private readonly dataDir: string
  ) {}

  workspaceFor(projectId: string | null | undefined): string {
    const p = projectId ? this.store.getProject(projectId) : undefined
    if (p?.workspaceDir) return p.workspaceDir
    const dir = join(this.dataDir, 'workspaces', projectId ?? 'default')
    mkdirSync(dir, { recursive: true })
    return dir
  }

  systemPrompt(projectId: string | null | undefined, mode: ChatMode, cwd: string): string {
    const settings = this.store.getSettings()
    const parts = [settings.systemPrompt]
    const project = projectId ? this.store.getProject(projectId) : undefined
    if (project) {
      parts.push(`You are working in the project "${project.name}".${project.description ? ` ${project.description}` : ''}`)
      if (project.instructions.trim()) parts.push(`Project instructions:\n${project.instructions.trim()}`)
      let budget = PROJECT_FILES_BUDGET
      const files = this.store.listProjectFiles(project.id)
      const blocks: string[] = []
      for (const f of files) {
        if (budget <= 0) break
        const content = truncate(f.content, budget)
        budget -= content.length
        blocks.push(`<file name="${f.name}">\n${content}\n</file>`)
      }
      if (blocks.length) parts.push(`Project files:\n${blocks.join('\n')}`)
    }
    if (mode === 'agent') {
      parts.push(
        `You are in agent mode with tools. The project folder is ${cwd}. Plan briefly, call tools to do the work, check results, and finish with a short summary of what you did. Use delegate_to_app for larger coding jobs when OpenCode, Kiro or Claude Code are available.`
      )
    }
    parts.push(`Today is ${new Date().toDateString()}.`)
    return parts.join('\n\n')
  }

  history(chatId: string): ChatMessage[] {
    return this.store
      .listMessages(chatId)
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim())
      .slice(-HISTORY_LIMIT)
      .map((m) => ({ role: m.role, content: m.content }))
  }

  /** Sends a user message in a saved chat, streams events, and stores the reply. */
  async send(
    chatId: string,
    content: string,
    opts: { mode?: ChatMode; target?: string; signal?: AbortSignal; emit: (ev: AgentEvent) => void }
  ): Promise<StoredMessage | null> {
    let chat = this.store.getChat(chatId)
    if (!chat) throw new Error('Chat not found')
    const patch: Parameters<Store['updateChat']>[1] = {}
    if (opts.mode && opts.mode !== chat.mode) patch.mode = opts.mode
    if (opts.target && opts.target !== chat.target) patch.target = opts.target
    if (chat.title === 'New chat') patch.title = titleFrom(content)
    if (Object.keys(patch).length) chat = this.store.updateChat(chatId, patch)!

    const userMsg = this.store.addMessage({ chatId, role: 'user', content })
    opts.emit({ type: 'user_message', message: userMsg })
    const cwd = this.workspaceFor(chat.projectId)
    const settings = this.store.getSettings()
    const messages: ChatMessage[] = [{ role: 'system', content: this.systemPrompt(chat.projectId, chat.mode, cwd) }, ...this.history(chatId)]

    let result: RunResult | undefined
    let partial = ''
    try {
      result = await this.runner.run({
        messages,
        mode: chat.mode,
        target: chat.target,
        cwd,
        chatId,
        signal: opts.signal,
        autoApprove: settings.autoApprove,
        maxSteps: settings.maxAgentSteps,
        councilSize: settings.councilSize,
        emit: (ev) => {
          if (ev.type === 'text') partial = applyTextDelta(partial, ev)
          if (ev.type === 'route') partial = ''
          opts.emit(ev)
        }
      })
    } catch (err) {
      const message = opts.signal?.aborted ? 'Stopped.' : err instanceof Error ? err.message : String(err)
      opts.emit({ type: 'error', message })
      const saved = this.store.addMessage({ chatId, role: 'assistant', content: partial, meta: { error: message } })
      opts.emit({ type: 'done', message: saved })
      return saved
    }
    const saved = this.store.addMessage({ chatId, role: 'assistant', content: result.text, meta: result.meta })
    opts.emit({ type: 'done', message: saved })
    return saved
  }

  /** One-off run outside a saved chat, used by automations and the MCP server. */
  async runOnce(input: {
    prompt: string
    projectId?: string | null
    mode?: ChatMode
    target?: string
    signal?: AbortSignal
    emit?: (ev: AgentEvent) => void
    autoApprove?: boolean
  }): Promise<RunResult> {
    const mode = input.mode ?? 'chat'
    const cwd = this.workspaceFor(input.projectId)
    const settings = this.store.getSettings()
    return this.runner.run({
      messages: [
        { role: 'system', content: this.systemPrompt(input.projectId, mode, cwd) },
        { role: 'user', content: input.prompt }
      ],
      mode,
      target: input.target ?? 'auto',
      cwd,
      signal: input.signal,
      autoApprove: input.autoApprove ?? settings.autoApprove,
      maxSteps: settings.maxAgentSteps,
      councilSize: settings.councilSize,
      emit: input.emit ?? (() => undefined)
    })
  }
}

export function titleFrom(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > 60 ? line.slice(0, 57).trimEnd() + '…' : line || 'New chat'
}
