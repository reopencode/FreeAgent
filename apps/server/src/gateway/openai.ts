import type { ChatMessage, ToolCall, ToolSpec } from '@freeagent/core'

type OpenAIContent = string | null | { type: string; text?: string }[]

export interface OpenAIRequest {
  model?: string
  messages: {
    role: string
    content?: OpenAIContent
    name?: string
    tool_call_id?: string
    tool_calls?: { id: string; type?: string; function: { name: string; arguments?: string } }[]
  }[]
  tools?: { type: string; function: { name: string; description?: string; parameters?: Record<string, unknown> } }[]
  stream?: boolean
  temperature?: number
  max_tokens?: number
  max_completion_tokens?: number
}

export function contentText(c: OpenAIContent | undefined): string {
  if (!c) return ''
  if (typeof c === 'string') return c
  return c
    .map((p) => (p.type === 'text' || p.type === 'input_text' ? (p.text ?? '') : p.type.includes('image') ? '[image omitted]' : ''))
    .filter(Boolean)
    .join('\n')
}

export function fromOpenAI(req: OpenAIRequest): { messages: ChatMessage[]; tools?: ToolSpec[] } {
  const messages: ChatMessage[] = req.messages.map((m) => {
    const role = m.role === 'developer' ? 'system' : m.role
    if (role === 'tool') return { role: 'tool', content: contentText(m.content), toolCallId: m.tool_call_id, name: m.name }
    if (role === 'assistant') {
      return {
        role: 'assistant',
        content: contentText(m.content),
        toolCalls: m.tool_calls?.map((c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments ?? '{}' }))
      }
    }
    return { role: role === 'system' ? 'system' : 'user', content: contentText(m.content) }
  })
  // Gemini needs the tool name on tool results; recover it from the matching call.
  const names = new Map<string, string>()
  for (const m of messages) for (const c of m.toolCalls ?? []) names.set(c.id, c.name)
  for (const m of messages) if (m.role === 'tool' && !m.name && m.toolCallId) m.name = names.get(m.toolCallId)

  const tools = req.tools
    ?.filter((t) => t.type === 'function')
    .map((t) => ({ name: t.function.name, description: t.function.description ?? '', parameters: (t.function.parameters ?? { type: 'object', properties: {} }) as ToolSpec['parameters'] }))
  return { messages, tools: tools?.length ? tools : undefined }
}

export function completionResponse(input: { id: string; model: string; text: string; toolCalls: ToolCall[] }): Record<string, unknown> {
  return {
    id: input.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: input.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: input.text || (input.toolCalls.length ? null : ''),
          ...(input.toolCalls.length
            ? { tool_calls: input.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) }
            : {})
        },
        finish_reason: input.toolCalls.length ? 'tool_calls' : 'stop'
      }
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  }
}

export function chunk(id: string, model: string, delta: Record<string, unknown>, finish: string | null = null): string {
  return JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finish }] })
}
