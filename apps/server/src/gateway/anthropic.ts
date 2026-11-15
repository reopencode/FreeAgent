import type { ChatMessage, ToolCall, ToolSpec } from '@freeagent/core'

type Block =
  | { type: 'text'; text: string }
  | { type: 'image'; source?: unknown }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content?: string | { type: string; text?: string }[]; is_error?: boolean }
  | { type: 'thinking' | 'redacted_thinking'; thinking?: string }
  | { type: 'document'; source?: unknown }

export interface AnthropicRequest {
  model?: string
  system?: string | { type: 'text'; text: string }[]
  messages: { role: 'user' | 'assistant'; content: string | Block[] }[]
  tools?: { name: string; description?: string; input_schema?: Record<string, unknown>; type?: string }[]
  max_tokens?: number
  temperature?: number
  stream?: boolean
}

function blockText(c: string | { type: string; text?: string }[] | undefined): string {
  if (!c) return ''
  if (typeof c === 'string') return c
  return c.map((b) => (b.type === 'text' ? (b.text ?? '') : `[${b.type} omitted]`)).join('\n')
}

/** Converts an Anthropic Messages request to the internal OpenAI-style conversation. */
export function fromAnthropic(req: AnthropicRequest): { messages: ChatMessage[]; tools?: ToolSpec[] } {
  const messages: ChatMessage[] = []
  const system = typeof req.system === 'string' ? req.system : (req.system ?? []).map((b) => b.text).join('\n\n')
  if (system) messages.push({ role: 'system', content: system })
  const names = new Map<string, string>()

  for (const m of req.messages) {
    if (typeof m.content === 'string') {
      messages.push({ role: m.role, content: m.content })
      continue
    }
    if (m.role === 'assistant') {
      const text = m.content.filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text').map((b) => b.text).join('')
      const toolCalls: ToolCall[] = m.content
        .filter((b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use')
        .map((b) => {
          names.set(b.id, b.name)
          return { id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) }
        })
      messages.push({ role: 'assistant', content: text, ...(toolCalls.length ? { toolCalls } : {}) })
      continue
    }
    const textParts: string[] = []
    for (const b of m.content) {
      if (b.type === 'tool_result') {
        const content = blockText(b.content)
        messages.push({ role: 'tool', toolCallId: b.tool_use_id, name: names.get(b.tool_use_id), content: b.is_error ? `Error: ${content}` : content })
      } else if (b.type === 'text') textParts.push(b.text)
      else if (b.type === 'image' || b.type === 'document') textParts.push(`[${b.type} omitted]`)
    }
    if (textParts.length) messages.push({ role: 'user', content: textParts.join('\n') })
  }

  const tools = req.tools
    ?.filter((t) => !t.type || t.type === 'custom')
    .map((t) => ({ name: t.name, description: t.description ?? '', parameters: (t.input_schema ?? { type: 'object', properties: {} }) as ToolSpec['parameters'] }))
  return { messages, tools: tools?.length ? tools : undefined }
}

/** Claude Code asks for Claude model names; map them onto the router. */
export function targetForModel(model: string | undefined, known: (target: string) => boolean): string {
  if (!model) return 'auto'
  if (known(model)) return model
  if (/haiku/i.test(model)) return 'auto-fast'
  if (/claude|sonnet|opus/i.test(model)) return 'auto-code'
  return 'auto'
}

export function messageResponse(input: { id: string; model: string; text: string; toolCalls: ToolCall[]; inputTokens: number; outputTokens: number }): Record<string, unknown> {
  const content: unknown[] = []
  if (input.text) content.push({ type: 'text', text: input.text })
  for (const c of input.toolCalls) {
    let parsed: unknown = {}
    try {
      parsed = JSON.parse(c.arguments || '{}')
    } catch {
      parsed = { raw: c.arguments }
    }
    content.push({ type: 'tool_use', id: c.id, name: c.name, input: parsed })
  }
  return {
    id: input.id,
    type: 'message',
    role: 'assistant',
    model: input.model,
    content,
    stop_reason: input.toolCalls.length ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: input.inputTokens, output_tokens: input.outputTokens }
  }
}

export function estimateTokens(req: AnthropicRequest): number {
  return Math.ceil(JSON.stringify({ s: req.system, m: req.messages, t: req.tools }).length / 4)
}
