import type { AgentEvent, AgentTask, ChatMode, CouncilAnswer, MessageMeta, RouteAttempt, ToolStep } from '../api-types'
import type { ProviderRegistry } from '../providers/registry'
import { NoProviderError, Router, type RouteRequest, type RouterEvent } from '../router'
import type { Store } from '../store'
import type { ChatMessage, ToolCall, ToolSpec } from '../types'
import { applyTextDelta, id, safeJson, truncate } from '../util'
import type { Approvals } from './approvals'
import type { McpManager } from './mcp-client'
import { BUILTIN_TOOLS, type AgentTool } from './tools'

export interface RunInput {
  messages: ChatMessage[]
  mode: ChatMode
  target: string
  cwd: string
  chatId?: string
  signal?: AbortSignal
  emit: (ev: AgentEvent) => void
  autoApprove?: boolean
  maxSteps?: number
  councilSize?: number
  /** Conversation includes an image, so the router skips providers that cannot see it. */
  images?: boolean
  /** Conversation includes audio, so Auto is limited to Gemini. */
  audio?: boolean
}

export interface RunResult {
  text: string
  meta: MessageMeta
  /** Images and audio the provider returned. The chat service saves the bytes. */
  media?: { mime: string; name?: string; base64: string }[]
}

export interface RunnerDeps {
  router: Router
  registry: ProviderRegistry
  store: Store
  approvals: Approvals
  mcp?: McpManager
  dataDir: string
  /** Extra tools used by tests. */
  extraTools?: AgentTool[]
}

const UPDATE_TASKS: ToolSpec = {
  name: 'update_tasks',
  description: 'Replace the task list. One short title per task, in the order they should be done.',
  parameters: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } }, required: ['title'] }
      }
    },
    required: ['tasks']
  }
}

/** A request is large when it is long or already written as a list of two or more items. */
export function isLargeRequest(text: string): boolean {
  if (text.trim().length >= 400) return true
  return text.split('\n').filter((line) => /^\s*(?:[-*+]|\d+[.)])\s+\S/.test(line)).length >= 2
}

function parseTasks(argumentsJson: string | undefined): AgentTask[] {
  if (!argumentsJson) return []
  const args = safeJson<{ tasks?: unknown }>(argumentsJson, {})
  if (!Array.isArray(args.tasks)) return []
  const tasks: AgentTask[] = []
  const seen = new Set<string>()
  for (const item of args.tasks) {
    if (!item || typeof item !== 'object') continue
    const title = typeof (item as { title?: unknown }).title === 'string' ? (item as { title: string }).title.trim() : ''
    if (!title) continue
    const given = typeof (item as { id?: unknown }).id === 'string' ? (item as { id: string }).id.trim() : ''
    let id = given || `task_${tasks.length + 1}`
    while (seen.has(id)) id = `${id}_${tasks.length + 1}`
    seen.add(id)
    tasks.push({ id, title: title.slice(0, 200), status: 'pending' })
    if (tasks.length >= 12) break
  }
  return tasks
}

interface LoopState {
  convo: ChatMessage[]
  input: RunInput
  meta: MessageMeta
  attempts: RouteAttempt[]
  media: { mime: string; name?: string; base64: string }[]
  maxSteps: number
  stepsUsed: number
  sessionId: string
  target: string
  pinned: boolean
  finalText: string
}

const TOOL_RESULT_LIMIT = 12_000

export class AgentRunner {
  constructor(private readonly deps: RunnerDeps) {}

  /** Rejects a turn whose images or audio cannot be sent to the chosen target. */
  async ensureMedia(target: string, flags: { images?: boolean; audio?: boolean }): Promise<void> {
    if (!flags.images && !flags.audio) return
    const list = await this.deps.router.candidates({ target, images: flags.images, audio: flags.audio })
    if (list.length) return
    if (flags.audio) throw new NoProviderError('No ready provider accepts audio. Add a Gemini API key, or pick an API provider that accepts it.')
    throw new NoProviderError('No ready provider accepts images. Website and app providers cannot take them.')
  }

  async tools(): Promise<AgentTool[]> {
    const mcpTools = (await this.deps.mcp?.tools().catch(() => [])) ?? []
    return [...BUILTIN_TOOLS, ...(this.deps.extraTools ?? []), ...mcpTools]
  }

