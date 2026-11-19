import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Attachment, AttachmentKind, IncomingAttachment } from './api-types'
import { id } from './util'

export class AttachmentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AttachmentError'
  }
}

/** Bytes, not characters. Text files under this size are inlined into the provider prompt. */
export const TEXT_INLINE_LIMIT = 100_000

const LIMITS = { maxCount: 6, image: 8_000_000, audio: 15_000_000, file: 1_000_000 } as const
const FILE_ID = /^med_[A-Za-z0-9_-]{1,40}$/
const CHAT_ID = /^[\w-]{1,80}$/

const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'css', 'html', 'xml', 'yml', 'yaml', 'toml', 'sql', 'sh', 'log', 'svg'
])

export function attachmentKind(mime: string): AttachmentKind {
  const m = mime.toLowerCase()
  if (m.startsWith('image/')) return 'image'
  if (m.startsWith('audio/')) return 'audio'
  return 'file'
}

export function isTextAttachment(mime: string, name: string): boolean {
  const m = mime.toLowerCase()
  if (m.startsWith('text/') || m === 'application/json' || m === 'application/xml' || m === 'application/javascript') return true
  const ext = name.toLowerCase().split('.').pop() ?? ''
  return TEXT_EXT.has(ext)
}

export function safeAttachmentName(name: string): string {
  const base = name.replace(/[/\\]/g, ' ').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 120)
  return base || 'attachment'
}

/** Decodes client JSON attachments and enforces the count and size caps. */
export function parseIncomingAttachments(raw: IncomingAttachment[] | undefined): { name: string; mime: string; kind: AttachmentKind; data: Buffer }[] {
  const list = raw ?? []
  if (list.length > LIMITS.maxCount) throw new AttachmentError(`You can attach up to ${LIMITS.maxCount} files.`)
  return list.map((item) => {
    const name = typeof item?.name === 'string' ? item.name : ''
    if (!name || typeof item?.dataBase64 !== 'string' || !item.dataBase64) throw new AttachmentError('An attachment is missing its name or data.')
    if (!/^[A-Za-z0-9+/=\s]+$/.test(item.dataBase64)) throw new AttachmentError(`"${name}" is not valid file data.`)
    const data = Buffer.from(item.dataBase64, 'base64')
    if (!data.length) throw new AttachmentError(`"${name}" is empty.`)
    const mime = (item.mime || 'application/octet-stream').slice(0, 160)
    const kind = attachmentKind(mime)
    if (data.length > LIMITS[kind]) throw new AttachmentError(`"${name}" is too large.`)
    return { name: safeAttachmentName(name), mime, kind, data }
  })
}

export function chatMediaDir(dataDir: string, chatId: string): string {
  if (!CHAT_ID.test(chatId)) throw new AttachmentError('Invalid chat')
  return join(dataDir, 'chat-media', chatId)
}

export function saveChatMedia(dataDir: string, chatId: string, input: { name: string; mime: string; kind: AttachmentKind; data: Buffer }): Attachment {
  const fileId = id('med_')
  const dir = chatMediaDir(dataDir, chatId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, fileId), input.data)
  return { id: fileId, kind: input.kind, name: input.name, mime: input.mime, bytes: input.data.length }
}

export function readChatMedia(dataDir: string, chatId: string, fileId: string): Buffer | undefined {
  if (!FILE_ID.test(fileId) || !CHAT_ID.test(chatId)) return undefined
  try {
    return readFileSync(join(chatMediaDir(dataDir, chatId), fileId))
  } catch {
    return undefined
  }
}

export function removeChatFile(dataDir: string, chatId: string, fileId: string): void {
  if (!FILE_ID.test(fileId) || !CHAT_ID.test(chatId)) return
  rmSync(join(chatMediaDir(dataDir, chatId), fileId), { force: true })
}

export function removeChatMedia(dataDir: string, chatId: string): void {
  if (!CHAT_ID.test(chatId)) return
  rmSync(chatMediaDir(dataDir, chatId), { recursive: true, force: true })
}
