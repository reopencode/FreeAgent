import { NotFoundError, type FreeAgentClient, type StreamEvent } from './freeagent'
import type { LinkStore } from './links'

export const DEFAULT_TARGET = 'auto'

/** Returns the linked FreeAgent chat id for a Telegram chat, creating and saving a link when none exists. */
export async function ensureLink(client: Pick<FreeAgentClient, 'createChat'>, links: LinkStore, telegramChatId: number): Promise<string> {
  const existing = links.get(telegramChatId)
  if (existing) return existing.chatId
  const chatId = await client.createChat(DEFAULT_TARGET)
  links.set(telegramChatId, { chatId, target: DEFAULT_TARGET })
  return chatId
}

/** Creates a fresh FreeAgent chat that keeps the previous target, and relinks the Telegram chat to it. */
export async function relink(client: Pick<FreeAgentClient, 'createChat'>, links: LinkStore, telegramChatId: number): Promise<string> {
  const target = links.get(telegramChatId)?.target ?? DEFAULT_TARGET
  const chatId = await client.createChat(target)
  links.set(telegramChatId, { chatId, target })
  return chatId
}

/**
 * Sends a message to the linked chat. When the chat was deleted in FreeAgent (404), a new chat is created and the send is retried once.
 */
export async function sendWithRecovery(
  client: Pick<FreeAgentClient, 'createChat' | 'sendMessage'>,
  links: LinkStore,
  telegramChatId: number,
  text: string,
  onEvent: (ev: StreamEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const chatId = await ensureLink(client, links, telegramChatId)
  try {
    await client.sendMessage(chatId, text, onEvent, signal)
  } catch (err) {
    if (!(err instanceof NotFoundError)) throw err
    const fresh = await relink(client, links, telegramChatId)
    await client.sendMessage(fresh, text, onEvent, signal)
  }
}
