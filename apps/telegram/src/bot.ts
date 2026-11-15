import { Bot, InlineKeyboard, type Context } from 'grammy'
import { DEFAULT_TARGET, ensureLink, relink, sendWithRecovery } from './chat'
import { isAllowed } from './config'
import { BusyError, NotFoundError, type FreeAgentClient, type ProviderInfo, type StreamEvent } from './freeagent'
import { TELEGRAM_LIMIT, splitMessage } from './format'
import type { LinkStore } from './links'

const EDIT_INTERVAL_MS = 1000
const TARGET_PATTERN = /^[\w.:/@+-]{1,200}$/
const TARGET_CALLBACK = 't:'

export const COMMANDS = [
  { command: 'new', description: 'Start a new conversation' },
  { command: 'stop', description: 'Stop the current reply' },
  { command: 'target', description: 'Pick the provider (default: auto)' },
  { command: 'start', description: 'Show help' }
]

const HELP = [
  'FreeAgent bot. Send a message and the reply comes from your free providers.',
  '',
  '/new - start a new conversation',
  '/stop - stop the current reply',
  '/target - pick the provider from the ready list (default: auto)',
  '/target <id> - set it directly (auto, auto-code, auto-fast, a provider id)'
].join('\n')

export interface BotDeps {
  token: string
  allowedIds: ReadonlySet<number>
  client: Pick<FreeAgentClient, 'createChat' | 'setTarget' | 'abort' | 'sendMessage' | 'listProviders'>
  links: LinkStore
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function createBot(deps: BotDeps): Bot {
  const { client, links } = deps
  const bot = new Bot(deps.token)
  const busy = new Set<number>()

  bot.use(async (ctx, next) => {
    if (ctx.chat?.type !== 'private') return
    if (!isAllowed(deps.allowedIds, ctx.from?.id)) {
      await ctx.reply(`This bot is private. To allow your account, add your Telegram user id (${ctx.from?.id}) to TELEGRAM_ALLOWED_IDS.`)
      return
    }
    await next()
  })

  bot.command('start', async (ctx) => {
    try {
      await ensureLink(client, links, ctx.chat.id)
    } catch (err) {
      await ctx.reply(`FreeAgent is not reachable: ${errorText(err)}`)
      return
    }
    await ctx.reply(HELP)
  })

  bot.command('new', async (ctx) => {
    if (busy.has(ctx.chat.id)) {
      await ctx.reply('Still answering. /stop to cancel.')
      return
    }
    try {
      await relink(client, links, ctx.chat.id)
      await ctx.reply('Started a new conversation.')
    } catch (err) {
      await ctx.reply(`Could not start a new conversation: ${errorText(err)}`)
    }
  })

  bot.command('stop', async (ctx) => {
    const link = links.get(ctx.chat.id)
    if (!link) {
      await ctx.reply('Nothing is running.')
      return
    }
    try {
      await ctx.reply((await client.abort(link.chatId)) ? 'Stopping.' : 'Nothing is running.')
    } catch (err) {
      await ctx.reply(`Could not stop: ${errorText(err)}`)
    }
  })

  async function applyTarget(telegramChatId: number, wanted: string): Promise<void> {
    const chatId = await ensureLink(client, links, telegramChatId)
    try {
      await client.setTarget(chatId, wanted)
      links.set(telegramChatId, { chatId, target: wanted })
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err
      links.set(telegramChatId, { chatId, target: wanted })
      await relink(client, links, telegramChatId)
    }
  }

  /** The target prompt: the current target plus buttons for Auto and every enabled, ready provider. */
  async function targetPrompt(telegramChatId: number): Promise<{ text: string; keyboard?: InlineKeyboard; error?: string }> {
    const current = links.get(telegramChatId)?.target ?? DEFAULT_TARGET
    const text = `Current target: ${current}`
    let providers: ProviderInfo[]
    try {
      providers = await client.listProviders()
    } catch (err) {
      return { text, error: errorText(err) }
    }
    const mark = (id: string, label: string): string => (current === id || current.split('::')[0] === id ? `✓ ${label}` : label)
    const keyboard = new InlineKeyboard().text(mark(DEFAULT_TARGET, 'Auto'), `${TARGET_CALLBACK}${DEFAULT_TARGET}`).row()
    const ready = providers.filter(
      (p) => p.enabled && p.status.state === 'ready' && p.id !== DEFAULT_TARGET && TARGET_PATTERN.test(p.id) && `${TARGET_CALLBACK}${p.id}`.length <= 64
    )
    ready.forEach((p, i) => {
      keyboard.text(mark(p.id, p.name), `${TARGET_CALLBACK}${p.id}`)
      if (i % 2 === 1) keyboard.row()
    })
    return { text: ready.length ? `${text}\nChoose a provider:` : `${text}\nNo other provider is ready yet.`, keyboard }
  }

  bot.command('target', async (ctx) => {
    const wanted = ctx.match.trim()
    if (!wanted) {
      const prompt = await targetPrompt(ctx.chat.id)
      await ctx.reply(prompt.error ? `${prompt.text}\nCould not load the provider list: ${prompt.error}` : prompt.text, { reply_markup: prompt.keyboard })
      return
    }
    if (!TARGET_PATTERN.test(wanted)) {
      await ctx.reply('That is not a valid target.')
      return
    }
    try {
      await applyTarget(ctx.chat.id, wanted)
      await ctx.reply(`Target set to ${wanted}.`)
    } catch (err) {
      await ctx.reply(`Could not set the target: ${errorText(err)}`)
    }
  })

  bot.callbackQuery(new RegExp(`^${TARGET_CALLBACK}`), async (ctx) => {
    const wanted = ctx.callbackQuery.data.slice(TARGET_CALLBACK.length)
    const telegramChatId = ctx.chat?.id
    if (telegramChatId === undefined || !TARGET_PATTERN.test(wanted)) {
      await ctx.answerCallbackQuery({ text: 'That is not a valid target.' })
      return
    }
    try {
      await applyTarget(telegramChatId, wanted)
    } catch (err) {
      await ctx.answerCallbackQuery({ text: `Could not set the target: ${errorText(err)}`, show_alert: true })
      return
    }
    await ctx.answerCallbackQuery({ text: `Target set to ${wanted}.` })
    const prompt = await targetPrompt(telegramChatId)
    await ctx.editMessageText(prompt.text, { reply_markup: prompt.keyboard }).catch(() => undefined)
  })

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text
    if (text.startsWith('/')) {
      await ctx.reply('Unknown command.\n\n' + HELP)
      return
    }
    const chatId = ctx.chat.id
    if (busy.has(chatId)) {
      await ctx.reply('Still answering. /stop to cancel.')
      return
    }
    busy.add(chatId)
    // Long polling handles updates one at a time, so the reply runs detached to keep /stop responsive.
    void answer(ctx, text).finally(() => busy.delete(chatId))
  })

  bot.on('message', (ctx) => ctx.reply('Text messages only for now.'))

  async function answer(ctx: Context, text: string): Promise<void> {
    const chatId = ctx.chat!.id
    let messageId: number
    try {
      await ctx.api.sendChatAction(chatId, 'typing').catch(() => undefined)
      messageId = (await ctx.reply('Thinking...')).message_id
    } catch {
      return
    }

    let editing: Promise<void> = Promise.resolve()
    let shown = 'Thinking...'
    const show = (t: string): void => {
      const next = t.length > TELEGRAM_LIMIT ? t.slice(0, TELEGRAM_LIMIT) : t
      if (!next || next === shown) return
      shown = next
      editing = editing.then(() => ctx.api.editMessageText(chatId, messageId, next).then(() => undefined, () => undefined))
    }

    const st = { acc: '', streamed: false, lastEdit: 0, errorMessage: null as string | null, finalContent: null as string | null, doneWithMessage: false }

    const onEvent = (ev: StreamEvent): void => {
      if (ev.type === 'route') {
        st.acc = ''
        if (!st.streamed) show(`Asking ${ev.providerId}...`)
      } else if (ev.type === 'text') {
        st.streamed = true
        st.acc = ev.replace ? ev.text : st.acc + ev.text
        const now = Date.now()
        if (now - st.lastEdit >= EDIT_INTERVAL_MS) {
          st.lastEdit = now
          show(st.acc)
        }
      } else if (ev.type === 'error') {
        st.errorMessage = ev.message
      } else if (ev.type === 'done') {
        st.doneWithMessage = !!ev.message
        st.finalContent = ev.message?.content ?? null
      }
    }

    try {
      await sendWithRecovery(client, links, chatId, text, onEvent)
    } catch (err) {
      st.errorMessage = err instanceof BusyError ? 'Still answering. /stop to cancel.' : errorText(err)
      st.finalContent = null
      st.doneWithMessage = false
      st.acc = ''
    }

    let finalText = st.finalContent?.trim() ? st.finalContent : st.acc
    if (st.errorMessage && (!finalText.trim() || !st.doneWithMessage)) {
      finalText = finalText.trim() ? `${finalText}\n\nError: ${st.errorMessage}` : `Error: ${st.errorMessage}`
    }
    if (!finalText.trim()) finalText = '(empty reply)'

    await editing
    const [first, ...rest] = splitMessage(finalText)
    if (first !== shown) await ctx.api.editMessageText(chatId, messageId, first).catch(() => undefined)
    for (const part of rest) await ctx.api.sendMessage(chatId, part).catch(() => undefined)
  }

  bot.catch((err) => console.error('Telegram bot error:', err.error))
  return bot
}
