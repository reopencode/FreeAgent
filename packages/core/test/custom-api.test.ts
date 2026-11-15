import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { normalizeBaseUrl } from '../src/providers/openai-compatible'
import { isCustomProviderId, ProviderRegistry } from '../src/providers/registry'
import type { Delta } from '../src/types'
import { testCore, type TestCore } from './helpers'

describe('normalizeBaseUrl', () => {
  it('trims, drops trailing slashes and a pasted /chat/completions path', () => {
    expect(normalizeBaseUrl('  https://api.groq.com/openai/v1/  ')).toBe('https://api.groq.com/openai/v1')
    expect(normalizeBaseUrl('https://api.example.com/v1/chat/completions')).toBe('https://api.example.com/v1')
    expect(normalizeBaseUrl('http://localhost:11434/v1/chat/completions/')).toBe('http://localhost:11434/v1')
    expect(normalizeBaseUrl('https://api.example.com')).toBe('https://api.example.com')
  })

  it('does not invent a /v1 suffix and drops query and hash', () => {
    expect(normalizeBaseUrl('https://example.com/api?x=1#top')).toBe('https://example.com/api')
  })

  it('rejects non-http URLs and garbage', () => {
    expect(() => normalizeBaseUrl('ftp://example.com/v1')).toThrow(/http/)
    expect(() => normalizeBaseUrl('localhost:11434/v1')).toThrow(/http/)
    expect(() => normalizeBaseUrl('not a url')).toThrow(/valid URL/)
    expect(() => normalizeBaseUrl('')).toThrow(/valid URL/)
  })
})

