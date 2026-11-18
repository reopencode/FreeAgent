import { useSyncExternalStore } from 'react'
import type { AgentEvent, ChatMode, CouncilAnswer, RouteAttempt, ToolStep } from '@core/api-types'
import { api, streamMessage } from './api'
import { keys, queryClient } from './queries'

export interface LiveReply {
  chatId: string
  userText: string
  userMessageId?: string
  content: string
  /** Length of `content` when the current agent step began; a replacing text event only swaps what follows. */
  stepBase?: number
  status?: string
  providerId?: string
  model?: string
  attempts: RouteAttempt[]
  steps: ToolStep[]
  council: CouncilAnswer[]
  /** toolCallId → approval id while waiting for the user. */
  approvals: Record<string, string>
  error?: string
  startedAt: number
}

const live = new Map<string, LiveReply>()
const controllers = new Map<string, AbortController>()
const listeners = new Set<() => void>()
let version = 0

function emit(): void {
  version++
  for (const l of listeners) l()
}

function update(chatId: string, fn: (r: LiveReply) => LiveReply): void {
  const cur = live.get(chatId)
  if (!cur) return
  live.set(chatId, fn(cur))
  emit()
}

function apply(r: LiveReply, ev: AgentEvent): LiveReply {
  switch (ev.type) {
    case 'user_message':
      return { ...r, userMessageId: ev.message.id }
    case 'route':
      return { ...r, providerId: ev.providerId, model: ev.model, attempts: [...r.attempts, { providerId: ev.providerId, model: ev.model }], status: undefined }
    case 'fallback': {
      const attempts = r.attempts.slice()
      const last = attempts[attempts.length - 1]
      if (last) attempts[attempts.length - 1] = { ...last, error: ev.error }
      // Nothing was shown from the failed provider, so its partial text (if any) is dropped.
      return { ...r, attempts, content: r.steps.length ? r.content : '', stepBase: r.steps.length ? r.stepBase : 0, status: `Switching from ${ev.providerId}…` }
    }
    case 'text':
      return { ...r, content: ev.replace ? r.content.slice(0, r.stepBase ?? 0) + ev.text : r.content + ev.text, status: undefined }
    case 'status':
      return { ...r, status: ev.message }
    case 'step_start': {
      const content = ev.step > 0 && r.content && !r.content.endsWith('\n\n') ? r.content + '\n\n' : r.content
      return { ...r, content, stepBase: content.length }
    }
    case 'tool_call':
      return { ...r, steps: [...r.steps, { id: ev.id, name: ev.name, args: ev.args, status: 'running' }], status: undefined }
    case 'approval_request':
      return {
        ...r,
        approvals: { ...r.approvals, [ev.toolCallId]: ev.id },
        steps: r.steps.map((s) => (s.id === ev.toolCallId ? { ...s, status: 'pending_approval' } : s))
      }
    case 'approval_resolved': {
      const toolCallId = Object.keys(r.approvals).find((k) => r.approvals[k] === ev.id)
      const approvals = { ...r.approvals }
      if (toolCallId) delete approvals[toolCallId]
      return {
        ...r,
        approvals,
        steps: r.steps.map((s) => (s.id === toolCallId ? { ...s, status: ev.approved ? 'running' : 'denied' } : s))
      }
    }
    case 'tool_result':
      return {
        ...r,
        steps: r.steps.map((s) => (s.id === ev.id ? { ...s, ok: ev.ok, output: ev.output, status: s.status === 'denied' ? 'denied' : ev.ok ? 'done' : 'error' } : s))
      }
    case 'council_answer':
      return { ...r, council: [...r.council, ev.answer] }
    case 'error':
      return { ...r, error: ev.message, status: undefined }
    default:
      return r
  }
}

async function finish(chatId: string): Promise<void> {
  controllers.delete(chatId)
  await Promise.all([queryClient.invalidateQueries({ queryKey: keys.chat(chatId) }), queryClient.invalidateQueries({ queryKey: keys.chats })])
  void queryClient.invalidateQueries({ queryKey: keys.providers })
  live.delete(chatId)
  emit()
}

export function startReply(chatId: string, body: { content: string; mode: ChatMode; target: string }): void {
  if (controllers.has(chatId)) return
  const controller = new AbortController()
  controllers.set(chatId, controller)
  live.set(chatId, { chatId, userText: body.content, content: '', attempts: [], steps: [], council: [], approvals: {}, startedAt: Date.now() })
  emit()
  streamMessage(chatId, body, (ev) => update(chatId, (r) => apply(r, ev)), controller.signal)
    .catch((err: unknown) => {
      if (controller.signal.aborted) return
      update(chatId, (r) => ({ ...r, error: err instanceof Error ? err.message : String(err) }))
    })
    .finally(() => void finish(chatId))
}

/** Asks the server to stop so it can still save the partial reply; drops the stream if it does not end soon. */
export function stopReply(chatId: string): void {
  const controller = controllers.get(chatId)
  if (!controller) return
  void api.post(`/api/chats/${chatId}/abort`).catch(() => controller.abort())
  setTimeout(() => {
    if (controllers.get(chatId) === controller) controller.abort()
  }, 4000)
}

export function isStreaming(chatId: string | undefined): boolean {
  return !!chatId && live.has(chatId)
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function useLiveReply(chatId: string | undefined): LiveReply | undefined {
  useSyncExternalStore(subscribe, () => version)
  return chatId ? live.get(chatId) : undefined
}
