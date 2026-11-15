import { afterEach, describe, expect, it } from 'vitest'
import { testCore, type TestCore } from '../../../packages/core/test/helpers'
import { createApp } from '../src/app'
import { Scheduler } from '../src/scheduler'

describe('custom API routes', () => {
  let core: TestCore
  afterEach(async () => core?.cleanup())

  function setup() {
    core = testCore()
    const cfg = { host: '127.0.0.1', port: 0, dataDir: core.registry.dataDir, token: 'tok', version: 'test' }
    const app = createApp(core, cfg, new Scheduler(core))
    const call = (method: string, path: string, body?: unknown) =>
      app.request(path, {
        method,
        headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
      })
    return { call }
  }

  it('adds, lists and removes a custom API', async () => {
    const { call } = setup()
    const created = await call('POST', '/api/providers/custom', { name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1/', model: 'llama', secret: 'sk-1' })
    expect(created.status).toBe(201)
    const summary = (await created.json()) as { id: string; name: string; kind: string; hasSecret: boolean }
    expect(summary).toMatchObject({ name: 'Groq', kind: 'api', hasSecret: true })
    expect(summary.id.startsWith('custom_')).toBe(true)

    const list = (await (await call('GET', '/api/providers')).json()) as { id: string }[]
    expect(list.some((p) => p.id === summary.id)).toBe(true)

    const patched = await call('PATCH', `/api/providers/${summary.id}`, { config: { name: 'Groq Cloud' } })
    expect(((await patched.json()) as { name: string }).name).toBe('Groq Cloud')

    expect((await call('DELETE', `/api/providers/${summary.id}`)).status).toBe(200)
    const after = (await (await call('GET', '/api/providers')).json()) as { id: string }[]
    expect(after.some((p) => p.id === summary.id)).toBe(false)
    expect((await call('DELETE', `/api/providers/${summary.id}`)).status).toBe(404)
  })

  it('rejects bad input and built-in providers', async () => {
    const { call } = setup()
    const noName = await call('POST', '/api/providers/custom', { name: ' ', baseUrl: 'https://x.test/v1' })
    expect(noName.status).toBe(400)
    const badUrl = await call('POST', '/api/providers/custom', { name: 'X', baseUrl: 'ftp://x.test' })
    expect(badUrl.status).toBe(400)
    expect(((await badUrl.json()) as { error: string }).error).toMatch(/http/)
    expect((await call('DELETE', '/api/providers/openrouter')).status).toBe(400)
    expect((await call('POST', '/api/providers/custom', { name: 'X', baseUrl: 'https://x.test' })).status).toBe(201)
  })

  it('requires the token', async () => {
    const { call } = setup()
    const app = createApp(core, { host: '127.0.0.1', port: 0, dataDir: core.registry.dataDir, token: 'tok', version: 'test' }, new Scheduler(core))
    expect((await app.request('/api/providers/custom', { method: 'POST', body: '{}' })).status).toBe(401)
    expect((await call('GET', '/api/providers')).status).toBe(200)
  })
})
