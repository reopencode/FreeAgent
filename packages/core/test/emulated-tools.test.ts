import { describe, expect, it } from 'vitest'
import { agentPrompt, flattenConversation, parseEmulatedToolCalls, repairPrompt, toolInstructions, toolSignature, WEB_LIMITS } from '../src/providers/emulated-tools'
import type { ChatMessage, ToolSpec } from '../src/types'

const tools: ToolSpec[] = [
  { name: 'fs_read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'fs_write', description: 'Write a file', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  {
    name: 'run_code',
    description: 'Run a\n  snippet',
    parameters: {
      type: 'object',
      properties: {
        language: { type: 'string', enum: ['javascript', 'python'] },
        code: { type: 'string' },
        timeout: { type: 'number', description: 'Seconds, default 60' },
        env: { type: 'object', properties: { key: { type: 'string' } } },
        tags: { type: 'array', items: { type: 'string' } }
      },
      required: ['language', 'code']
    }
  }
]

const parse = (text: string) => parseEmulatedToolCalls(text, tools)
const args = (text: string, i = 0) => JSON.parse(parse(text).calls[i].arguments)

describe('toolSignature and toolInstructions', () => {
  it('writes a compact one-line signature', () => {
    expect(toolSignature(tools[0])).toBe('fs_read(path: string) - Read a file')
    expect(toolSignature(tools[2])).toBe(
      'run_code(language: "javascript"|"python", code: string, timeout?: number (Seconds, default 60), env?: {"type":"object","properties":{"key":{"type":"string"}}}, tags?: string[]) - Run a snippet'
    )
  })

  it('treats every argument as optional when nothing is required', () => {
    expect(toolSignature({ name: 'fs_list', description: '', parameters: { type: 'object', properties: { path: { type: 'string' } } } })).toBe('fs_list(path?: string)')
  })

  it('lists signatures with a worked example and no full schemas', () => {
    const text = toolInstructions(tools)
    expect(text).toContain('```tool_call\n{"name":"fs_read","arguments":{"path":"..."}}\n```')
    expect(text).toContain('- fs_write(path: string, content: string) - Write a file')
    expect(text).not.toContain('"properties":{"path"')
    expect(flattenConversation([{ role: 'user', content: 'hi' }], tools)).toContain('[Tools]')
  })

  it('shortens long tool descriptions such as MCP ones', () => {
    const sig = toolSignature({ name: 'mcp_x', description: 'word '.repeat(100), parameters: {} })
    expect(sig.length).toBeLessThan(200)
    expect(sig.endsWith('…')).toBe(true)
  })

  it('repairPrompt names the valid tools', () => {
    expect(repairPrompt(tools)).toContain('Valid tool names: fs_read, fs_write, run_code')
  })
})

const sys = (content: string): ChatMessage => ({ role: 'system', content })
const user = (content: string): ChatMessage => ({ role: 'user', content })
const bot = (content: string): ChatMessage => ({ role: 'assistant', content })
const result = (content: string): ChatMessage => ({ role: 'tool', name: 'fs_read', content })

describe('web prompt size', () => {
  it('keeps project files within the web budget', () => {
    const big = 'x'.repeat(WEB_LIMITS.files + 5_000)
    const flat = flattenConversation([sys(`Project files:\n<file name="a.txt">\n${big}\n</file>\n<file name="b.txt">\nsecond\n</file>`), user('hi')], tools)
    expect(flat.length).toBeLessThan(WEB_LIMITS.files + 3_000)
    expect(flat).toContain('<file name="b.txt">(left out to keep the message short)</file>')
  })

  it('keeps the last few earlier messages, shortened, and the current turn in full', () => {
    const history = Array.from({ length: 30 }, (_, i) => (i % 2 ? bot(`reply ${i} ${'y'.repeat(5_000)}`) : user(`ask ${i}`)))
    const latest = `now ${'z'.repeat(5_000)}`
    const flat = flattenConversation([...history, user(latest), result('r'.repeat(20_000))], tools)
    expect(flat).toContain(`(${30 - WEB_LIMITS.historyMessages} earlier messages left out)`)
    expect(flat).not.toContain('ask 0')
    expect(flat).toContain('ask 28')
    expect(flat).not.toContain('y'.repeat(WEB_LIMITS.historyMessage + 1))
    expect(flat).toContain(latest)
    expect(flat).not.toContain('r'.repeat(WEB_LIMITS.toolResult + 1))
  })
})

