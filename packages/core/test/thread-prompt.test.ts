import { describe, expect, it } from 'vitest'
import { followUpPrompt, threadPrompt } from '../src/providers/emulated-tools'
import type { ChatMessage } from '../src/types'

const system: ChatMessage = { role: 'system', content: 'Be brief.' }
const u = (content: string): ChatMessage => ({ role: 'user', content })
const a = (content: string): ChatMessage => ({ role: 'assistant', content })

describe('threadPrompt', () => {
  it('sends the instructions with the first message', () => {
    const prompt = threadPrompt([system, u('hello')])
    expect(prompt).toContain('[Instructions]\nBe brief.')
    expect(prompt).toContain('User: hello')
  })

  it('types only the new message into a thread that already holds the earlier turns', () => {
    const messages = [system, u('one'), a('r1'), u('two')]
    expect(threadPrompt(messages, { known: 1 })).toBe('two')
  })

  it('replays earlier turns once into a new site chat, including instructions', () => {
    const messages = [system, u('one'), a('r1'), u('two')]
    const prompt = threadPrompt(messages)
    expect(prompt).toContain('[Instructions]\nBe brief.')
    expect(prompt).toContain('User: one')
    expect(prompt).toContain('Assistant: r1')
    expect(prompt).toContain('User: two')
  })

  it('catches the thread up when another provider answered turns in between', () => {
    const messages = [system, u('one'), a('r1'), u('two'), a('r2'), u('three')]
    const prompt = threadPrompt(messages, { known: 1 })
    expect(prompt).toContain('User: two')
    expect(prompt).toContain('User: three')
    expect(prompt).toContain('[Instructions]\nBe brief.')
  })
})

describe('followUpPrompt', () => {
  it('still wraps tool results for agent runs', () => {
    const prompt = followUpPrompt([{ role: 'tool', content: 'ok', name: 'fs_list' }], [{ name: 'fs_list', description: '', parameters: {} }])
    expect(prompt).toContain('Tool result (fs_list):\nok')
    expect(prompt).toContain('Tools: fs_list')
  })

  it('keeps the format reminder to one line instead of repeating the full block', () => {
    const prompt = followUpPrompt([{ role: 'tool', content: 'ok', name: 'fs_list' }], [{ name: 'fs_list', description: 'List files', parameters: {} }])
    expect(prompt).toBe('Tool result (fs_list):\nok\n\nContinue: call more tools with ```tool_call blocks as before, or give the final answer in normal text.\nTools: fs_list')
  })
})
