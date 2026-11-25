import { describe, expect, it } from 'vitest'
import { agentRequestForProvider, compactToolSpecs, minimalAgentMessages } from '../src/agent/minimal-context'
import type { ChatMessage, ToolSpec } from '../src/types'

const long = 'x'.repeat(120)
const tool: ToolSpec = {
  name: 'fs_read',
  description: long,
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
}
const image = { kind: 'image' as const, name: 'shot.png', mime: 'image/png', dataBase64: 'aaa' }

const thread: ChatMessage[] = [
  { role: 'system', content: 'Personal instructions and a large project file.' },
  { role: 'user', content: 'an older turn' },
  { role: 'assistant', content: 'an older reply' },
  { role: 'user', content: 'fix the bug', attachments: [image] },
  { role: 'assistant', content: 'reading', toolCalls: [{ id: 'c1', name: 'fs_read', arguments: '{"path":"a.ts"}' }] },
  { role: 'tool', content: 'file text', toolCallId: 'c1', name: 'fs_read' },
  { role: 'user', content: 'Current task (1/2): open the file. Do this task only.' }
]

describe('minimalAgentMessages', () => {
  it('keeps the latest request, its attachments, and this run, and drops the long system text', () => {
    const out = minimalAgentMessages(thread, '/work/app')
    expect(out.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user'])
    expect(out[0].content).toBe('You are an agent. You are working in /work/app. Call tools to do the work. Do only the current task. Finish with a short summary.')
    expect(out[0].content).not.toContain('Personal instructions')
    expect(out[1]).toMatchObject({ role: 'user', content: 'fix the bug', attachments: [image] })
    expect(out[3]).toMatchObject({ role: 'tool', content: 'file text' })
    expect(out[4].content).toContain('Current task (1/2)')
    expect(out.some((m) => m.content === 'an older turn')).toBe(false)
  })
})

describe('compactToolSpecs', () => {
  it('shortens a description longer than 80 characters and keeps the parameters', () => {
    const [short] = compactToolSpecs([tool])
    expect(short.description).toHaveLength(80)
    expect(short.description.endsWith('…')).toBe(true)
    expect(short.parameters).toEqual(tool.parameters)
    expect(short.name).toBe('fs_read')
  })

  it('leaves a short description unchanged', () => {
    const brief = { ...tool, description: 'Read a file' }
    expect(compactToolSpecs([brief])[0]).toBe(brief)
  })
})

describe('agentRequestForProvider', () => {
  it('leaves a provider that is not checked unchanged', () => {
    const sent = agentRequestForProvider('gemini-api', ['openrouter'], thread, [tool], '/work/app')
    expect(sent.messages).toBe(thread)
    expect(sent.tools).toEqual([tool])
  })

  it('leaves chat mode unchanged even when the provider is checked', () => {
    const sent = agentRequestForProvider('openrouter', ['openrouter'], thread, undefined, '/work/app')
    expect(sent.messages).toBe(thread)
    expect(sent.tools).toBeUndefined()
  })

  it('shrinks an agent step for a checked provider', () => {
    const sent = agentRequestForProvider('openrouter', ['openrouter'], thread, [tool], '/work/app')
    expect(sent.messages[0].role).toBe('system')
    expect(sent.messages[0].content).not.toContain('Personal instructions')
    expect(sent.messages[1].content).toBe('fix the bug')
    expect(sent.tools?.[0].description).toHaveLength(80)
  })
})
