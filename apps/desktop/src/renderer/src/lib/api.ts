import type { AgentEvent, ChatMode } from '@core/api-types'

export interface Conn {
  baseUrl: string
  token: string
  dataDir?: string
}

let conn: Conn | null = null

export function setConnection(c: Conn): void {
  conn = c
}

export function connection(): Conn {
  if (!conn) throw new Error('Not connected to the FreeAgent server yet')
  return conn
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const c = connection()
  const res = await fetch(`${c.baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${c.token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  if (!res.ok) throw new ApiError(data?.error ?? `Request failed (${res.status})`, res.status)
  return data as T
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path)
}

export interface ChatStreamBody {
  content?: string
  mode?: ChatMode
  target?: string
  messageId?: string
  attachments?: { name: string; mime: string; dataBase64: string }[]
}

/** POSTs JSON and calls `onEvent` for each server-sent event until the reply is done. */
export async function streamSse(path: string, body: unknown, onEvent: (ev: AgentEvent) => void, signal?: AbortSignal): Promise<void> {
  const c = connection()
  const res = await fetch(`${c.baseUrl}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal
  })
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => null)
    throw new ApiError(data?.error ?? `Request failed (${res.status})`, res.status)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      const data = raw
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n')
      if (data) onEvent(JSON.parse(data) as AgentEvent)
    }
  }
}

/** Sends a chat message and calls `onEvent` for each server-sent event until the reply is done. */
export function streamMessage(chatId: string, body: ChatStreamBody, onEvent: (ev: AgentEvent) => void, signal?: AbortSignal): Promise<void> {
  return streamSse(`/api/chats/${chatId}/messages`, body, onEvent, signal)
}

export function streamEdit(chatId: string, body: ChatStreamBody, onEvent: (ev: AgentEvent) => void, signal?: AbortSignal): Promise<void> {
  return streamSse(`/api/chats/${chatId}/edit`, body, onEvent, signal)
}

export function streamRegenerate(chatId: string, body: ChatStreamBody, onEvent: (ev: AgentEvent) => void, signal?: AbortSignal): Promise<void> {
  return streamSse(`/api/chats/${chatId}/regenerate`, body, onEvent, signal)
}