describe('custom OpenAI-compatible APIs in the registry', () => {
  let core: TestCore
  afterEach(async () => core?.cleanup())

  it('creates, lists, reloads and deletes a custom API', async () => {
    core = testCore()
    const { registry, store } = core
    const p = registry.createCustom({ name: ' Groq ', baseUrl: 'https://api.groq.com/openai/v1/', model: 'llama-3.3-70b', secret: 'sk-test' })

    expect(isCustomProviderId(p.id)).toBe(true)
    expect(p.kind).toBe('api')
    expect(p.name).toBe('Groq')
    expect(store.getProviderSettings(p.id)).toMatchObject({ enabled: true, priority: 40, hasSecret: true })
    expect(store.getProviderSettings(p.id)?.config).toEqual({ name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b' })
    expect(await p.defaultModel()).toBe('llama-3.3-70b')
    expect(await p.status()).toEqual({ state: 'ready' })

    const summary = (await registry.summaries()).find((s) => s.id === p.id)
    expect(summary).toMatchObject({ name: 'Groq', kind: 'api', hasSecret: true })
    expect(summary?.setup.fields.map((f) => f.key)).toEqual(['name', 'baseUrl', 'model', 'dailyLimit'])

    // A fresh registry on the same store picks the saved API up again.
    const reloaded = new ProviderRegistry(store, registry.dataDir)
    expect(reloaded.get(p.id)?.name).toBe('Groq')
    await reloaded.dispose()

    // Settings edits apply live, including the display name and base URL.
    store.updateProviderSettings(p.id, { config: { name: 'Groq 2', baseUrl: '' } })
    expect(p.name).toBe('Groq 2')
    expect((await p.status()).state).toBe('needs_setup')

    expect(registry.removeCustom(p.id)).toBe(true)
    expect(registry.get(p.id)).toBeUndefined()
    expect(store.getProviderSettings(p.id)).toBeUndefined()
    expect(store.listProviderIds('custom_')).toEqual([])
    expect(registry.removeCustom(p.id)).toBe(false)
  })

  it('refuses to remove built-in providers and validates input', () => {
    core = testCore()
    expect(core.registry.removeCustom('openrouter')).toBe(false)
    expect(core.registry.get('openrouter')).toBeDefined()
    expect(() => core.registry.createCustom({ name: '', baseUrl: 'https://x.test/v1' })).toThrow(/Name/)
    expect(() => core.registry.createCustom({ name: 'X', baseUrl: 'ftp://x.test' })).toThrow(/http/)
    expect(core.store.listProviderIds('custom_')).toEqual([])
  })

  it('is ready without a key and says so', async () => {
    core = testCore()
    const p = core.registry.createCustom({ name: 'Local', baseUrl: 'http://127.0.0.1:1/v1' })
    const status = await p.status()
    expect(status.state).toBe('ready')
    expect(status.message).toMatch(/without an Authorization header/)
  })
})

describe('custom API chat over HTTP', () => {
  let core: TestCore
  let server: Server | undefined
  afterEach(async () => {
    await core?.cleanup()
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
    server = undefined
  })

  async function start(handler: (body: Record<string, unknown>, auth: string | undefined) => { status: number; body: string }): Promise<string> {
    server = createServer((req, res) => {
      let raw = ''
      req.on('data', (d) => (raw += d))
      req.on('end', () => {
        if (req.url === '/v1/models') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ data: [{ id: 'first-model' }, { id: 'second-model' }] }))
          return
        }
        const out = handler(raw ? JSON.parse(raw) : {}, req.headers.authorization)
        res.writeHead(out.status, { 'content-type': out.status === 200 ? 'text/event-stream' : 'application/json' })
        res.end(out.body)
      })
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  }

  const sse = (text: string): string =>
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n` + `data: ${JSON.stringify({ usage: { prompt_tokens: 3, completion_tokens: 2 } })}\n\n` + 'data: [DONE]\n\n'

  async function collect(it: AsyncIterable<Delta>): Promise<Delta[]> {
    const out: Delta[] = []
    for await (const d of it) out.push(d)
    return out
  }

  it('retries once without stream_options when the endpoint answers 400', async () => {
    const bodies: Record<string, unknown>[] = []
    const base = await start((body) => {
      bodies.push(body)
      return 'stream_options' in body ? { status: 400, body: JSON.stringify({ error: { message: 'unknown field stream_options' } }) } : { status: 200, body: sse('hi there') }
    })
    core = testCore()
    const p = core.registry.createCustom({ name: 'Clone', baseUrl: `${base}/chat/completions`, model: 'm1', secret: 'sk-abc' })
    const deltas = await collect(p.chat([{ role: 'user', content: 'hello' }], {}))
    expect(deltas.filter((d) => d.type === 'text').map((d) => (d as { text: string }).text).join('')).toBe('hi there')
    expect(bodies).toHaveLength(2)
    expect(bodies[0]).toHaveProperty('stream_options')
    expect(bodies[1]).not.toHaveProperty('stream_options')
    expect(bodies[1]).toMatchObject({ model: 'm1', stream: true })
  })

  it('sends the key as a Bearer token and uses the first listed model when none is set', async () => {
    let auth: string | undefined
    let model: unknown
    const base = await start((body, a) => {
      auth = a
      model = body.model
      return { status: 200, body: sse('ok') }
    })
    core = testCore()
    const p = core.registry.createCustom({ name: 'Keyed', baseUrl: base, secret: 'sk-abc' })
    expect(await p.defaultModel()).toBe('first-model')
    await collect(p.chat([{ role: 'user', content: 'hello' }], {}))
    expect(auth).toBe('Bearer sk-abc')
    expect(model).toBe('first-model')
  })

  it('does not retry other errors', async () => {
    let calls = 0
    const base = await start(() => {
      calls++
      return { status: 429, body: JSON.stringify({ error: { message: 'slow down' } }) }
    })
    core = testCore()
    const p = core.registry.createCustom({ name: 'Busy', baseUrl: base, model: 'm1' })
    await expect(collect(p.chat([{ role: 'user', content: 'hello' }], {}))).rejects.toThrow(/429/)
    expect(calls).toBe(1)
  })
})