describe('agentPrompt', () => {
  const turn1 = [sys('Be brief.'), user('one')]

  it('sends the whole conversation into a new site chat', () => {
    expect(agentPrompt(turn1, tools)).toContain('[Tools]')
  })

  it('sends only new tool results on a later step of the run', () => {
    const step2 = [...turn1, { role: 'assistant' as const, content: '', toolCalls: [{ id: 'c', name: 'fs_read', arguments: '{}' }] }, result('body')]
    const prompt = agentPrompt(step2, tools, { users: 1, tools: true, runSent: turn1.length })
    expect(prompt).toContain('Tool result (fs_read):\nbody')
    expect(prompt).not.toContain('Be brief.')
    expect(prompt).not.toContain('User: one')
  })

  it('sends only the new message on a new turn of a conversation that holds the earlier ones', () => {
    const turn2 = [...turn1, bot('r1'), user('two')]
    const prompt = agentPrompt(turn2, tools, { users: 1, tools: true, runSent: 9 })
    expect(prompt.startsWith('User: two')).toBe(true)
    expect(prompt).not.toContain('[Tools]')
    expect(agentPrompt(turn2, tools, { users: 1, tools: false })).toContain('[Tools]')
  })

  it('catches the site up when it misses turns', () => {
    const turn3 = [...turn1, bot('r1'), user('two'), bot('r2'), user('three')]
    expect(agentPrompt(turn3, tools, { users: 1, tools: true })).toContain('User: two')
  })
})

describe('parseEmulatedToolCalls', () => {
  it('reads fences with or without a language tag', () => {
    expect(args('```json\n{"name":"fs_read","arguments":{"path":"a"}}\n```')).toEqual({ path: 'a' })
    expect(args('```\n{"name":"fs_read","arguments":{"path":"b"}}\n```')).toEqual({ path: 'b' })
    expect(args('```tool_call {"name":"fs_read","arguments":{"path":"c"}}```')).toEqual({ path: 'c' })
  })

  it('reads <tool_call> tags without double-counting a fence inside them', () => {
    const out = parse('Sure.\n<tool_call>\n```json\n{"name":"fs_read","arguments":{"path":"a"}}\n```\n</tool_call>')
    expect(out.calls).toHaveLength(1)
    expect(out.text).toBe('Sure.')
  })

  it('reads a reply that is only a JSON object', () => {
    const out = parse('{"name":"fs_read","arguments":{"path":"a"}}')
    expect(out.calls).toHaveLength(1)
    expect(out.text).toBe('')
  })

  it('accepts key variants', () => {
    expect(args('```json\n{"tool":"fs_read","args":{"path":"a"}}\n```')).toEqual({ path: 'a' })
    expect(args('```json\n{"name":"fs_read","parameters":{"path":"b"}}\n```')).toEqual({ path: 'b' })
    expect(args('```json\n{"function":{"name":"fs_read","arguments":"{\\"path\\":\\"c\\"}"}}\n```')).toEqual({ path: 'c' })
  })

  it('undoes markdown escapes from the page', () => {
    expect(args('```tool_call\n{"name":"fs\\_read","arguments":{"path":"my\\_file.txt"}}\n```')).toEqual({ path: 'my_file.txt' })
  })

  it('keeps braces and fences inside JSON strings', () => {
    const content = 'function f() { return "}" }\n```js\nx\n```'
    const reply = `Writing it.\n\`\`\`tool_call\n${JSON.stringify({ name: 'fs_write', arguments: { path: 'a.md', content } })}\n\`\`\`\nDone soon.`
    const out = parse(reply)
    expect(out.calls).toHaveLength(1)
    expect(JSON.parse(out.calls[0].arguments).content).toBe(content)
    expect(out.text).toBe('Writing it.\n\nDone soon.')
  })

  it('reads several calls, in separate blocks or in one array', () => {
    const two = parse('```tool_call\n{"name":"fs_read","arguments":{"path":"a"}}\n```\n```tool_call\n{"name":"fs_read","arguments":{"path":"b"}}\n```')
    expect(two.calls.map((c) => JSON.parse(c.arguments).path)).toEqual(['a', 'b'])
    expect(new Set(two.calls.map((c) => c.id)).size).toBe(2)
    const arr = parse('```json\n[{"name":"fs_read","arguments":{"path":"a"}},{"name":"fs_read","arguments":{"path":"b"}}]\n```')
    expect(arr.calls).toHaveLength(2)
  })

  it('flags unknown tools and broken tool JSON as malformed', () => {
    expect(parse('```tool_call\n{"name":"rm_rf","arguments":{}}\n```')).toMatchObject({ calls: [], malformed: true })
    expect(parse('```tool_call\n{"name": fs_read}\n```')).toMatchObject({ calls: [], malformed: true })
    expect(parse('```json\n{"name":"fs_read","arguments":{"path":"a"\n```')).toMatchObject({ calls: [], malformed: true })
  })

  it('leaves ordinary answers and JSON examples alone', () => {
    expect(parse('The answer is 42.')).toEqual({ calls: [], text: 'The answer is 42.', malformed: false })
    const data = 'Here is the user:\n```json\n{"name":"Ada","age":36}\n```'
    expect(parse(data)).toEqual({ calls: [], text: data, malformed: false })
    expect(parse('```js\nconst a = 1\n```').malformed).toBe(false)
  })
})
