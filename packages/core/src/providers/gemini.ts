import {
  ProviderError,
  errorKindFromStatus,
  type ChatMessage,
  type ChatOptions,
  type Delta,
  type JsonSchema,
  type ModelInfo,
  type Provider,
  type ProviderStatus
} from '../types'
import { readSse } from '../util'
import { inferTags } from './tags'

const BASE = 'https://generativelanguage.googleapis.com/v1beta'
const FALLBACK_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro']

interface GeminiPart {
  text?: string
  thought?: boolean
  functionCall?: { name: string; args?: Record<string, unknown>; id?: string }
  functionResponse?: { name: string; response: Record<string, unknown> }
}

interface GeminiContent {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

/** Converts OpenAI-style messages to Gemini `contents` plus a system instruction. */
export function toGeminiRequest(messages: ChatMessage[]): { systemInstruction?: { parts: GeminiPart[] }; contents: GeminiContent[] } {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
  const contents: GeminiContent[] = []
  const toolNames = new Map<string, string>()
  const push = (role: GeminiContent['role'], part: GeminiPart): void => {
    const last = contents[contents.length - 1]
    if (last && last.role === role) last.parts.push(part)
    else contents.push({ role, parts: [part] })
  }
  for (const m of messages) {
    if (m.role === 'system') continue
    if (m.role === 'user') push('user', { text: m.content })
    else if (m.role === 'assistant') {
      if (m.content) push('model', { text: m.content })
      for (const c of m.toolCalls ?? []) {
        toolNames.set(c.id, c.name)
        let args: Record<string, unknown> = {}
        try {
          args = JSON.parse(c.arguments || '{}')
        } catch {
          args = { raw: c.arguments }
        }
        push('model', { functionCall: { name: c.name, args } })
      }
    } else if (m.role === 'tool') {
      const name = m.name ?? toolNames.get(m.toolCallId ?? '') ?? 'tool'
      push('user', { functionResponse: { name, response: { content: m.content } } })
    }
  }
  return { ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}), contents }
}

/** Gemini accepts a subset of OpenAPI schema; strip keys it rejects. */
export function cleanSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(cleanSchema)
  if (!schema || typeof schema !== 'object') return schema
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (['$schema', 'additionalProperties', 'default', '$ref', 'examples', 'exclusiveMinimum', 'exclusiveMaximum'].includes(k)) continue
    out[k] = cleanSchema(v)
  }
  return out
}

export class GeminiProvider implements Provider {
  readonly id = 'gemini-api'
  readonly name = 'Gemini API'
  readonly kind = 'api' as const
  readonly description = 'Google AI Studio API with a free tier. Native Gemini adapter with tool calling.'
  readonly supportsTools = true
  readonly tags = inferTags('gemini-flash')
  private modelCache?: { at: number; models: ModelInfo[] }

  constructor(
    private readonly apiKey: () => string | undefined,
    private readonly configuredModel: () => string | undefined
  ) {}

  async status(): Promise<ProviderStatus> {
    return this.apiKey() ? { state: 'ready' } : { state: 'needs_setup', message: 'Add a Google AI Studio API key in Customize.' }
  }

  async models(): Promise<ModelInfo[]> {
    if (this.modelCache && Date.now() - this.modelCache.at < 60 * 60 * 1000) return this.modelCache.models
    const fallback = FALLBACK_MODELS.map((m) => ({ id: m, name: m, tags: inferTags(m) }))
    const key = this.apiKey()
    if (!key) return fallback
    try {
      const res = await fetch(`${BASE}/models?pageSize=200`, { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(10_000) })
      if (!res.ok) return fallback
      const body = (await res.json()) as { models?: { name: string; displayName?: string; inputTokenLimit?: number; supportedGenerationMethods?: string[] }[] }
      const models = (body.models ?? [])
        .filter((m) => m.supportedGenerationMethods?.includes('generateContent') && /gemini/.test(m.name) && !/embedding|tts|image|live|audio/.test(m.name))
        .map((m) => {
          const modelId = m.name.replace(/^models\//, '')
          return { id: modelId, name: m.displayName ?? modelId, contextLength: m.inputTokenLimit, tags: inferTags(modelId, { contextLength: m.inputTokenLimit }) }
        })
      this.modelCache = { at: Date.now(), models: models.length ? models : fallback }
      return this.modelCache.models
    } catch {
      return fallback
    }
  }

  async defaultModel(): Promise<string | undefined> {
    return this.configuredModel() || FALLBACK_MODELS[0]
  }

  async *chat(messages: ChatMessage[], opts: ChatOptions): AsyncIterable<Delta> {
    const key = this.apiKey()
    if (!key) throw new ProviderError(this.id, 'auth', 'Gemini API key is missing')
    const model = opts.model || (await this.defaultModel())
    const body: Record<string, unknown> = { ...toGeminiRequest(messages) }
    const generationConfig: Record<string, unknown> = {}
    if (opts.temperature !== undefined) generationConfig.temperature = opts.temperature
    if (opts.maxTokens) generationConfig.maxOutputTokens = opts.maxTokens
    if (Object.keys(generationConfig).length) body.generationConfig = generationConfig
    if (opts.tools?.length) {
      body.tools = [
        {
          functionDeclarations: opts.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: cleanSchema(t.parameters) as JsonSchema
          }))
        }
      ]
    }

    let res: Response
    try {
      res = await fetch(`${BASE}/models/${model}:streamGenerateContent?alt=sse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body),
        signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000)
      })
    } catch (err) {
      if (opts.signal?.aborted) throw new ProviderError(this.id, 'aborted', 'Request was cancelled')
      throw new ProviderError(this.id, 'server', `Network error: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '')
      let msg = text.slice(0, 300)
      try {
        msg = JSON.parse(text).error?.message ?? msg
      } catch {
        // keep raw text
      }
      throw new ProviderError(this.id, errorKindFromStatus(res.status), `Gemini returned ${res.status}: ${msg}`, res.status)
    }

    let n = 0
    for await (const ev of readSse(res.body, opts.signal)) {
      let chunk: {
        candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[]
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
        error?: { message?: string; code?: number }
      }
      try {
        chunk = JSON.parse(ev.data)
      } catch {
        continue
      }
      if (chunk.error) throw new ProviderError(this.id, errorKindFromStatus(chunk.error.code ?? 500), chunk.error.message ?? 'Gemini stream error')
      for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
        if (part.text && !part.thought) yield { type: 'text', text: part.text }
        if (part.functionCall) {
          yield {
            type: 'tool_call',
            call: { id: part.functionCall.id ?? `call_${Date.now()}_${n++}`, name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args ?? {}) }
          }
        }
      }
      if (chunk.usageMetadata) {
        yield { type: 'usage', inputTokens: chunk.usageMetadata.promptTokenCount, outputTokens: chunk.usageMetadata.candidatesTokenCount }
      }
    }
  }
}
