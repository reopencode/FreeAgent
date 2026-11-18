import type { ChatMessage, JsonSchema, ToolCall, ToolSpec } from '../types'
import { id } from '../util'

const FENCE_OPEN = /```([\w-]*)[ \t]*/
const TAG = /<tool_call>([\s\S]*?)<\/tool_call>/g
/** Fence languages that only ever hold a tool call, so a broken one is worth a repair prompt. */
const TOOL_LANGS = new Set(['tool_call', 'tool', 'tool_code'])
const ARG_KEYS = ['arguments', 'args', 'parameters', 'input'] as const
const PARAM_HINT_MAX = 80

const FORMAT = ['```tool_call', '{"name": "<tool name>", "arguments": { ... }}', '```'].join('\n')

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

function isNested(schema: JsonSchema): boolean {
  if (schema.type === 'object' || schema.properties || schema.anyOf || schema.oneOf || schema.allOf) return true
  if (schema.type !== 'array') return false
  const items = schema.items as JsonSchema | undefined
  return !!items && typeof items === 'object' && isNested(items)
}

function typeLabel(schema: JsonSchema): string {
  if (Array.isArray(schema.enum)) return schema.enum.map((v) => JSON.stringify(v)).join('|')
  if (schema.type === 'array') {
    const items = schema.items as JsonSchema | undefined
    return `${items && typeof items === 'object' ? typeLabel(items) : 'any'}[]`
  }
  if (Array.isArray(schema.type)) return schema.type.join('|')
  return typeof schema.type === 'string' ? schema.type : 'any'
}

/** One line per tool, like `fs_read(path: string, max_bytes?: number) - Read a file`. Nested parameters keep their JSON schema. */
export function toolSignature(tool: ToolSpec): string {
  const props = (tool.parameters?.properties ?? {}) as Record<string, JsonSchema>
  const required = new Set(tool.parameters?.required ?? [])
  const params = Object.entries(props).map(([name, raw]) => {
    const schema = raw && typeof raw === 'object' ? raw : {}
    const label = `${name}${required.has(name) ? '' : '?'}: ${isNested(schema) ? JSON.stringify(schema) : typeLabel(schema)}`
    const hint = typeof schema.description === 'string' && !isNested(schema) ? oneLine(schema.description) : ''
    return hint ? `${label} (${hint.length > PARAM_HINT_MAX ? `${hint.slice(0, PARAM_HINT_MAX - 1)}…` : hint})` : label
  })
  const description = oneLine(tool.description ?? '')
  return `${tool.name}(${params.join(', ')})${description ? ` - ${description}` : ''}`
}

function exampleCall(tool: ToolSpec): string {
  const props = (tool.parameters?.properties ?? {}) as Record<string, JsonSchema>
  const required = tool.parameters?.required?.length ? tool.parameters.required : Object.keys(props).slice(0, 1)
  const args: Record<string, unknown> = {}
  for (const name of required) {
    const type = props[name]?.type
    args[name] = type === 'number' || type === 'integer' ? 1 : type === 'boolean' ? true : type === 'array' ? [] : type === 'object' ? {} : '...'
  }
  return JSON.stringify({ name: tool.name, arguments: args })
}

export function toolInstructions(tools: ToolSpec[]): string {
  return [
    'You can call tools. To call one, reply with a fenced block in exactly this format:',
    FORMAT,
    ...(tools.length ? ['For example:', '```tool_call', exampleCall(tools[0]), '```'] : []),
    'Use the tool and argument names exactly as listed. Several blocks in one reply run in order.',
    'After the tools run you receive their results. Then call more tools, or give the final answer in normal text with no tool_call block.',
    'Tools (? marks an optional argument):',
    ...tools.map((t) => `- ${toolSignature(t)}`)
  ].join('\n')
}

/** End index (exclusive) of the JSON object or array that opens at `start`, or -1 when it never closes. */
function balancedEnd(text: string, start: number): number {
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (c === '\\') i++
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === '{' || c === '[') depth++
    else if (c === '}' || c === ']') {
      depth--
      if (depth === 0) return i + 1
    }
  }
  return -1
}

/** Top-level JSON objects and arrays in `body`, as raw source. */
function jsonChunks(body: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < body.length) {
    const c = body[i]
    if (c !== '{' && c !== '[') {
      i++
      continue
    }
    const end = balancedEnd(body, i)
    if (end < 0) {
      out.push(body.slice(i))
      break
    }
    out.push(body.slice(i, end))
    i = end
  }
  return out
}

/** Reply markdown escapes characters such as `_` and `*`, which makes the JSON invalid. */
function parseLoose(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return JSON.parse(raw.replace(/\\([_*[\]`#~<>|-])/g, '$1'))
  }
}

type Parsed = { kind: 'call'; name: string; args: unknown } | { kind: 'unknown_tool' } | { kind: 'not_a_call' }

function readCall(obj: unknown, names: Set<string>): Parsed {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { kind: 'not_a_call' }
  const o = obj as Record<string, unknown>
  const fn = o.function && typeof o.function === 'object' ? (o.function as Record<string, unknown>) : undefined
  const name = [o.name, o.tool, typeof o.function === 'string' ? o.function : fn?.name].find((v): v is string => typeof v === 'string')
  const argKey = ARG_KEYS.find((k) => k in o)
  const args = argKey ? o[argKey] : fn?.arguments
  if (!name) return { kind: 'not_a_call' }
  if (names.has(name)) return { kind: 'call', name, args: args ?? {} }
  return argKey || fn ? { kind: 'unknown_tool' } : { kind: 'not_a_call' }
}

