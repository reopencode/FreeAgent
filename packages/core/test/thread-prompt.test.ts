import { describe, expect, it } from 'vitest'
import { followUpPrompt, threadPrompt } from '../src/providers/emulated-tools'
import type { ChatMessage } from '../src/types'

const system: ChatMessage = { role: 'system', content: 'Be brief.' }
const u = (content: string): ChatMessage => ({ role: 'user', content })
const a = (content: string): ChatMessage => ({ role: 'assistant', content })

describe('threadPrompt', () => {
  it('types only the first message into a new site chat in plain mode', () => {
    expect(threadPrompt([system, u('hello')], { plain: true })).toBe('hello')
  })

  it('sends the instructions with the first message when plain mode is off', () => {
    const prompt = threadPrompt([system, u('hello')], { plain: false })
    expect(prompt).toContain('[Instructions]\nBe brief.')
    expect(prompt).toContain('User: hello')
  })

  it('types only the new message into a thread that already holds the earlier turns', () => {
    const messages = [system, u('one'), a('r1'), u('two')]
    expect(threadPrompt(messages, { plain: true, known: 1 })).toBe('two')
    expect(threadPrompt(messages, { plain: false, known: 1 })).toBe('two')
  })

  it('replays earlier turns once into a new site chat, without instructions in plain mode', () => {
    const messages = [system, u('one'), a('r1'), u('two')]
    const prompt = threadPrompt(messages, { plain: true })
    expect(prompt).not.toContain('Be brief.')
    expect(prompt).toContain('User: one')
    expect(prompt).toContain('Assistant: r1')
    expect(prompt).toContain('User: two')
    expect(threadPrompt(messages, { plain: false })).toContain('[Instructions]\nBe brief.')
  })

  it('catches the thread up when another provider answered turns in between', () => {
    const messages = [system, u('one'), a('r1'), u('two'), a('r2'), u('three')]
    expect(threadPrompt(messages, { plain: false, known: 1 })).toContain('User: two')
    // Plain mode keeps its promise of sending the latest message only.
    expect(threadPrompt(messages, { plain: true, known: 1 })).toBe('three')
  })
})

describe('followUpPrompt', () => {
  it('still wraps tool results for agent runs', () => {
    const prompt = followUpPrompt([{ role: 'tool', content: 'ok', name: 'fs_list' }], [{ name: 'fs_list', description: '', parameters: {} }])
    expect(prompt).toContain('Tool result (fs_list):\nok')
    expect(prompt).toContain('Tools: fs_list')
  })
})
