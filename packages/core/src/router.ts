import type { ProviderRegistry } from './providers/registry'
import type { Store } from './store'
import { applyTextDelta } from './util'
import { ProviderError, type CapabilityTag, type ChatMessage, type Delta, type Provider, type ToolSpec } from './types'

export type RouterEvent =
  | Delta
  | { type: 'route'; providerId: string; model?: string; attempt: number }
  | { type: 'fallback'; providerId: string; model?: string; error: string }

export interface RouteRequest {
  /** `auto`, `auto-code`, `auto-fast`, `auto-long`, a provider id, or `providerId::model`. */
  target: string
  tools?: ToolSpec[]
  signal?: AbortSignal
  cwd?: string
  temperature?: number
  maxTokens?: number
  /** Provider ids to leave out, e.g. ones already used in council mode. */
  exclude?: string[]
  /** Identifies one agent run so providers can keep a conversation open across steps. */
  sessionId?: string
}

export interface ParsedTarget {
  providerId?: string
  model?: string
  tag?: CapabilityTag
}

const AUTO_TAGS: Record<string, CapabilityTag | undefined> = {
  auto: undefined,
  'auto-code': 'code',
  'auto-fast': 'fast',
  'auto-long': 'long-context',
  'auto-vision': 'vision',
  'auto-reasoning': 'reasoning'
}

export const AUTO_TARGETS = Object.keys(AUTO_TAGS)

export function parseTarget(target: string | undefined): ParsedTarget {
  const t = (target ?? 'auto').trim() || 'auto'
  if (t in AUTO_TAGS) return { tag: AUTO_TAGS[t] }
  const idx = t.indexOf('::')
  if (idx === -1) return { providerId: t }
  return { providerId: t.slice(0, idx), model: t.slice(idx + 2) || undefined }
}

const COOLDOWN_MS: Partial<Record<ProviderError['kind'], number>> = {
  rate_limit: 60_000,
  server: 20_000,
  timeout: 30_000,
  auth: 10 * 60_000,
  captcha: 10 * 60_000,
  not_logged_in: 10 * 60_000,
  unavailable: 5 * 60_000
}

export class NoProviderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NoProviderError'
  }
}

interface Candidate {
  provider: Provider
  model?: string
}

export class Router {
  private cooling = new Map<string, { until: number; reason: string }>()

  constructor(
    readonly registry: ProviderRegistry,
    private readonly store: Store
  ) {}

  coolingDown(providerId: string): string | undefined {
    const c = this.cooling.get(providerId)
    if (!c) return undefined
    if (Date.now() > c.until) {
      this.cooling.delete(providerId)
      return undefined
    }
    return c.reason
  }

  private overLimit(providerId: string): boolean {
    const limit = this.registry.dailyLimit(providerId)
    return limit !== null && this.store.usageToday(providerId).requests >= limit
  }

  private async pickModel(p: Provider, tag?: CapabilityTag, explicit?: string): Promise<string | undefined> {
    if (explicit) return explicit
    const configured = this.store.getProviderSettings(p.id)?.config.model
    if (typeof configured === 'string' && configured.trim()) return configured.trim()
    if (tag && p.kind === 'api') {
      const models = await p.models().catch(() => [])
      const match = models.find((m) => m.tags.includes(tag))
      if (match) return match.id
    }
    return p.defaultModel()
  }

  /** Ordered list of providers to try for a request. */
  async candidates(req: RouteRequest): Promise<Candidate[]> {
    const parsed = parseTarget(req.target)
    const out: Candidate[] = []
    const exclude = new Set(req.exclude ?? [])
    if (parsed.providerId) {
      const p = this.registry.get(parsed.providerId)
      if (!p) throw new NoProviderError(`Unknown provider "${parsed.providerId}"`)
      out.push({ provider: p, model: await this.pickModel(p, undefined, parsed.model) })
      exclude.add(p.id)
      const fallback = this.store.getSettings().fallbackOnExplicit && p.kind !== 'app'
      if (!fallback) return out
    }

    const needTools = !!req.tools?.length
    const scored: { p: Provider; score: number }[] = []
    const all = this.registry.list().filter((p) => p.kind !== 'app' && !exclude.has(p.id) && this.registry.enabled(p.id))
    const statuses = await Promise.all(all.map((p) => p.status().catch(() => ({ state: 'error' as const }))))
    const ready = all.filter((_, i) => statuses[i].state === 'ready')
    // The offline demo only stands in when nothing real is set up, never as a silent fallback.
    const anyReal = ready.some((p) => p.id !== 'mock')
    for (const p of ready) {
      if ((anyReal && p.id === 'mock') || this.coolingDown(p.id)) continue
      let score = this.registry.priority(p.id)
      if (parsed.tag && p.tags.includes(parsed.tag)) score -= 15
      if (needTools && !p.supportsTools) score += 25
      if (this.overLimit(p.id)) score += 10_000
      scored.push({ p, score })
    }
    scored.sort((a, b) => a.score - b.score)
    for (const { p } of scored) {
      const model = await this.pickModel(p, parsed.tag)
      const fallbackModel = await p.defaultModel()
      if (model && !this.coolingDown(`${p.id}::${model}`)) out.push({ provider: p, model })
      if (fallbackModel && fallbackModel !== model && !this.coolingDown(`${p.id}::${fallbackModel}`)) out.push({ provider: p, model: fallbackModel })
    }
    return out
  }

