import { afterEach, describe, expect, it } from 'vitest'
import { NoProviderError, parseTarget, type RouterEvent } from '../src/router'
import { addFake, FakeProvider, testCore, type TestCore } from './helpers'

async function collect(it: AsyncIterable<RouterEvent>): Promise<RouterEvent[]> {
  const out: RouterEvent[] = []
  for await (const ev of it) out.push(ev)
  return out
}

const text = (events: RouterEvent[]): string => events.map((e) => (e.type === 'text' ? e.text : '')).join('')

describe('parseTarget', () => {
  it('understands auto targets, providers and provider::model', () => {
    expect(parseTarget(undefined)).toEqual({ tag: undefined })
    expect(parseTarget('auto-code')).toEqual({ tag: 'code' })
    expect(parseTarget('openrouter')).toEqual({ providerId: 'openrouter' })
    expect(parseTarget('openrouter::meta/llama:free')).toEqual({ providerId: 'openrouter', model: 'meta/llama:free' })
  })
})

describe('Router', () => {
  let core: TestCore
  afterEach(async () => core?.cleanup())

  it('falls back to the next provider when the first is rate limited', async () => {
    core = testCore()
    const a = addFake(core, new FakeProvider('a', { fail: 'rate_limit' }), 10)
    const b = addFake(core, new FakeProvider('b', {}), 20)
    const events = await collect(core.router.chat([{ role: 'user', content: 'hi' }], { target: 'auto' }))
    expect(text(events)).toBe('hello from b')
    expect(events.some((e) => e.type === 'fallback' && e.providerId === 'a')).toBe(true)
    expect(a.calls).toBeGreaterThan(0)
    expect(b.calls).toBe(1)
  })

  it('puts a rate-limited provider on cooldown so the next request skips it', async () => {
    core = testCore()
    const a = addFake(core, new FakeProvider('a', { fail: 'rate_limit' }), 10)
    addFake(core, new FakeProvider('b', {}), 20)
    await collect(core.router.chat([{ role: 'user', content: 'hi' }], { target: 'auto' }))
    const callsAfterFirst = a.calls
    await collect(core.router.chat([{ role: 'user', content: 'again' }], { target: 'auto' }))
    expect(a.calls).toBe(callsAfterFirst)
    expect(core.router.coolingDown('a')).toBeTruthy()
  })

  it('does not fall back once text has streamed', async () => {
    core = testCore()
    addFake(core, new FakeProvider('a', { fail: 'server', failAfterText: true }), 10)
    const b = addFake(core, new FakeProvider('b', {}), 20)
    await expect(collect(core.router.chat([{ role: 'user', content: 'hi' }], { target: 'auto' }))).rejects.toThrow('broke mid-reply')
    expect(b.calls).toBe(0)
  })

  it('respects an explicit provider and only falls back when allowed', async () => {
    core = testCore()
    addFake(core, new FakeProvider('a', { fail: 'server' }), 10)
    addFake(core, new FakeProvider('b', {}), 20)
    core.store.updateSettings({ fallbackOnExplicit: false })
    await expect(collect(core.router.chat([{ role: 'user', content: 'hi' }], { target: 'a' }))).rejects.toThrow()
    core.store.updateSettings({ fallbackOnExplicit: true })
    core.router['cooling'].clear()
    const events = await collect(core.router.chat([{ role: 'user', content: 'hi' }], { target: 'a' }))
    expect(text(events)).toBe('hello from b')
  })

  it('uses the offline demo only when no real provider is ready', async () => {
    core = testCore(['mock'])
    const only = await core.router.candidates({ target: 'auto' })
    expect(only.map((c) => c.provider.id)).toEqual(['mock'])
    addFake(core, new FakeProvider('real', {}), 50)
    const withReal = await core.router.candidates({ target: 'auto' })
    expect(withReal.map((c) => c.provider.id)).toEqual(['real'])
  })

  it('throws a clear error when nothing is set up', async () => {
    core = testCore()
    await expect(collect(core.router.chat([{ role: 'user', content: 'hi' }], { target: 'auto' }))).rejects.toBeInstanceOf(NoProviderError)
  })
})