  async run(input: RunInput): Promise<RunResult> {
    const started = Date.now()
    const result = input.mode === 'council' ? await this.council(input) : input.mode === 'agent' ? await this.agent(input) : await this.chat(input)
    result.meta.durationMs = Date.now() - started
    return result
  }

  /** Forwards router events to the UI and records which providers were tried. */
  private track(ev: RouterEvent, input: RunInput, meta: MessageMeta, attempts: RouteAttempt[]): void {
    if (ev.type === 'route') {
      attempts.push({ providerId: ev.providerId, model: ev.model })
      meta.providerId = ev.providerId
      meta.model = ev.model
      input.emit({ type: 'route', providerId: ev.providerId, model: ev.model, attempt: ev.attempt })
    } else if (ev.type === 'fallback') {
      const last = attempts[attempts.length - 1]
      if (last) last.error = ev.error
      input.emit({ type: 'fallback', providerId: ev.providerId, model: ev.model, error: ev.error })
    } else if (ev.type === 'text') input.emit({ type: 'text', text: ev.text, replace: ev.replace })
    else if (ev.type === 'media') input.emit({ type: 'media', mime: ev.mime, name: ev.name, base64: ev.base64 })
    else if (ev.type === 'status') input.emit({ type: 'status', message: ev.message })
  }

  private routeFlags(input: RunInput): { images?: boolean; audio?: boolean } {
    return { images: input.images, audio: input.audio }
  }

  private async chat(input: RunInput): Promise<RunResult> {
    const meta: MessageMeta = {}
    const attempts: RouteAttempt[] = []
    let text = ''
    const media: { mime: string; name?: string; base64: string }[] = []
    // A saved chat keeps one website conversation open across turns, so its id is the session id.
    // The session ends when the chat is deleted (see DELETE /api/chats/:id), not when this turn finishes.
    for await (const ev of this.deps.router.chat(input.messages, { target: input.target, signal: input.signal, cwd: input.cwd, sessionId: input.chatId, ...this.routeFlags(input) })) {
      this.track(ev, input, meta, attempts)
      if (ev.type === 'route') {
        text = ''
        media.length = 0
      }
      if (ev.type === 'text') text = applyTextDelta(text, ev)
      if (ev.type === 'media') media.push({ mime: ev.mime, name: ev.name, base64: ev.base64 })
    }
    meta.attempts = attempts
    return { text, meta, media: [...media] }
  }

  private async agent(input: RunInput): Promise<RunResult> {
    const tools = await this.tools()
    const byName = new Map(tools.map((t) => [t.spec.name, t]))
    const specs = tools.map((t) => t.spec)
    // One id for the whole run lets web providers keep a single site conversation open across steps.
    // A saved chat uses its own id, so its agent turns continue that conversation; the chat's deletion ends it.
    const state: LoopState = {
      convo: [...input.messages],
      input,
      meta: { steps: [] },
      attempts: [],
      media: [],
      maxSteps: input.maxSteps ?? 12,
      stepsUsed: 0,
      sessionId: input.chatId ?? id('run_'),
      target: input.target,
      pinned: false,
      finalText: ''
    }

    try {
      const latest = [...state.convo].reverse().find((m) => m.role === 'user')?.content ?? ''
      if (isLargeRequest(latest) && state.stepsUsed < state.maxSteps) {
        state.input.emit({ type: 'step_start', step: state.stepsUsed })
        const planned = await this.modelStep(state, [UPDATE_TASKS])
        state.stepsUsed++
        this.pin(state)
        const tasks = parseTasks(planned.calls.find((c) => c.name === 'update_tasks')?.arguments)
        if (tasks.length >= 2) {
          state.meta.tasks = tasks
          const publish = (): void => input.emit({ type: 'task_list', tasks: tasks.map((t) => ({ ...t })) })
          publish()
          for (let i = 0; i < tasks.length; i++) {
            if (state.stepsUsed >= state.maxSteps) {
              this.noteStop(state)
              break
            }
            tasks[i].status = 'running'
            publish()
            state.convo.push({
              role: 'user',
              content: `Current task (${i + 1}/${tasks.length}): ${tasks[i].title}. Do this task only. When it is finished, stop calling tools.`
            })
            const hitCap = await this.workUntilQuiet(state, specs, byName)
            tasks[i].status = 'done'
            publish()
            if (hitCap) {
              this.noteStop(state)
              break
            }
          }
          state.meta.attempts = state.attempts
          return { text: state.finalText, meta: state.meta, media: state.media }
        }
      }
      if (await this.workUntilQuiet(state, specs, byName)) this.noteStop(state)
    } finally {
      if (!input.chatId) await this.deps.registry.endSession(state.sessionId)
    }
    state.meta.attempts = state.attempts
    return { text: state.finalText, meta: state.meta, media: state.media }
  }

