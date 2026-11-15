import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Update } from 'grammy/types'
import { createBot } from '../src/bot'
import { sendWithRecovery } from '../src/chat'
import { isAllowed, loadConfig, parseAllowedIds } from '../src/config'
import { FreeAgentClient, NotFoundError, parseSSE, type StreamEvent } from '../src/freeagent'
import { splitMessage } from '../src/format'
import { LinkStore } from '../src/links'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fa-telegram-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c))
      controller.close()
    }
  })
}

describe('LinkStore', () => {
  it('persists links across instances and deletes them', () => {
    const file = join(dir, 'nested', 'links.json')
    const a = new LinkStore(file)
    a.set(42, { chatId: 'chat_1', target: 'auto' })
    expect(new LinkStore(file).get(42)).toEqual({ chatId: 'chat_1', target: 'auto' })
    a.delete(42)
    expect(new LinkStore(file).get(42)).toBeUndefined()
  })

  it('starts empty when the file is missing or corrupt', () => {
    const file = join(dir, 'links.json')
    expect(new LinkStore(file).get(1)).toBeUndefined()
    writeFileSync(file, '{not json')
    expect(new LinkStore(file).get(1)).toBeUndefined()
  })
})

describe('parseSSE', () => {
  it('parses frames split across chunks, including CRLF and multi-line data', async () => {
    const frames = []
    for await (const f of parseSSE(streamOf('event: text\ndata: {"a"', ':1}\n\n: keepalive\n\nevent: done\r\ndata: x\r\ndata: y\r\n\r\n'))) frames.push(f)
    expect(frames).toEqual([
      { event: 'text', data: '{"a":1}' },
      { event: 'done', data: 'x\ny' }
    ])
  })
})

