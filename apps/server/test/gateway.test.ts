import { describe, expect, it } from 'vitest'
import { fromAnthropic, messageResponse, targetForModel } from '../src/gateway/anthropic'
import { completionResponse, fromOpenAI } from '../src/gateway/openai'

describe('Anthropic gateway translation', () => {
  it('converts tool_use and tool_result blocks into the internal format', () => {
    const { messages, tools } = fromAnthropic({
      system: [{ type: 'text', text: 'You are Claude Code.' }],
      messages: [
        { role: 'user', content: 'list files' },
        { role: 'assistant', content: [{ type: 'text', text: 'Sure.' }, { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'a.txt' }] }
      ],
      tools: [{ name: 'Bash', description: 'Run a command', input_schema: { type: 'object', properties: { command: { type: 'string' } } } }]
    })
    expect(messages[0]).toEqual({ role: 'system', content: 'You are Claude Code.' })
    expect(messages[2]).toEqual({ role: 'assistant', content: 'Sure.', toolCalls: [{ id: 'tu_1', name: 'Bash', arguments: '{"command":"ls"}' }] })
    expect(messages[3]).toEqual({ role: 'tool', toolCallId: 'tu_1', name: 'Bash', content: 'a.txt' })
    expect(tools?.[0].name).toBe('Bash')
  })

  it('builds a tool_use response', () => {
    const res = messageResponse({ id: 'msg_1', model: 'claude-sonnet', text: '', toolCalls: [{ id: 'c1', name: 'Bash', arguments: '{"command":"pwd"}' }], inputTokens: 5, outputTokens: 2 })
    expect(res.stop_reason).toBe('tool_use')
    expect(res.content).toEqual([{ type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'pwd' } }])
  })

  it('maps Claude model names onto auto targets', () => {
    const known = (t: string): boolean => t === 'openrouter'
    expect(targetForModel('claude-3-5-haiku-latest', known)).toBe('auto-fast')
    expect(targetForModel('claude-sonnet-4-5', known)).toBe('auto-code')
    expect(targetForModel('openrouter', known)).toBe('openrouter')
    expect(targetForModel(undefined, known)).toBe('auto')
  })
})

describe('OpenAI gateway translation', () => {
  it('reads tool calls and multi-part content', () => {
    const { messages, tools } = fromOpenAI({
      model: 'auto',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'done' }
      ],
      tools: [{ type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object' } } }]
    })
    expect(messages[0]).toMatchObject({ role: 'user', content: 'hi' })
    expect(messages[1].toolCalls?.[0]).toEqual({ id: 'c1', name: 'f', arguments: '{}' })
    expect(messages[2]).toMatchObject({ role: 'tool', toolCallId: 'c1', content: 'done' })
    expect(tools?.[0].name).toBe('f')
  })

  it('builds a completion with tool calls', () => {
    const res = completionResponse({ id: 'x', model: 'auto', text: '', toolCalls: [{ id: 'c1', name: 'f', arguments: '{}' }] }) as { choices: { finish_reason: string }[] }
    expect(res.choices[0].finish_reason).toBe('tool_calls')
  })
})
