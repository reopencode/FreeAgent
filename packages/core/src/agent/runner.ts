import type { AgentEvent, ChatMode, CouncilAnswer, MessageMeta, RouteAttempt, ToolStep } from '../api-types'
import type { ProviderRegistry } from '../providers/registry'
import { Router, type RouterEvent } from '../router'
import type { Store } from '../store'
import type { ChatMessage, ToolCall } from '../types'
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
}

export interface RunResult {
  text: string
  meta: MessageMeta
}

export interface RunnerDeps {
  router: Router
  registry: ProviderRegistry
  store: Store
  approvals: Approvals
  mcp?: McpManager
}

const TOOL_RESULT_LIMIT = 12_000

export class AgentRunner {
  constructor(private readonly deps: RunnerDeps) {}

  async tools(): Promise<AgentTool[]> {
    const mcpTools = (await this.deps.mcp?.tools().catch(() => [])) ?? []
    return [...BUILTIN_TOOLS, ...mcpTools]
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
    else if (ev.type === 'status') input.emit({ type: 'status', message: ev.message })
  }

  private async chat(input: RunInput): Promise<RunResult> {
    const meta: MessageMeta = {}
    const attempts: RouteAttempt[] = []
    let text = ''
    // A saved chat keeps one website conversation open across turns, so its id is the session id.
    // The session ends when the chat is deleted (see DELETE /api/chats/:id), not when this turn finishes.
    for await (const ev of this.deps.router.chat(input.messages, { target: input.target, signal: input.signal, cwd: input.cwd, sessionId: input.chatId })) {
      this.track(ev, input, meta, attempts)
      if (ev.type === 'route') text = ''
      if (ev.type === 'text') text = applyTextDelta(text, ev)
    }
    meta.attempts = attempts
    return { text, meta }
  }

  private async agent(input: RunInput): Promise<RunResult> {
    const meta: MessageMeta = { steps: [] }
    const attempts: RouteAttempt[] = []
    const tools = await this.tools()
    const byName = new Map(tools.map((t) => [t.spec.name, t]))
    const specs = tools.map((t) => t.spec)
    const convo = [...input.messages]
    const maxSteps = input.maxSteps ?? 12
    let target = input.target
    let finalText = ''
    // One id for the whole run lets web providers keep a single site conversation open across steps.
    // A saved chat uses its own id, so its agent turns continue that conversation; the chat's deletion ends it.
    const sessionId = input.chatId ?? id('run_')

    try {
      for (let step = 0; step < maxSteps; step++) {
        input.emit({ type: 'step_start', step })
        let text = ''
        const calls: ToolCall[] = []
        for await (const ev of this.deps.router.chat(convo, { target, tools: specs, signal: input.signal, cwd: input.cwd, sessionId })) {
          this.track(ev, input, meta, attempts)
          if (ev.type === 'route') text = ''
          if (ev.type === 'text') text = applyTextDelta(text, ev)
          if (ev.type === 'tool_call') calls.push(ev.call)
        }
        // Keep the rest of the run on the provider that answered so tool context stays consistent.
        if (meta.providerId && step === 0 && this.deps.registry.get(meta.providerId)?.kind !== 'app') {
          target = meta.model ? `${meta.providerId}::${meta.model}` : meta.providerId
        }
        if (text) finalText += (finalText ? '\n\n' : '') + text
        if (!calls.length) break

        convo.push({ role: 'assistant', content: text, toolCalls: calls })
        for (const call of calls) {
          const out = await this.runTool(call, byName.get(call.name), input, meta.steps!)
          convo.push({ role: 'tool', content: out, toolCallId: call.id, name: call.name })
        }
        if (step === maxSteps - 1) {
          const note = `Stopped after ${maxSteps} steps. Ask me to continue if needed.`
          input.emit({ type: 'text', text: `\n\n_${note}_` })
          finalText += `\n\n_${note}_`
        }
      }
    } finally {
      if (!input.chatId) await this.deps.registry.endSession(sessionId)
    }
    meta.attempts = attempts
    return { text: finalText, meta }
  }

  private async runTool(call: ToolCall, tool: AgentTool | undefined, input: RunInput, steps: ToolStep[]): Promise<string> {
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
      const output = await tool.run(args, { cwd: input.cwd, signal: input.signal, registry: this.deps.registry })
      return finish(true, output, 'done')
    } catch (err) {
      return finish(false, `Error: ${err instanceof Error ? err.message : String(err)}`, 'error')
    }
  }

  private async council(input: RunInput): Promise<RunResult> {
    const meta: MessageMeta = { council: [] }
    const size = Math.max(2, Math.min(input.councilSize ?? 3, 5))
    const parsed = input.target.startsWith('auto') ? input.target : 'auto'
    const candidates = (await this.deps.router.candidates({ target: parsed })).slice(0, size)
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
      return { text: good[0].text, meta }
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
    for await (const ev of this.deps.router.chat(judgePrompt, { target: good[0].providerId, signal: input.signal })) {
      this.track(ev, input, meta, attempts)
      if (ev.type === 'route') text = ''
      if (ev.type === 'text') text = applyTextDelta(text, ev)
    }
    meta.attempts = attempts
    return { text, meta }
  }
}
