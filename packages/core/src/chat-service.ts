import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentEvent, Attachment, ChatMode, IncomingAttachment, StoredMessage } from './api-types'
import { listPlugins, listSkills, readPlugin, readRules } from './agent/instructions'
import type { AgentRunner, RunResult } from './agent/runner'
import { attachmentKind, isTextAttachment, parseIncomingAttachments, readChatMedia, removeChatFile, saveChatMedia, TEXT_INLINE_LIMIT } from './media'
import type { Store } from './store'
import type { ChatAttachment, ChatMessage } from './types'
import { applyTextDelta, truncate } from './util'

const PROJECT_FILES_BUDGET = 40_000
const PLUGIN_BUDGET = 40_000
const HISTORY_LIMIT = 40

function mediaFlags(messages: ChatMessage[]): { images: boolean; audio: boolean } {
  let images = false
  let audio = false
  for (const m of messages) {
    for (const a of m.attachments ?? []) {
      if (a.kind === 'image') images = true
      if (a.kind === 'audio') audio = true
    }
  }
  return { images, audio }
}

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

  systemPrompt(projectId: string | null | undefined, mode: ChatMode, cwd: string, chatId?: string): string {
    const settings = this.store.getSettings()
    const parts = [settings.systemPrompt]
    const project = projectId ? this.store.getProject(projectId) : undefined
    const chat = chatId ? this.store.getChat(chatId) : undefined
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
    const rules = readRules(cwd)
    if (rules) parts.push(`Project rules (AGENTS.md):\n${rules}`)
    const memories = this.store.listMemories()
    if (memories.length) parts.push(`Facts the user asked to remember:\n${memories.map((m) => `- ${m.text}`).join('\n')}`)
    const pluginIds = chat && chat.pluginIds !== null ? chat.pluginIds : (project?.enabledPlugins ?? [])
    let pluginBudget = PLUGIN_BUDGET
    const pluginBodies: string[] = []
    for (const id of pluginIds) {
      if (pluginBudget <= 0) break
      const plugin = readPlugin(this.dataDir, id)
      if (!plugin) continue
      const body = truncate(plugin.body, pluginBudget)
      pluginBudget -= body.length
      pluginBodies.push(body)
    }
    if (pluginBodies.length) parts.push(`Enabled plugins:\n${pluginBodies.join('\n\n')}`)
    if (mode === 'agent') {
      parts.push(
        `You are in agent mode with tools. The project folder is ${cwd}. Plan briefly, call tools to do the work, check results, and finish with a short summary of what you did. A long request is split into tasks before you start; when told the current task, do only that task. Use delegate_to_app for larger coding jobs when OpenCode, Kiro, Kilo or Claude Code are available. Remember a fact with memory_save only when the user asked you to remember it, and remove one with memory_forget.`
      )
      const skills = listSkills(this.dataDir, cwd)
      if (skills.length) parts.push(`Skills (call read_skill with the name):\n${skills.map((s) => `- ${s.name}: ${s.summary}`).join('\n')}`)
      const plugins = listPlugins(this.dataDir)
      if (plugins.length) {
        parts.push(
          `Plugins (call enable_plugin or disable_plugin with the id):\n${plugins
            .map((p) => `- ${p.id}: ${p.name} — ${p.description}${pluginIds.includes(p.id) ? ' (on)' : ''}`)
            .join('\n')}`
        )
      }
    }
    parts.push(`Today is ${new Date().toDateString()}.`)
    return parts.join('\n\n')
  }

  /** User and assistant turns, with image and audio bytes loaded and text files inlined. */
  providerHistory(chatId: string): ChatMessage[] {
    return this.store
      .listMessages(chatId)
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && (m.content.trim() || (m.attachments?.length ?? 0) > 0))
      .slice(-HISTORY_LIMIT)
      .map((m) => this.toProviderMessage(chatId, m))
  }

  private toProviderMessage(chatId: string, m: StoredMessage): ChatMessage {
    const notes: string[] = []
    const attachments: ChatAttachment[] = []
    for (const a of m.attachments ?? []) {
      const data = readChatMedia(this.dataDir, chatId, a.id)
      if (!data) continue
      if (a.kind === 'file') {
        if (isTextAttachment(a.mime, a.name) && !data.includes(0)) {
          notes.push(`<file name="${a.name.replace(/"/g, '')}">\n${data.toString('utf8').slice(0, TEXT_INLINE_LIMIT)}\n</file>`)
        } else notes.push(`Attached: ${a.name}`)
        continue
      }
      attachments.push({ kind: a.kind, name: a.name, mime: a.mime, dataBase64: data.toString('base64') })
    }
    const content = [m.content.trim(), ...notes].filter(Boolean).join('\n\n')
    return { role: m.role === 'assistant' ? 'assistant' : 'user', content, ...(attachments.length ? { attachments } : {}) }
  }

  private touch(chatId: string, opts: { mode?: ChatMode; target?: string }, titleSource?: string): void {
    const chat = this.store.getChat(chatId)
    if (!chat) throw new Error('Chat not found')
    const patch: Parameters<Store['updateChat']>[1] = {}
    if (opts.mode && opts.mode !== chat.mode) patch.mode = opts.mode
    if (opts.target && opts.target !== chat.target) patch.target = opts.target
    if (titleSource && chat.title === 'New chat') patch.title = titleFrom(titleSource)
    if (Object.keys(patch).length) this.store.updateChat(chatId, patch)
  }

  private forgetMedia(chatId: string, messages: StoredMessage[]): void {
    for (const m of messages) for (const a of m.attachments ?? []) removeChatFile(this.dataDir, chatId, a.id)
  }

  private persistMedia(chatId: string, media: RunResult['media']): Attachment[] {
    const saved: Attachment[] = []
    for (const part of media ?? []) {
      const data = Buffer.from(part.base64, 'base64')
      if (!data.length) continue
      const mime = part.mime || 'application/octet-stream'
      const kind = attachmentKind(mime)
      saved.push(saveChatMedia(this.dataDir, chatId, { name: part.name || (kind === 'audio' ? 'audio' : 'image'), mime, kind, data }))
    }
    return saved
  }

  /** Runs the current history and stores the assistant reply. */
  private async complete(chatId: string, opts: { signal?: AbortSignal; emit: (ev: AgentEvent) => void }): Promise<StoredMessage | null> {
    const chat = this.store.getChat(chatId)
    if (!chat) throw new Error('Chat not found')
    const cwd = this.workspaceFor(chat.projectId)
    const settings = this.store.getSettings()
    const history = this.providerHistory(chatId)
    const flags = mediaFlags(history)
    const messages: ChatMessage[] = [{ role: 'system', content: this.systemPrompt(chat.projectId, chat.mode, cwd, chatId) }, ...history]
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
        images: flags.images,
        audio: flags.audio,
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
    const saved = this.store.addMessage({ chatId, role: 'assistant', content: result.text, meta: result.meta, attachments: this.persistMedia(chatId, result.media) })
    opts.emit({ type: 'done', message: saved })
    return saved
  }

  /**
   * Checks the new turn against the provider before anything is deleted or stored.
   * `ignoreFrom` drops that message and everything after it from the check, which is the range an edit will remove.
   */
  private async prepareTurn(
    chatId: string,
    input: { content: string; attachments?: IncomingAttachment[]; mode?: ChatMode; target?: string },
    ignoreFrom?: string
  ): Promise<{ text: string; parsed: ReturnType<typeof parseIncomingAttachments> }> {
    const parsed = parseIncomingAttachments(input.attachments)
    const text = input.content.trim()
    if (!text && !parsed.length) throw new Error('Message is empty')
    const chat = this.store.getChat(chatId)
    if (!chat) throw new Error('Chat not found')
    const target = input.target || chat.target
    const prior = this.store.listMessages(chatId)
    const cut = ignoreFrom ? prior.findIndex((m) => m.id === ignoreFrom) : prior.length
    const kept = (cut < 0 ? prior : prior.slice(0, cut))
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && (m.content.trim() || (m.attachments?.length ?? 0) > 0))
      .slice(-HISTORY_LIMIT)
      .map((m) => this.toProviderMessage(chatId, m))
    const pending: ChatMessage = {
      role: 'user',
      content: text,
      attachments: parsed.filter((a) => a.kind !== 'file').map((a) => ({ kind: a.kind, name: a.name, mime: a.mime, dataBase64: 'pending' }))
    }
    const flags = mediaFlags([...kept, pending])
    if (flags.images || flags.audio) await this.runner.ensureMedia(target, flags)
    this.touch(chatId, input, text || parsed.map((a) => a.name).join(', '))
    return { text, parsed }
  }

  private storeUserTurn(chatId: string, text: string, parsed: ReturnType<typeof parseIncomingAttachments>, emit: (ev: AgentEvent) => void): void {
    const attachments = parsed.map((a) => saveChatMedia(this.dataDir, chatId, a))
    const userMsg = this.store.addMessage({ chatId, role: 'user', content: text, attachments })
    emit({ type: 'user_message', message: userMsg })
  }

  /** Sends a user message in a saved chat, streams events, and stores the reply. */
  async send(
    chatId: string,
    input: { content: string; attachments?: IncomingAttachment[]; mode?: ChatMode; target?: string; signal?: AbortSignal; emit: (ev: AgentEvent) => void }
  ): Promise<StoredMessage | null> {
    const { text, parsed } = await this.prepareTurn(chatId, input)
    this.storeUserTurn(chatId, text, parsed, input.emit)
    return this.complete(chatId, input)
  }

  /** Replaces the last user message (and everything after it) and sends the new one. */
  async edit(
    chatId: string,
    messageId: string,
    input: { content: string; attachments?: IncomingAttachment[]; mode?: ChatMode; target?: string; signal?: AbortSignal; emit: (ev: AgentEvent) => void }
  ): Promise<StoredMessage | null> {
    const lastUser = [...this.store.listMessages(chatId)].reverse().find((m) => m.role === 'user')
    if (!lastUser || lastUser.id !== messageId) throw new Error('Only the last message you sent can be edited.')
    const { text, parsed } = await this.prepareTurn(chatId, input, messageId)
    this.forgetMedia(chatId, this.store.deleteFrom(chatId, messageId))
    this.storeUserTurn(chatId, text, parsed, input.emit)
    return this.complete(chatId, input)
  }

  /** Drops the last reply and runs the same history again. */
  async regenerate(
    chatId: string,
    input: { mode?: ChatMode; target?: string; signal?: AbortSignal; emit: (ev: AgentEvent) => void }
  ): Promise<StoredMessage | null> {
    const messages = this.store.listMessages(chatId)
    let lastUser = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        lastUser = i
        break
      }
    }
    if (lastUser < 0) throw new Error('There is no message to regenerate.')
    const rest = messages.slice(lastUser + 1)
    if (!rest.length) throw new Error('There is no reply to regenerate.')
    const chat = this.store.getChat(chatId)
    if (!chat) throw new Error('Chat not found')
    const flags = mediaFlags(this.providerHistory(chatId))
    if (flags.images || flags.audio) await this.runner.ensureMedia(input.target || chat.target, flags)
    this.touch(chatId, input)
    this.forgetMedia(chatId, this.store.deleteFrom(chatId, rest[0].id))
    return this.complete(chatId, input)
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
