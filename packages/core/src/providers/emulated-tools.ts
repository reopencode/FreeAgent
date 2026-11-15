import type { ChatMessage, ToolCall, ToolSpec } from '../types'

const BLOCK = /```(?:tool_call|tool|json)?\s*\n?(\{[\s\S]*?\})\s*```/g

export function toolInstructions(tools: ToolSpec[]): string {
  const list = tools
    .map((t) => `- ${t.name}: ${t.description}\n  parameters: ${JSON.stringify(t.parameters)}`)
    .join('\n')
  return [
    'You can call tools. To call a tool, reply with ONLY one fenced block in exactly this format and nothing else:',
    '```tool_call',
    '{"name": "<tool name>", "arguments": { ... }}',
    '```',
    'After the tool runs you will receive its result and can call another tool or give the final answer in normal text.',
    'Available tools:',
    list
  ].join('\n')
}

/** Extracts tool calls a web model wrote as text. Returns the remaining prose separately. */
export function parseEmulatedToolCalls(text: string, tools: ToolSpec[]): { calls: ToolCall[]; text: string } {
  const names = new Set(tools.map((t) => t.name))
  const calls: ToolCall[] = []
  let rest = text
  for (const match of text.matchAll(BLOCK)) {
    try {
      const obj = JSON.parse(match[1]) as { name?: string; tool?: string; arguments?: unknown; args?: unknown }
      const name = obj.name ?? obj.tool
      if (!name || !names.has(name)) continue
      const args = obj.arguments ?? obj.args ?? {}
      calls.push({ id: `call_${Date.now()}_${calls.length}`, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) })
      rest = rest.replace(match[0], '')
    } catch {
      continue
    }
  }
  return { calls, text: rest.trim() }
}

/** Last user turn's text, for web plain-text sends. */
export function latestUserText(messages: ChatMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'user') continue
    const text = m.content.trim()
    if (text) return text
  }
  return undefined
}

/**
 * Message for a web chat that is already open: only what happened since the last reply.
 * Assistant turns are skipped because the site already holds its own replies, and the tool
 * schemas were sent in the first message, so only the names are repeated.
 */
export function followUpPrompt(newMessages: ChatMessage[], tools: ToolSpec[]): string {
  const lines: string[] = []
  for (const m of newMessages) {
    if (m.role === 'tool') lines.push(`Tool result (${m.name ?? 'tool'}):\n${m.content}`)
    else if (m.role === 'user') lines.push(`User: ${m.content}`)
  }
  lines.push(
    [
      'Continue. Either call another tool with ONE fenced block in the same format as before:',
      '```tool_call',
      '{"name": "<tool name>", "arguments": { ... }}',
      '```',
      'or give the final answer in normal text.',
      `Tools: ${tools.map((t) => t.name).join(', ')}`
    ].join('\n')
  )
  return lines.join('\n\n')
}

/**
 * Web chats start fresh each time, so the whole conversation is flattened into one prompt.
 * Tool results are written back as plain text the model can read.
 */
export function flattenConversation(messages: ChatMessage[], tools?: ToolSpec[]): string {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content)
  const turns = messages.filter((m) => m.role !== 'system')
  if (!tools?.length && system.length === 0 && turns.length === 1 && turns[0].role === 'user') return turns[0].content

  const parts: string[] = []
  if (system.length) parts.push(`[Instructions]\n${system.join('\n\n')}`)
  if (tools?.length) parts.push(`[Tools]\n${toolInstructions(tools)}`)
  const lines = turns.map((m) => {
    if (m.role === 'user') return `User: ${m.content}`
    if (m.role === 'tool') return `Tool result (${m.name ?? 'tool'}):\n${m.content}`
    const calls = (m.toolCalls ?? []).map((c) => `\`\`\`tool_call\n{"name": "${c.name}", "arguments": ${c.arguments || '{}'}}\n\`\`\``)
    return `Assistant: ${[m.content, ...calls].filter(Boolean).join('\n')}`
  })
  parts.push(`[Conversation]\n${lines.join('\n\n')}`)
  parts.push('Continue the conversation as the Assistant. Reply to the latest message only.')
  return parts.join('\n\n')
}
