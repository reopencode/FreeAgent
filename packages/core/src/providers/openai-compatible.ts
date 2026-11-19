import {
  ProviderError,
  errorKindFromStatus,
  type CapabilityTag,
  type ChatMessage,
  type ChatOptions,
  type Delta,
  type ModelInfo,
  type Provider,
  type ProviderStatus,
  type ToolCall
} from '../types'
import { readSse } from '../util'
import { inferTags } from './tags'

/**
 * Cleans up a pasted base URL: requires http(s), drops query, hash, trailing slashes and a trailing
 * `/chat/completions`. A `/v1` suffix is never added. Throws an Error with a user-facing message.
 */
export function normalizeBaseUrl(input: string): string {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    throw new Error('Base URL must be a valid URL such as https://api.example.com/v1')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Base URL must start with http:// or https://')
  const path = url.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/, '')
  return url.origin + path
}

export interface OpenAICompatibleConfig {
  id: string
  name: string | (() => string)
  description: string
  /** An empty string means the provider is not configured yet. */
  baseUrl: () => string
  apiKey: () => string | undefined
  /** Providers like Kilo serve free models without a key. */
  keyOptional?: boolean
  /** Status message shown when no key is set and `keyOptional` is true. */
  noKeyMessage?: string
  headers?: () => Record<string, string>
  defaultModel: () => string | undefined
  fallbackModels: string[] | (() => string[])
  /** Restricts the model list, e.g. to `:free` models. */
  filterModel?: (m: { id: string; pricing?: { prompt?: string; completion?: string } }, hasKey: boolean) => boolean
  tags?: CapabilityTag[]
}

interface OpenAIContentPart {
  type?: string
  text?: string
  image_url?: { url?: string }
  input_audio?: { data?: string }
  b64_json?: string
}

interface OpenAIStreamChunk {
  choices?: {
    delta?: {
      content?: string | null | OpenAIContentPart[]
      reasoning?: string | null
      images?: { image_url?: { url?: string }; b64_json?: string }[]
      audio?: { data?: string }
      tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[]
    }
    finish_reason?: string | null
  }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number }
  error?: { message?: string; code?: number | string }
}

function audioFormat(mime: string, name: string): string {
  const s = `${mime} ${name}`.toLowerCase()
  if (s.includes('wav')) return 'wav'
  if (s.includes('mpeg') || s.includes('mp3')) return 'mp3'
  if (s.includes('webm')) return 'webm'
  if (s.includes('ogg')) return 'ogg'
  if (s.includes('mp4') || s.includes('m4a')) return 'mp4'
  return 'wav'
}

function dataUrl(url: string): { mime: string; base64: string } | undefined {
  const m = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(url.trim())
  if (!m) return undefined
  return { mime: m[1], base64: m[2].replace(/\s/g, '') }
}

/** Pulls image and audio payloads out of one streaming delta. Text stays on `delta.content`. */
export function mediaFromOpenAIDelta(delta: NonNullable<NonNullable<OpenAIStreamChunk['choices']>[number]['delta']> | undefined): { mime: string; base64: string }[] {
  if (!delta) return []
  const out: { mime: string; base64: string }[] = []
  const take = (url?: string, b64?: string, mime = 'image/png'): void => {
    if (b64) out.push({ mime, base64: b64 })
    else if (url) {
      const parsed = dataUrl(url)
      if (parsed) out.push(parsed)
    }
  }
  for (const image of delta.images ?? []) take(image.image_url?.url, image.b64_json)
  if (delta.audio?.data) out.push({ mime: 'audio/mpeg', base64: delta.audio.data })
  if (Array.isArray(delta.content)) {
    for (const part of delta.content) {
      if (part.image_url?.url || part.b64_json) take(part.image_url?.url, part.b64_json)
      else if (part.input_audio?.data) out.push({ mime: 'audio/wav', base64: part.input_audio.data })
    }
  }
  return out
}

function openAIContent(m: ChatMessage): unknown {
  const parts: unknown[] = []
  if (m.content) parts.push({ type: 'text', text: m.content })
  for (const a of m.attachments ?? []) {
    if (a.kind === 'image') {
      const url = a.url ?? (a.dataBase64 ? `data:${a.mime || 'image/png'};base64,${a.dataBase64}` : undefined)
      if (url) parts.push({ type: 'image_url', image_url: { url } })
    } else if (a.kind === 'audio' && a.dataBase64) {
      parts.push({ type: 'input_audio', input_audio: { data: a.dataBase64, format: audioFormat(a.mime, a.name) } })
    }
  }
  if (!parts.length) return m.content
  if (parts.length === 1 && m.content && !(m.attachments?.length)) return m.content
  return parts
}

export function toOpenAIMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments || '{}' } }))
      }
    }
    return { role: m.role, content: openAIContent(m) }
  })
}

export class OpenAICompatibleProvider implements Provider {
  readonly kind = 'api' as const
  readonly supportsTools = true
  readonly id: string
  readonly description: string
  readonly tags: CapabilityTag[]
  private modelCache?: { at: number; baseUrl: string; models: ModelInfo[] }

  constructor(private readonly cfg: OpenAICompatibleConfig) {
    this.id = cfg.id
    this.description = cfg.description
    this.tags = cfg.tags ?? ['general']
  }

  get name(): string {
    return typeof this.cfg.name === 'function' ? this.cfg.name() : this.cfg.name
  }

  private fallbackModels(): string[] {
    return typeof this.cfg.fallbackModels === 'function' ? this.cfg.fallbackModels() : this.cfg.fallbackModels
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json', ...(this.cfg.headers?.() ?? {}) }
    const key = this.cfg.apiKey()
    if (key) h.Authorization = `Bearer ${key}`
    return h
  }

