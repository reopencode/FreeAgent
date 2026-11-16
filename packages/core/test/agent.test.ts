import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentEvent } from '../src/api-types'
import { ProviderError, type ChatMessage, type ChatOptions, type Delta, type Provider } from '../src/types'
import { addFake, testCore, type TestCore } from './helpers'

/** Calls fs_list on its first step, then answers. Records the session ids it saw and the sessions it was told to end. */
class SessionProbe implements Provider {
  readonly kind = 'api' as const
  readonly name = 'probe'
  readonly description = 'test'
  readonly supportsTools = true
  readonly tags = ['general' as const]
  readonly seen: (string | undefined)[] = []
  readonly ended: string[] = []
  private calls = 0
  constructor(
    readonly id: string,
    private readonly failOnSecondStep = false
  ) {}
  async status() {
    return { state: 'ready' as const }
  }
  async models() {
    return [{ id: 'm', name: 'm', tags: ['general' as const] }]
  }
  async defaultModel() {
    return 'm'
  }
  async endSession(sessionId: string): Promise<void> {
    this.ended.push(sessionId)
  }
  async *chat(_messages: ChatMessage[], opts: ChatOptions): AsyncIterable<Delta> {
    this.seen.push(opts.sessionId)
    if (this.calls++ === 0) {
      yield { type: 'tool_call', call: { id: 'c1', name: 'fs_list', arguments: '{}' } }
      return
    }
    if (this.failOnSecondStep) throw new ProviderError(this.id, 'bad_request', 'boom')
    yield { type: 'text', text: 'done' }
  }
}

describe('agent runs keep one provider session', () => {
  let core: TestCore
  let cwd: string
  beforeEach(() => {
    core = testCore([])
    cwd = mkdtempSync(join(tmpdir(), 'freeagent-ws-'))
  })
  afterEach(async () => {
    await core.cleanup()
    rmSync(cwd, { recursive: true, force: true })
  })

  const run = (mode: 'agent' | 'chat') =>
    core.runner.run({ messages: [{ role: 'user', content: 'list files' }], mode, target: 'auto', cwd, emit: () => undefined })

  it('uses the same session id on every step and ends it once when the run finishes', async () => {
    const probe = new SessionProbe('probe')
    addFake(core, probe, 1)
    const res = await run('agent')
    expect(res.text).toContain('done')
    expect(probe.seen).toHaveLength(2)
    expect(probe.seen[0]).toBeTruthy()
    expect(probe.seen[1]).toBe(probe.seen[0])
    expect(probe.ended).toEqual([probe.seen[0]])
  })

  it('ends the session even when a step fails', async () => {
    const probe = new SessionProbe('probe', true)
    addFake(core, probe, 1)
    await expect(run('agent')).rejects.toThrow()
    expect(probe.ended).toEqual([probe.seen[0]])
  })

  it('does not open a session in a one-off chat run', async () => {
    const probe = new SessionProbe('probe')
    addFake(core, probe, 1)
    await run('chat')
    expect(probe.seen).toEqual([undefined])
    expect(probe.ended).toEqual([])
  })

  it('uses the chat id as the session id on every turn of a saved chat and keeps it open', async () => {
    const probe = new SessionProbe('probe')
    addFake(core, probe, 1)
    const turn = () =>
      core.runner.run({ messages: [{ role: 'user', content: 'hi' }], mode: 'chat', target: 'auto', cwd, chatId: 'chat_1', emit: () => undefined })
    await turn()
    await turn()
    expect(probe.seen).toEqual(['chat_1', 'chat_1'])
    expect(probe.ended).toEqual([])
  })

  it('ends a chat session on every provider when the chat is deleted', async () => {
    const probe = new SessionProbe('probe')
    addFake(core, probe, 1)
    await core.registry.endSession('chat_1')
    expect(probe.ended).toEqual(['chat_1'])
  })
})

describe('AgentRunner with the offline provider', () => {
  let core: TestCore
  let cwd: string
  beforeEach(() => {
    core = testCore(['mock'])
    cwd = mkdtempSync(join(tmpdir(), 'freeagent-ws-'))
  })
  afterEach(async () => {
    await core.cleanup()
    rmSync(cwd, { recursive: true, force: true })
  })

  it('answers in chat mode', async () => {
    const events: AgentEvent[] = []
    const res = await core.runner.run({ messages: [{ role: 'user', content: 'hello there' }], mode: 'chat', target: 'auto', cwd, emit: (e) => events.push(e) })
    expect(res.text).toContain('hello there')
    expect(res.meta.providerId).toBe('mock')
    expect(events.some((e) => e.type === 'route')).toBe(true)
  })

  it('runs an approved tool and feeds the result back', async () => {
    const events: AgentEvent[] = []
    const res = await core.runner.run({
      messages: [{ role: 'user', content: '/tool fs_write {"path":"notes/hi.txt","content":"written by test"}' }],
      mode: 'agent',
      target: 'auto',
      cwd,
      emit: (e) => {
        events.push(e)
        if (e.type === 'approval_request') core.approvals.resolve(e.id, true)
      }
    })
    expect(readFileSync(join(cwd, 'notes/hi.txt'), 'utf8')).toBe('written by test')
    expect(events.some((e) => e.type === 'tool_result' && e.ok)).toBe(true)
    expect(res.text).toContain('fs_write')
  })

  it('does not run a denied tool', async () => {
    const events: AgentEvent[] = []
    await core.runner.run({
      messages: [{ role: 'user', content: '/tool fs_write {"path":"nope.txt","content":"x"}' }],
      mode: 'agent',
      target: 'auto',
      cwd,
      emit: (e) => {
        events.push(e)
        if (e.type === 'approval_request') core.approvals.resolve(e.id, false)
      }
    })
    expect(existsSync(join(cwd, 'nope.txt'))).toBe(false)
    expect(events.some((e) => e.type === 'approval_resolved' && !e.approved)).toBe(true)
  })

  it('runs read-only tools without asking', async () => {
    const events: AgentEvent[] = []
    await core.runner.run({ messages: [{ role: 'user', content: '/tool fs_list {}' }], mode: 'agent', target: 'auto', cwd, emit: (e) => events.push(e) })
    expect(events.some((e) => e.type === 'approval_request')).toBe(false)
    expect(events.some((e) => e.type === 'tool_result' && e.ok)).toBe(true)
  })

  it('refuses paths outside the project folder', async () => {
    const events: AgentEvent[] = []
    await core.runner.run({ messages: [{ role: 'user', content: '/tool fs_read {"path":"../../etc/passwd"}' }], mode: 'agent', target: 'auto', cwd, emit: (e) => events.push(e) })
    const result = events.find((e) => e.type === 'tool_result')
    expect(result && result.type === 'tool_result' && result.ok).toBe(false)
  })
})