  private async modelStep(state: LoopState, tools: ToolSpec[]): Promise<{ text: string; calls: ToolCall[] }> {
    let text = ''
    const calls: ToolCall[] = []
    const stepMedia: { mime: string; name?: string; base64: string }[] = []
    const opts: RouteRequest = {
      target: state.target,
      tools,
      signal: state.input.signal,
      cwd: state.input.cwd,
      sessionId: state.sessionId,
      ...this.routeFlags(state.input)
    }
    for await (const ev of this.deps.router.chat(state.convo, opts)) {
      this.track(ev, state.input, state.meta, state.attempts)
      if (ev.type === 'route') {
        text = ''
        stepMedia.length = 0
      }
      if (ev.type === 'text') text = applyTextDelta(text, ev)
      if (ev.type === 'tool_call') calls.push(ev.call)
      if (ev.type === 'media') stepMedia.push({ mime: ev.mime, name: ev.name, base64: ev.base64 })
    }
    state.media.push(...stepMedia)
    return { text, calls }
  }

  private pin(state: LoopState): void {
    if (state.pinned || !state.meta.providerId) return
    if (this.deps.registry.get(state.meta.providerId)?.kind === 'app') return
    state.target = state.meta.model ? `${state.meta.providerId}::${state.meta.model}` : state.meta.providerId
    state.pinned = true
  }

  private appendText(state: LoopState, text: string): void {
    if (!text) return
    state.finalText += (state.finalText ? '\n\n' : '') + text
  }

  private noteStop(state: LoopState): void {
    const note = `Stopped after ${state.maxSteps} steps. Ask me to continue if needed.`
    state.input.emit({ type: 'text', text: `\n\n_${note}_` })
    state.finalText += `\n\n_${note}_`
  }

  /** Runs tool rounds until the model stops. Returns true when the step cap cuts off a round that still asked for tools. */
  private async workUntilQuiet(state: LoopState, specs: ToolSpec[], byName: Map<string, AgentTool>): Promise<boolean> {
    while (state.stepsUsed < state.maxSteps) {
      state.input.emit({ type: 'step_start', step: state.stepsUsed })
      const turn = await this.modelStep(state, specs)
      state.stepsUsed++
      this.pin(state)
      this.appendText(state, turn.text)
      if (!turn.calls.length) return false
      state.convo.push({ role: 'assistant', content: turn.text, toolCalls: turn.calls })
      for (const call of turn.calls) {
        const out = await this.runTool(call, byName.get(call.name), state.input, state.meta.steps ?? [], state.media)
        state.convo.push({ role: 'tool', content: out, toolCallId: call.id, name: call.name })
      }
      if (state.stepsUsed >= state.maxSteps) return true
    }
    return false
  }