describe('FreeAgentClient', () => {
  it('streams events and sends the bearer token with chat mode', async () => {
    let seen: { url: string; auth: string | null; body: unknown } | undefined
    const client = new FreeAgentClient('http://fa', 'tok', async (url, init) => {
      seen = { url, auth: new Headers(init?.headers).get('authorization'), body: JSON.parse(String(init?.body)) }
      return new Response(
        streamOf('event: text\ndata: {"type":"text","text":"Hi"}\n\n', 'event: user_message\ndata: {"type":"user_message"}\n\n', 'event: done\ndata: {"type":"done","message":{"content":"Hi"}}\n\n')
      )
    })
    const events: StreamEvent[] = []
    await client.sendMessage('chat_1', 'hello', (e) => events.push(e))
    expect(seen).toEqual({ url: 'http://fa/api/chats/chat_1/messages', auth: 'Bearer tok', body: { content: 'hello', mode: 'chat' } })
    expect(events.map((e) => e.type)).toEqual(['text', 'done'])
  })

  it('maps 404 to NotFoundError', async () => {
    const client = new FreeAgentClient('http://fa', 'tok', async () => Response.json({ error: 'Chat not found' }, { status: 404 }))
    await expect(client.sendMessage('x', 'hi', () => undefined)).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('sendWithRecovery', () => {
  it('creates a new chat and retries once when the linked chat was deleted', async () => {
    const links = new LinkStore(join(dir, 'links.json'))
    links.set(7, { chatId: 'old', target: 'auto-code' })
    const created: string[] = []
    const sent: string[] = []
    const client = {
      createChat: async (target: string) => {
        created.push(target)
        return 'fresh'
      },
      sendMessage: async (chatId: string) => {
        sent.push(chatId)
        if (chatId === 'old') throw new NotFoundError()
      }
    }
    await sendWithRecovery(client, links, 7, 'hi', () => undefined)
    expect(sent).toEqual(['old', 'fresh'])
    expect(created).toEqual(['auto-code'])
    expect(links.get(7)).toEqual({ chatId: 'fresh', target: 'auto-code' })
  })

  it('creates the first chat on demand', async () => {
    const links = new LinkStore(join(dir, 'links.json'))
    const client = { createChat: async () => 'c1', sendMessage: async () => undefined }
    await sendWithRecovery(client, links, 9, 'hi', () => undefined)
    expect(links.get(9)).toEqual({ chatId: 'c1', target: 'auto' })
  })
})

describe('splitMessage', () => {
  it('returns short text unchanged', () => {
    expect(splitMessage('hello')).toEqual(['hello'])
  })

  it('splits long text within the limit, preferring newlines, without losing content', () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i} ${'x'.repeat(20)}`).join('\n')
    const parts = splitMessage(text, 200)
    expect(parts.length).toBeGreaterThan(1)
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(200)
    expect(parts.join('\n')).toBe(text)
  })

  it('hard-splits text with no break points', () => {
    const parts = splitMessage('a'.repeat(25), 10)
    expect(parts.map((p) => p.length)).toEqual([10, 10, 5])
  })
})

describe('config and allowlist', () => {
  it('parses ids and rejects bad values', () => {
    expect([...parseAllowedIds('1, 2 ,3')]).toEqual([1, 2, 3])
    expect(parseAllowedIds('').size).toBe(0)
    expect(() => parseAllowedIds('abc')).toThrow(/not a numeric/)
  })

  it('denies everyone when the list is empty', () => {
    expect(isAllowed(new Set(), 1)).toBe(false)
    expect(isAllowed(new Set([1]), 1)).toBe(true)
    expect(isAllowed(new Set([1]), undefined)).toBe(false)
  })

  it('reads the FreeAgent token from the data dir', () => {
    writeFileSync(join(dir, 'token'), 'secret\n')
    const cfg = loadConfig({ TELEGRAM_BOT_TOKEN: 'bot', FREEAGENT_DATA_DIR: dir, FREEAGENT_URL: 'http://x:1/' })
    expect(cfg.freeagentToken).toBe('secret')
    expect(cfg.freeagentUrl).toBe('http://x:1')
    expect(cfg.stateFile).toBe(join(dir, 'telegram-links.json'))
    expect(() => loadConfig({})).toThrow(/TELEGRAM_BOT_TOKEN/)
  })
})

describe('bot', () => {
  interface Call {
    method: string
    payload: Record<string, unknown>
  }

  function harness(allowed: number[], client: Partial<Parameters<typeof createBot>[0]['client']> = {}) {
    const calls: Call[] = []
    const links = new LinkStore(join(dir, 'bot-links.json'))
    const bot = createBot({
      token: '123:abc',
      allowedIds: new Set(allowed),
      links,
      client: {
        createChat: async () => 'chat_1',
        setTarget: async () => undefined,
        abort: async () => true,
        listProviders: async () => [],
        sendMessage: async (_id, _text, onEvent) => {
          onEvent({ type: 'text', text: 'Hello there' })
          onEvent({ type: 'done', message: { content: 'Hello there' } })
        },
        ...client
      }
    })
    let nextId = 100
    bot.api.config.use(async (_prev, method, payload) => {
      calls.push({ method, payload: payload as Record<string, unknown> })
      return { ok: true, result: method === 'sendMessage' ? { message_id: nextId++, chat: { id: 5 }, date: 0 } : true } as never
    })
    bot.botInfo = { id: 1, is_bot: true, first_name: 'b', username: 'b', can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false } as never
    let updateId = 1
    const say = (text: string, opts: { userId?: number; chatType?: 'private' | 'group' } = {}): Promise<void> => {
      const userId = opts.userId ?? 5
      const update = {
        update_id: updateId++,
        message: {
          message_id: updateId,
          date: 0,
          chat: { id: userId, type: opts.chatType ?? 'private' },
          from: { id: userId, is_bot: false, first_name: 'u' },
          text,
          ...(text.startsWith('/') ? { entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] } : {})
        }
      } as unknown as Update
      return bot.handleUpdate(update)
    }
    const press = (data: string, userId = 5): Promise<void> =>
      bot.handleUpdate({
        update_id: updateId++,
        callback_query: {
          id: `cb${updateId}`,
          chat_instance: 'ci',
          from: { id: userId, is_bot: false, first_name: 'u' },
          data,
          message: { message_id: 50, date: 0, chat: { id: userId, type: 'private' }, text: 'Current target' }
        }
      } as unknown as Update)
    const settle = async (): Promise<void> => {
      for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5))
    }
    return { bot, calls, links, say, press, settle }
  }

  it('rejects users outside the allowlist without touching FreeAgent', async () => {
    let created = 0
    const h = harness([], { createChat: async () => (created++, 'x') })
    await h.say('hello')
    expect(created).toBe(0)
    expect(h.calls).toHaveLength(1)
    expect(String(h.calls[0].payload.text)).toContain('TELEGRAM_ALLOWED_IDS')
  })

  it('ignores group chats', async () => {
    const h = harness([5])
    await h.say('hello', { chatType: 'group' })
    expect(h.calls).toHaveLength(0)
  })

  it('answers a message by editing the placeholder with the final reply and links the chat', async () => {
    const h = harness([5])
    await h.say('hi')
    await h.settle()
    const methods = h.calls.map((c) => c.method)
    expect(methods).toContain('sendMessage')
    const edit = h.calls.filter((c) => c.method === 'editMessageText').at(-1)
    expect(edit?.payload.text).toBe('Hello there')
    expect(h.links.get(5)).toEqual({ chatId: 'chat_1', target: 'auto' })
  })

  it('shows FreeAgent errors as the reply', async () => {
    const h = harness([5], {
      sendMessage: async () => {
        throw new Error('boom')
      }
    })
    await h.say('hi')
    await h.settle()
    expect(h.calls.filter((c) => c.method === 'editMessageText').at(-1)?.payload.text).toBe('Error: boom')
  })

  it('sets and shows the target, and /new keeps it', async () => {
    const targets: string[] = []
    const h = harness([5], { createChat: async (t) => (targets.push(t), `chat_${targets.length}`) })
    await h.say('/target auto-code')
    await h.say('/target')
    await h.say('/new')
    expect(h.links.get(5)).toEqual({ chatId: 'chat_2', target: 'auto-code' })
    const texts = h.calls.filter((c) => c.method === 'sendMessage').map((c) => String(c.payload.text))
    expect(texts).toContain('Target set to auto-code.')
    expect(texts.some((t) => t.startsWith('Current target: auto-code'))).toBe(true)
    expect(targets).toEqual(['auto', 'auto-code'])
  })

  const provider = (id: string, name: string, state: 'ready' | 'needs_setup' | 'unavailable' | 'error', enabled = true) => ({ id, name, enabled, status: { state } })

  it('offers Auto plus only enabled, ready providers on /target', async () => {
    const h = harness([5], {
      listProviders: async () => [
        provider('gemini-api', 'Gemini', 'ready'),
        provider('openrouter', 'OpenRouter', 'needs_setup'),
        provider('kiro', 'Kiro', 'ready', false),
        provider('opencode', 'OpenCode', 'ready')
      ]
    })
    await h.say('/target')
    const reply = h.calls.filter((c) => c.method === 'sendMessage').at(-1)
    expect(String(reply?.payload.text)).toBe('Current target: auto\nChoose a provider:')
    const rows = (reply?.payload.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard
    expect(rows.flat().map((b) => [b.text, b.callback_data])).toEqual([
      ['✓ Auto', 't:auto'],
      ['Gemini', 't:gemini-api'],
      ['OpenCode', 't:opencode']
    ])
  })

  it('sets the target when a provider button is pressed', async () => {
    const set: string[] = []
    const h = harness([5], {
      setTarget: async (_id, t) => void set.push(t),
      listProviders: async () => [provider('gemini-api', 'Gemini', 'ready')]
    })
    await h.say('/target')
    await h.press('t:gemini-api')
    expect(set).toEqual(['gemini-api'])
    expect(h.links.get(5)).toEqual({ chatId: 'chat_1', target: 'gemini-api' })
    expect(h.calls.find((c) => c.method === 'answerCallbackQuery')?.payload.text).toBe('Target set to gemini-api.')
    const edit = h.calls.filter((c) => c.method === 'editMessageText').at(-1)
    expect(String(edit?.payload.text)).toContain('Current target: gemini-api')
    const rows = (edit?.payload.reply_markup as { inline_keyboard: { text: string }[][] }).inline_keyboard
    expect(rows.flat().map((b) => b.text)).toEqual(['Auto', '✓ Gemini'])
  })

  it('falls back to plain target info when the provider list cannot be loaded', async () => {
    const h = harness([5], {
      listProviders: async () => {
        throw new Error('down')
      }
    })
    await h.say('/target')
    const reply = h.calls.filter((c) => c.method === 'sendMessage').at(-1)
    expect(String(reply?.payload.text)).toBe('Current target: auto\nCould not load the provider list: down')
  })

  it('refuses a second message while one is answering and lets /stop through', async () => {
    let release: () => void = () => undefined
    let aborted = 0
    const h = harness([5], {
      abort: async () => (aborted++, true),
      sendMessage: (_id, _t, onEvent) =>
        new Promise<void>((resolve) => {
          release = () => {
            onEvent({ type: 'done', message: { content: 'late' } })
            resolve()
          }
        })
    })
    await h.say('first')
    await h.settle()
    await h.say('second')
    await h.say('/stop')
    const texts = h.calls.filter((c) => c.method === 'sendMessage').map((c) => String(c.payload.text))
    expect(texts).toContain('Still answering. /stop to cancel.')
    expect(aborted).toBe(1)
    release()
    await h.settle()
    expect(h.calls.filter((c) => c.method === 'editMessageText').at(-1)?.payload.text).toBe('late')
  })

  it('replies that only text is supported for other message types', async () => {
    const h = harness([5])
    const update = {
      update_id: 99,
      message: { message_id: 9, date: 0, chat: { id: 5, type: 'private' }, from: { id: 5, is_bot: false, first_name: 'u' }, photo: [{ file_id: 'f', file_unique_id: 'u', width: 1, height: 1 }] }
    } as unknown as Update
    await h.bot.handleUpdate(update)
    expect(h.calls.map((c) => c.payload.text)).toEqual(['Text messages only for now.'])
  })
})
