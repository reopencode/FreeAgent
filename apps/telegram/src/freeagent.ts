export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** The subset of FreeAgent's AgentEvent stream the bot reacts to. */
export type StreamEvent =
  | { type: 'route'; providerId: string; model?: string }
  | { type: 'text'; text: string; replace?: boolean }
  | { type: 'error'; message: string }
  | { type: 'done'; message: { content: string } | null }

/** The subset of FreeAgent's ProviderSummary the bot needs to offer a provider choice. */
export interface ProviderInfo {
  id: string
  name: string
  enabled: boolean
  status: { state: 'ready' | 'needs_setup' | 'unavailable' | 'error'; message?: string }
}

export class NotFoundError extends Error {
  constructor(message = 'Chat not found') {
    super(message)
    this.name = 'NotFoundError'
  }
}

export class BusyError extends Error {
  constructor(message = 'This chat is already answering.') {
    super(message)
    this.name = 'BusyError'
  }
}

export interface SSEFrame {
  event: string
  data: string
}

/** Parses a Server-Sent Events byte stream into frames. */
export async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<SSEFrame> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const take = (block: string): SSEFrame | null => {
    let event = 'message'
    const data: string[] = []
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue
      const i = line.indexOf(':')
      const field = i === -1 ? line : line.slice(0, i)
      const value = i === -1 ? '' : line.slice(i + 1).replace(/^ /, '')
      if (field === 'event') event = value
      else if (field === 'data') data.push(value)
    }
    return data.length ? { event, data: data.join('\n') } : null
  }
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
      let sep: number
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const frame = take(buffer.slice(0, sep))
        buffer = buffer.slice(sep + 2)
        if (frame) yield frame
      }
    }
    buffer += decoder.decode()
    const last = take(buffer)
    if (last) yield last
  } finally {
    reader.releaseLock()
  }
}

export class FreeAgentClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchFn: FetchLike = (input, init) => fetch(input, init)
  ) {}

  private request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${this.token}`)
    if (init.body) headers.set('Content-Type', 'application/json')
    return this.fetchFn(`${this.baseUrl}${path}`, { ...init, headers })
  }

  private async fail(res: Response): Promise<never> {
    let message = `FreeAgent returned HTTP ${res.status}`
    try {
      const b = (await res.json()) as { error?: string }
      if (b.error) message = b.error
    } catch {
      // keep the status message
    }
    if (res.status === 404) throw new NotFoundError(message)
    if (res.status === 409) throw new BusyError(message)
    if (res.status === 401) throw new Error('FreeAgent rejected the token (HTTP 401). Check FREEAGENT_TOKEN.')
    throw new Error(message)
  }

  async health(): Promise<void> {
    const res = await this.fetchFn(`${this.baseUrl}/health`)
    if (!res.ok) throw new Error(`FreeAgent health check failed with HTTP ${res.status}`)
  }

  async createChat(target: string): Promise<string> {
    const res = await this.request('/api/chats', { method: 'POST', body: JSON.stringify({ mode: 'chat', target }) })
    if (!res.ok) return this.fail(res)
    return ((await res.json()) as { id: string }).id
  }

  async setTarget(chatId: string, target: string): Promise<void> {
    const res = await this.request(`/api/chats/${encodeURIComponent(chatId)}`, { method: 'PATCH', body: JSON.stringify({ target }) })
    if (!res.ok) return this.fail(res)
  }

  async listProviders(): Promise<ProviderInfo[]> {
    const res = await this.request('/api/providers')
    if (!res.ok) return this.fail(res)
    const list = (await res.json()) as ProviderInfo[]
    return list.map((p) => ({ id: p.id, name: p.name, enabled: p.enabled, status: p.status }))
  }

  async abort(chatId: string): Promise<boolean> {
    const res = await this.request(`/api/chats/${encodeURIComponent(chatId)}/abort`, { method: 'POST' })
    if (!res.ok) return this.fail(res)
    return ((await res.json()) as { ok: boolean }).ok
  }

  /** Sends a user message in chat mode and streams the reply events. Throws NotFoundError or BusyError on 404 or 409. */
  async sendMessage(chatId: string, content: string, onEvent: (ev: StreamEvent) => void, signal?: AbortSignal): Promise<void> {
    const res = await this.request(`/api/chats/${encodeURIComponent(chatId)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content, mode: 'chat' }),
      signal
    })
    if (!res.ok) return this.fail(res)
    if (!res.body) throw new Error('FreeAgent returned an empty stream')
    for await (const frame of parseSSE(res.body)) {
      let ev: StreamEvent
      try {
        ev = JSON.parse(frame.data) as StreamEvent
      } catch {
        continue
      }
      if (ev.type === 'route' || ev.type === 'text' || ev.type === 'error' || ev.type === 'done') onEvent(ev)
    }
  }
}
