import { afterEach, describe, expect, it } from 'vitest'
import { saveChatMedia } from '../../../packages/core/src/media'
import { testCore, type TestCore } from '../../../packages/core/test/helpers'
import { createApp } from '../src/app'
import { Scheduler } from '../src/scheduler'

describe('chat search, export and media routes', () => {
  let core: TestCore
  afterEach(async () => core?.cleanup())

  function setup() {
    core = testCore()
    const cfg = { host: '127.0.0.1', port: 0, dataDir: core.dataDir, token: 'tok', version: 'test' }
    const app = createApp(core, cfg, new Scheduler(core))
    const call = (method: string, path: string) => app.request(path, { method, headers: { authorization: 'Bearer tok' } })
    return { call }
  }

  it('searches message text and exports markdown', async () => {
    const { call } = setup()
    const chat = core.store.createChat({ title: 'Notes' })
    core.store.addMessage({ chatId: chat.id, role: 'user', content: 'bananas' })
    const list = (await (await call('GET', '/api/chats?q=banana')).json()) as { id: string }[]
    expect(list.map((c) => c.id)).toContain(chat.id)
    const exp = await call('GET', `/api/chats/${chat.id}/export`)
    expect(exp.status).toBe(200)
    expect(exp.headers.get('content-type')).toContain('text/markdown')
    expect(await exp.text()).toContain('bananas')
  })

  it('serves a saved attachment', async () => {
    const { call } = setup()
    const chat = core.store.createChat({ title: 'Pic' })
    const att = saveChatMedia(core.dataDir, chat.id, { name: 'a.png', mime: 'image/png', kind: 'image', data: Buffer.from('hi') })
    core.store.addMessage({ chatId: chat.id, role: 'user', content: 'see', attachments: [att] })
    const res = await call('GET', `/api/media/${chat.id}/${att.id}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('image/png')
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('hi')
    expect((await call('GET', `/api/media/${chat.id}/med_missing`)).status).toBe(404)
  })
})