interface Candidate {
  /** Exact source to cut out of the reply when it held a call. */
  span: string
  body: string
  /** Whether the wrapper itself says this is a tool call. */
  explicit: boolean
}

/**
 * Tool call wrappers in a reply: `<tool_call>` tags, fenced blocks that open with JSON, or a reply that is only JSON.
 * A fenced call is measured by its balanced braces, because written file contents often hold fences of their own.
 */
function candidates(text: string): Candidate[] {
  const out: Candidate[] = []
  let masked = text
  for (const m of text.matchAll(TAG)) {
    out.push({ span: m[0], body: m[1], explicit: true })
    masked = masked.slice(0, m.index) + ' '.repeat(m[0].length) + masked.slice(m.index + m[0].length)
  }
  const open = new RegExp(FENCE_OPEN.source, 'g')
  for (let m = open.exec(masked); m; m = open.exec(masked)) {
    let pos = m.index + m[0].length
    while (pos < masked.length && /\s/.test(masked[pos])) pos++
    if (masked[pos] !== '{' && masked[pos] !== '[') {
      const close = masked.indexOf('```', pos)
      if (close < 0) break
      open.lastIndex = close + 3
      continue
    }
    const end = balancedEnd(masked, pos)
    const close = end < 0 ? -1 : masked.indexOf('```', end)
    const stop = end < 0 ? masked.length : close < 0 || masked.slice(end, close).trim() ? end : close + 3
    out.push({ span: text.slice(m.index, stop), body: text.slice(pos, end < 0 ? masked.length : end), explicit: TOOL_LANGS.has(m[1].toLowerCase()) })
    open.lastIndex = stop
  }
  const trimmed = text.trim()
  if (!out.length && /^[[{]/.test(trimmed) && /[\]}]$/.test(trimmed)) out.push({ span: trimmed, body: trimmed, explicit: false })
  return out
}

export interface EmulatedToolCalls {
  calls: ToolCall[]
  /** The reply with every block that held a call removed. */
  text: string
  /** A block looked like a tool call but could not be read, or named a tool that does not exist. */
  malformed: boolean
}

/** Extracts tool calls a web model wrote as text. Returns the remaining prose separately. */
export function parseEmulatedToolCalls(text: string, tools: ToolSpec[]): EmulatedToolCalls {
  const names = new Set(tools.map((t) => t.name))
  const calls: ToolCall[] = []
  let malformed = false
  let rest = text
  for (const c of candidates(text)) {
    const mentionsTool = c.explicit || /"arguments"\s*:/.test(c.body) || [...names].some((n) => c.body.includes(`"${n}"`))
    let found = false
    for (const chunk of jsonChunks(c.body)) {
      let value: unknown
      try {
        value = parseLoose(chunk)
      } catch {
        if (mentionsTool) malformed = true
        continue
      }
      for (const item of Array.isArray(value) ? value : [value]) {
        const parsed = readCall(item, names)
        if (parsed.kind === 'call') {
          calls.push({ id: id('call_'), name: parsed.name, arguments: typeof parsed.args === 'string' ? parsed.args : JSON.stringify(parsed.args) })
          found = true
        } else if (parsed.kind === 'unknown_tool' || (parsed.kind === 'not_a_call' && c.explicit)) malformed = true
      }
    }
    if (found) rest = rest.replace(c.span, '')
  }
  return { calls, text: rest.replace(/\n{3,}/g, '\n\n').trim(), malformed }
}

/** Sent into the same site chat when its reply held a tool call that could not be read. */
export function repairPrompt(tools: ToolSpec[]): string {
  return [
    'I could not read the tool call in your last reply. Reply again with ONLY the corrected block(s), in exactly this format:',
    FORMAT,
    'The arguments must be valid JSON.',
    `Valid tool names: ${tools.map((t) => t.name).join(', ')}`
  ].join('\n')
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
  lines.push(`Continue: call more tools with \`\`\`tool_call blocks as before, or give the final answer in normal text.\nTools: ${tools.map((t) => t.name).join(', ')}`)
  return lines.join('\n\n')
}

/**
 * What to type for one turn of a saved chat that keeps a website conversation open.
 * `known` is how many user turns the site thread already holds, or undefined when the thread is new to it
 * (first turn, a restart, a lost tab, or a chat that earlier turns answered on another provider).
 * Plain-text mode never sends instructions, but it does replay earlier turns once into a thread that lacks them.
 */
export function threadPrompt(messages: ChatMessage[], opts: { plain: boolean; known?: number }): string {
  const users = messages.filter((m) => m.role === 'user').length
  const latest = latestUserText(messages)
  if (opts.known === undefined) {
    if (users <= 1) return opts.plain && latest ? latest : flattenConversation(messages)
    return flattenConversation(opts.plain ? messages.filter((m) => m.role !== 'system') : messages)
  }
  // The site holds every turn up to `known`; it only misses turns another provider answered in between.
  if (!latest || (!opts.plain && users > opts.known + 1)) return flattenConversation(messages)
  return latest
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