  async status(): Promise<ProviderStatus> {
    if (!this.cfg.baseUrl()) return { state: 'needs_setup', message: 'Enter a valid http(s) base URL in Customize.' }
    if (!this.cfg.apiKey() && !this.cfg.keyOptional) return { state: 'needs_setup', message: 'Add an API key in Customize.' }
    if (!this.cfg.apiKey()) return { state: 'ready', message: this.cfg.noKeyMessage ?? 'Using free models without a key (rate limited).' }
    return { state: 'ready' }
  }

  async models(): Promise<ModelInfo[]> {
    const baseUrl = this.cfg.baseUrl()
    const fallbackIds = this.fallbackModels()
    const fallback = fallbackIds.map((m) => ({ id: m, name: m, tags: inferTags(m) }))
    if (!baseUrl) return fallback
    if (this.modelCache && this.modelCache.baseUrl === baseUrl && Date.now() - this.modelCache.at < 60 * 60 * 1000) return this.modelCache.models
    try {
      const res = await fetch(`${baseUrl}/models`, { headers: this.headers(), signal: AbortSignal.timeout(10_000) })
      if (!res.ok) return fallback
      const body = (await res.json()) as {
        data?: {
          id: string
          name?: string
          context_length?: number
          pricing?: { prompt?: string; completion?: string }
          architecture?: { input_modalities?: string[]; output_modalities?: string[] }
        }[]
      }
      const hasKey = !!this.cfg.apiKey()
      const preferred = new Set(fallbackIds)
      const list = (body.data ?? [])
        .filter((m) => (this.cfg.filterModel ? this.cfg.filterModel(m, hasKey) : true))
        .filter((m) => !m.architecture?.output_modalities || m.architecture.output_modalities.includes('text'))
        .sort((a, b) => Number(preferred.has(b.id)) - Number(preferred.has(a.id)))
        .map((m) => ({
          id: m.id,
          name: m.name ?? m.id,
          contextLength: m.context_length,
          tags: inferTags(m.id, { contextLength: m.context_length, vision: m.architecture?.input_modalities?.includes('image') })
        }))
      const models = list.length ? list : fallback
      this.modelCache = { at: Date.now(), baseUrl, models }
      return models
    } catch {
      return fallback
    }
  }

  async defaultModel(): Promise<string | undefined> {
    const configured = this.cfg.defaultModel() || this.fallbackModels()[0]
    if (configured) return configured
    // Nothing configured: take the first model the endpoint lists.
    return (await this.models())[0]?.id
  }

  private async post(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    try {
      return await fetch(`${this.cfg.baseUrl()}/chat/completions`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000)
      })
    } catch (err) {
      if (signal?.aborted) throw new ProviderError(this.id, 'aborted', 'Request was cancelled')
      const msg = err instanceof Error ? err.message : String(err)
      throw new ProviderError(this.id, /timeout/i.test(msg) ? 'timeout' : 'server', `Network error: ${msg}`)
    }
  }

  async *chat(messages: ChatMessage[], opts: ChatOptions): AsyncIterable<Delta> {
    const model = opts.model || (await this.defaultModel())
    if (!model) throw new ProviderError(this.id, 'bad_request', 'No model selected')
    const body: Record<string, unknown> = {
      model,
      messages: toOpenAIMessages(messages),
      stream: true,
      stream_options: { include_usage: true }
    }
    if (opts.temperature !== undefined) body.temperature = opts.temperature
    if (opts.maxTokens) body.max_tokens = opts.maxTokens
    if (opts.tools?.length) {
      body.tools = opts.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
    }

    let res = await this.post(body, opts.signal)
    if (res.status === 400) {
      // Some OpenAI clones reject `stream_options`; try once more without it.
      await res.body?.cancel().catch(() => undefined)
      delete body.stream_options
      res = await this.post(body, opts.signal)
    }
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '')
      throw new ProviderError(this.id, errorKindFromStatus(res.status), `${this.name} returned ${res.status}: ${extractError(text)}`, res.status)
    }

    const pending = new Map<number, ToolCall>()
    for await (const ev of readSse(res.body, opts.signal)) {
      if (ev.data === '[DONE]') break
      let chunk: OpenAIStreamChunk
      try {
        chunk = JSON.parse(ev.data)
      } catch {
        continue
      }
      if (chunk.error) {
        const code = Number(chunk.error.code)
        throw new ProviderError(this.id, Number.isFinite(code) ? errorKindFromStatus(code) : 'server', chunk.error.message ?? 'Stream error', code || undefined)
      }
      const choice = chunk.choices?.[0]
      const delta = choice?.delta
      if (typeof delta?.content === 'string' && delta.content) yield { type: 'text', text: delta.content }
      else if (Array.isArray(delta?.content)) {
        for (const part of delta.content) if (part.text) yield { type: 'text', text: part.text }
      }
      for (const media of mediaFromOpenAIDelta(delta)) yield { type: 'media', ...media }
      for (const tc of delta?.tool_calls ?? []) {
        const cur = pending.get(tc.index) ?? { id: tc.id ?? `call_${tc.index}_${Date.now()}`, name: '', arguments: '' }
        if (tc.id) cur.id = tc.id
        if (tc.function?.name) cur.name += tc.function.name
        if (tc.function?.arguments) cur.arguments += tc.function.arguments
        pending.set(tc.index, cur)
      }
      if (chunk.usage) yield { type: 'usage', inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens }
    }
    for (const call of [...pending.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1])) {
      if (call.name) yield { type: 'tool_call', call }
    }
  }
}

function extractError(text: string): string {
  try {
    const j = JSON.parse(text)
    return j.error?.message ?? j.message ?? text.slice(0, 300)
  } catch {
    return text.slice(0, 300) || 'no details'
  }
}
