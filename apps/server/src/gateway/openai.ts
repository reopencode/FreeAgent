import type { ChatAttachment, ChatMessage, ToolCall, ToolSpec } from '@freeagent/core'

type OpenAIContent = string | null | { type: string; text?: string; image_url?: { url?: string }; input_audio?: { data?: string; format?: string } }[]

function dataUrl(url: string): { mime: string; base64: string } | undefined {
  const m = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(url.trim())
  if (!m) return undefined
  return { mime: m[1], base64: m[2].replace(/\s/g, '') }
}

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

export function readContent(c: OpenAIContent | undefined): { text: string; attachments: ChatAttachment[] } {
  if (!c) return { text: '', attachments: [] }
  if (typeof c === 'string') return { text: c, attachments: [] }
  const texts: string[] = []
  const attachments: ChatAttachment[] = []
  for (const p of c) {
    if (p.type === 'text' || p.type === 'input_text') texts.push(p.text ?? '')
    else if (p.type === 'input_audio' && p.input_audio?.data) {
      const format = p.input_audio.format || 'wav'
      attachments.push({ kind: 'audio', name: `audio.${format}`, mime: format === 'mp3' ? 'audio/mpeg' : `audio/${format}`, dataBase64: p.input_audio.data })
    } else if (p.type.includes('image') || p.image_url?.url) {
      const url = p.image_url?.url
      const parsed = url ? dataUrl(url) : undefined
      if (parsed) attachments.push({ kind: 'image', name: 'image', mime: parsed.mime, dataBase64: parsed.base64 })
      else if (url) attachments.push({ kind: 'image', name: 'image', mime: 'image/*', url })
    }
  }
  return { text: texts.filter(Boolean).join('\n'), attachments }
}

export function contentText(c: OpenAIContent | undefined): string {
  return readContent(c).text
}

function withAttachments(message: ChatMessage, attachments: ChatAttachment[]): ChatMessage {
  return attachments.length ? { ...message, attachments } : message
}

export function fromOpenAI(req: OpenAIRequest): { messages: ChatMessage[]; tools?: ToolSpec[] } {
  const messages: ChatMessage[] = req.messages.map((m) => {
    const role = m.role === 'developer' ? 'system' : m.role
    const read = readContent(m.content)
    if (role === 'tool') return { role: 'tool', content: read.text, toolCallId: m.tool_call_id, name: m.name }
    if (role === 'assistant') {
      return withAttachments(
        {
          role: 'assistant',
          content: read.text,
          toolCalls: m.tool_calls?.map((c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments ?? '{}' }))
        },
        read.attachments
      )
    }
    return withAttachments({ role: role === 'system' ? 'system' : 'user', content: read.text }, read.attachments)
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
