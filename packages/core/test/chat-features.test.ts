import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentEvent } from '../src/api-types'
import { chatToMarkdown } from '../src/export-chat'
import { readChatMedia } from '../src/media'
import type { ChatMessage, ChatOptions, Delta, Provider } from '../src/types'
import { addFake, testCore, type TestCore } from './helpers'

class CaptureProvider implements Provider {
  readonly kind = 'api' as const
  readonly name = 'capture'
  readonly description = 'test'
  readonly supportsTools = true
  readonly tags = ['vision' as const, 'general' as const]
  readonly id: string
  seen: ChatMessage[][] = []
  replies: string[]

  constructor(id: string, replies: string[] = ['ok']) {
    this.id = id
    this.replies = replies
  }

  async status() {
    return { state: 'ready' as const }
  }
  async models() {
    return [{ id: 'm', name: 'm', tags: ['general' as const, 'vision' as const] }]
  }
  async defaultModel() {
    return 'm'
  }
  async *chat(messages: ChatMessage[], _opts: ChatOptions): AsyncIterable<Delta> {
    this.seen.push(messages)
    const reply = this.replies.shift() ?? 'ok'
    if (reply === 'image') yield { type: 'media', mime: 'image/png', base64: Buffer.from('png').toString('base64') }
    yield { type: 'text', text: reply === 'image' ? 'here' : reply }
  }
}

describe('chat search, export, edit and attachments', () => {
  let core: TestCore
  afterEach(async () => core?.cleanup())

  it('finds chats by title or message text and escapes LIKE wildcards', () => {
    core = testCore()
    const apples = core.store.createChat({ title: 'Apples' })
    const oranges = core.store.createChat({ title: 'Oranges' })
    core.store.addMessage({ chatId: oranges.id, role: 'user', content: 'talk about applesauce' })
    const ids = (q: string) => core.store.listChats({ query: q }).map((c) => c.id).sort()
    expect(ids('apple')).toEqual([apples.id, oranges.id].sort())
    expect(ids('100%')).toEqual([])
    core.store.addMessage({ chatId: apples.id, role: 'user', content: '100% done' })
    expect(ids('100%')).toEqual([apples.id])
  })

  it('deletes a message and everything after it', () => {
    core = testCore()
    const chat = core.store.createChat({ title: 'T' })
    const first = core.store.addMessage({ chatId: chat.id, role: 'user', content: 'one' })
    core.store.addMessage({ chatId: chat.id, role: 'assistant', content: 'two' })
    const third = core.store.addMessage({ chatId: chat.id, role: 'user', content: 'three' })
    const removed = core.store.deleteFrom(chat.id, third.id)
    expect(removed.map((m) => m.content)).toEqual(['three'])
    expect(core.store.listMessages(chat.id).map((m) => m.id)).toEqual([first.id, core.store.listMessages(chat.id)[1].id])
    expect(core.store.listMessages(chat.id).map((m) => m.content)).toEqual(['one', 'two'])
  })

  it('exports a chat as markdown', () => {
    core = testCore()
    const chat = core.store.createChat({ title: 'Notes' })
    core.store.addMessage({ chatId: chat.id, role: 'user', content: 'Hello', attachments: [{ id: 'med_x', kind: 'file', name: 'note.txt', mime: 'text/plain', bytes: 4 }] })
    core.store.addMessage({ chatId: chat.id, role: 'assistant', content: 'Hi', meta: { providerId: 'gemini-api', model: 'gemini-2.5-flash' } })
    const md = chatToMarkdown(chat, core.store.listMessages(chat.id))
    expect(md).toContain('# Notes')
    expect(md).toContain('## You')
    expect(md).toContain('Hello')
    expect(md).toContain('Attached: note.txt (file)')
    expect(md).toContain('_gemini-api · gemini-2.5-flash_')
    expect(md).toContain('Hi')
  })

  it('edits the last user message and regenerates the last reply', async () => {
    core = testCore()
    const probe = new CaptureProvider('probe', ['first', 'second', 'edited', 'again'])
    addFake(core, probe, 1)
    const chat = core.store.createChat({ target: 'probe' })
    const emit = (_ev: AgentEvent) => undefined
    await core.chats.send(chat.id, { content: 'one', emit })
    await core.chats.send(chat.id, { content: 'two', emit })
    const before = core.store.listMessages(chat.id)
    const lastUser = before.filter((m) => m.role === 'user').at(-1)!
    await expect(core.chats.edit(chat.id, before[0].id, { content: 'nope', emit })).rejects.toThrow(/last message/)
    await core.chats.edit(chat.id, lastUser.id, { content: 'edited', emit })
    const edited = core.store.listMessages(chat.id)
    expect(edited.map((m) => m.content)).toEqual(['one', 'first', 'edited', 'edited'])
    await core.chats.regenerate(chat.id, { emit })
    expect(core.store.listMessages(chat.id).map((m) => m.content)).toEqual(['one', 'first', 'edited', 'again'])
    expect(probe.seen.at(-1)?.some((m) => m.role === 'user' && m.content === 'edited')).toBe(true)
  })

  it('sends image bytes to the provider and saves generated media on the reply', async () => {
    core = testCore()
    const probe = new CaptureProvider('probe', ['image'])
    addFake(core, probe, 1)
    const chat = core.store.createChat({ target: 'probe' })
    const png = Buffer.from('png-bytes').toString('base64')
    await core.chats.send(chat.id, {
      content: 'describe this',
      attachments: [{ name: 'shot.png', mime: 'image/png', dataBase64: png }],
      emit: () => undefined
    })
    const sent = probe.seen[0].find((m) => m.role === 'user' && m.content === 'describe this')
    expect(sent?.attachments?.[0]).toMatchObject({ kind: 'image', mime: 'image/png', dataBase64: png })
    const reply = core.store.listMessages(chat.id).at(-1)!
    expect(reply.content).toBe('here')
    expect(reply.attachments?.[0].kind).toBe('image')
    expect(existsSync(join(core.dataDir, 'chat-media', chat.id, reply.attachments![0].id))).toBe(true)
    expect(readChatMedia(core.dataDir, chat.id, reply.attachments![0].id)?.toString()).toBe('png')
  })

  it('refuses audio when Gemini is not ready', async () => {
    core = testCore()
    const probe = new CaptureProvider('probe')
    addFake(core, probe, 1)
    const chat = core.store.createChat({ target: 'auto' })
    await expect(
      core.chats.send(chat.id, {
        content: '',
        attachments: [{ name: 'note.webm', mime: 'audio/webm', dataBase64: Buffer.from('abc').toString('base64') }],
        emit: () => undefined
      })
    ).rejects.toThrow(/audio/)
    expect(core.store.listMessages(chat.id)).toHaveLength(0)
  })
})