  /** Why each enabled provider is currently skipped, for error messages. */
  skipped(): string[] {
    return [...this.cooling.entries()].filter(([, c]) => Date.now() < c.until).map(([k, c]) => `${k}: ${c.reason}`)
  }

  private cool(providerId: string, model: string | undefined, err: ProviderError, isDefault: boolean): void {
    const ms = COOLDOWN_MS[err.kind]
    if (!ms) return
    // A rate limit on one model of a multi-model API should not bench the whole provider.
    const modelScoped = !isDefault && model && (err.kind === 'rate_limit' || err.kind === 'unavailable' || err.kind === 'server')
    this.cooling.set(modelScoped ? `${providerId}::${model}` : providerId, { until: Date.now() + ms, reason: err.message })
  }

  async *chat(messages: ChatMessage[], req: RouteRequest): AsyncIterable<RouterEvent> {
    const list = await this.candidates(req)
    if (!list.length) {
      const skipped = this.skipped()
      throw new NoProviderError(
        skipped.length
          ? `Every ready provider is cooling down after errors. Try again shortly. ${skipped.join(' · ')}`
          : 'No provider is ready. Add a key or connect a provider in Customize → Providers.'
      )
    }
    let lastError: unknown
    for (let attempt = 0; attempt < list.length; attempt++) {
      const { provider, model } = list[attempt]
      if (attempt > 0 && this.coolingDown(provider.id)) continue
      yield { type: 'route', providerId: provider.id, model, attempt }
      let produced = false
      let usage = { inputTokens: 0, outputTokens: 0 }
      try {
        for await (const d of provider.chat(messages, {
          model,
          tools: req.tools,
          signal: req.signal,
          cwd: req.cwd,
          sessionId: req.sessionId,
          temperature: req.temperature,
          maxTokens: req.maxTokens
        })) {
          if (d.type === 'usage') {
            usage = { inputTokens: d.inputTokens ?? usage.inputTokens, outputTokens: d.outputTokens ?? usage.outputTokens }
            continue
          }
          if (d.type === 'text' || d.type === 'tool_call') produced = true
          yield d
        }
        this.store.recordUsage(provider.id, { ok: true, ...usage })
        return
      } catch (err) {
        const perr = err instanceof ProviderError ? err : new ProviderError(provider.id, 'server', err instanceof Error ? err.message : String(err))
        if (perr.kind === 'aborted' || req.signal?.aborted) throw perr
        this.store.recordUsage(provider.id, { ok: false })
        this.cool(provider.id, model, perr, model === (await provider.defaultModel()))
        lastError = perr
        if (produced || !perr.retryable || attempt === list.length - 1) throw perr
        yield { type: 'fallback', providerId: provider.id, model, error: perr.message }
      }
    }
    throw lastError ?? new NoProviderError('All providers failed')
  }

  /** Calls exactly one provider with no fallback. Used by council mode. */
  async direct(provider: Provider, model: string | undefined, messages: ChatMessage[], req: Omit<RouteRequest, 'target'>): Promise<string> {
    let text = ''
    let usage = { inputTokens: 0, outputTokens: 0 }
    try {
      for await (const d of provider.chat(messages, { model, signal: req.signal, cwd: req.cwd, maxTokens: req.maxTokens })) {
        if (d.type === 'text') text = applyTextDelta(text, d)
        if (d.type === 'usage') usage = { inputTokens: d.inputTokens ?? 0, outputTokens: d.outputTokens ?? 0 }
      }
      this.store.recordUsage(provider.id, { ok: true, ...usage })
      return text
    } catch (err) {
      this.store.recordUsage(provider.id, { ok: false })
      if (err instanceof ProviderError) this.cool(provider.id, model, err, model === (await provider.defaultModel()))
      throw err
    }
  }

  /** Runs a request to completion and returns the text, tool calls and the provider that answered. */
  async complete(messages: ChatMessage[], req: RouteRequest): Promise<{ text: string; toolCalls: import('./types').ToolCall[]; providerId?: string; model?: string }> {
    let text = ''
    const toolCalls: import('./types').ToolCall[] = []
    let providerId: string | undefined
    let model: string | undefined
    for await (const ev of this.chat(messages, req)) {
      if (ev.type === 'route') {
        providerId = ev.providerId
        model = ev.model
        text = ''
      } else if (ev.type === 'text') text = applyTextDelta(text, ev)
      else if (ev.type === 'tool_call') toolCalls.push(ev.call)
    }
    return { text, toolCalls, providerId, model }
  }
}