  private async runTool(call: ToolCall, tool: AgentTool | undefined, input: RunInput, steps: ToolStep[], media: LoopState['media']): Promise<string> {
    const step: ToolStep = { id: call.id, name: call.name, args: call.arguments, status: 'running' }
    steps.push(step)
    input.emit({ type: 'tool_call', id: call.id, name: call.name, args: call.arguments })
    const finish = (ok: boolean, output: string, status: ToolStep['status']): string => {
      step.ok = ok
      step.output = truncate(output, 4000)
      step.status = status
      input.emit({ type: 'tool_result', id: call.id, ok, output: truncate(output, 4000) })
      return truncate(output, TOOL_RESULT_LIMIT)
    }
    if (!tool) return finish(false, `Unknown tool "${call.name}"`, 'error')
    const args = safeJson<Record<string, unknown>>(call.arguments, {})

    if (tool.requiresApproval && !input.autoApprove) {
      step.status = 'pending_approval'
      const { req, decision } = this.deps.approvals.request(
        { chatId: input.chatId, toolCallId: call.id, name: call.name, args: call.arguments, summary: tool.summarize(args) },
        input.signal
      )
      input.emit({ type: 'approval_request', id: req.id, toolCallId: call.id, name: call.name, args: call.arguments, summary: req.summary })
      const approved = await decision
      input.emit({ type: 'approval_resolved', id: req.id, approved })
      if (!approved) return finish(false, 'The user denied this tool call. Do not retry it; continue without it or ask the user.', 'denied')
      step.status = 'running'
    }

    try {
      const raw = await tool.run(args, {
        cwd: input.cwd,
        signal: input.signal,
        registry: this.deps.registry,
        dataDir: this.deps.dataDir,
        store: this.deps.store,
        chatId: input.chatId
      })
      const text = typeof raw === 'string' ? raw : raw.text
      const images = typeof raw === 'string' ? [] : (raw.images ?? [])
      for (const img of images) {
        media.push(img)
        input.emit({ type: 'media', mime: img.mime, name: img.name, base64: img.base64 })
      }
      return finish(true, text, 'done')
    } catch (err) {
      return finish(false, `Error: ${err instanceof Error ? err.message : String(err)}`, 'error')
    }
  }

  private async council(input: RunInput): Promise<RunResult> {
    const meta: MessageMeta = { council: [] }
    const size = Math.max(2, Math.min(input.councilSize ?? 3, 5))
    const parsed = input.target.startsWith('auto') ? input.target : 'auto'
    const candidates = (await this.deps.router.candidates({ target: parsed, ...this.routeFlags(input) })).slice(0, size)
    if (!candidates.length) throw new Error('No provider is ready for council mode.')
    input.emit({ type: 'status', message: `Asking ${candidates.map((c) => c.provider.name).join(', ')}…` })

    const answers: CouncilAnswer[] = await Promise.all(
      candidates.map(async ({ provider, model }) => {
        let answer: CouncilAnswer
        try {
          const text = await this.deps.router.direct(provider, model, input.messages, { signal: input.signal, cwd: input.cwd })
          answer = { providerId: provider.id, model, text }
        } catch (err) {
          answer = { providerId: provider.id, model, text: '', error: err instanceof Error ? err.message : String(err) }
        }
        input.emit({ type: 'council_answer', answer })
        return answer
      })
    )
    meta.council = answers
    const good = answers.filter((a) => a.text.trim())
    if (!good.length) throw new Error(`Every council member failed: ${answers.map((a) => `${a.providerId}: ${a.error}`).join('; ')}`)
    if (good.length === 1) {
      input.emit({ type: 'text', text: good[0].text })
      meta.providerId = good[0].providerId
      meta.model = good[0].model
      return { text: good[0].text, meta, media: [] }
    }

    const question = [...input.messages].reverse().find((m) => m.role === 'user')?.content ?? ''
    const judgePrompt: ChatMessage[] = [
      ...input.messages.filter((m) => m.role === 'system'),
      {
        role: 'user',
        content: [
          `A user asked:\n"""${question}"""`,
          `${good.length} assistants answered independently:`,
          ...good.map((a, i) => `--- Answer ${i + 1} (${a.providerId}) ---\n${a.text}`),
          '---',
          'Write the single best final answer for the user. Combine the strongest points, fix mistakes, and resolve disagreements (mention a disagreement only if it matters). Do not refer to "the answers" or the assistants.'
        ].join('\n\n')
      }
    ]
    input.emit({ type: 'status', message: 'Merging the answers…' })
    const attempts: RouteAttempt[] = []
    let text = ''
    const media: { mime: string; name?: string; base64: string }[] = []
    for await (const ev of this.deps.router.chat(judgePrompt, { target: good[0].providerId, signal: input.signal, ...this.routeFlags(input) })) {
      this.track(ev, input, meta, attempts)
      if (ev.type === 'route') {
        text = ''
        media.length = 0
      }
      if (ev.type === 'text') text = applyTextDelta(text, ev)
      if (ev.type === 'media') media.push({ mime: ev.mime, name: ev.name, base64: ev.base64 })
    }
    meta.attempts = attempts
    return { text, meta, media: [...media] }
  }
}
