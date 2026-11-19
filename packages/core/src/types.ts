export type Role = 'system' | 'user' | 'assistant' | 'tool'

export interface ToolCall {
  id: string
  name: string
  /** JSON-encoded arguments, as in the OpenAI chat format. */
  arguments: string
}

/** Image or audio bytes handed to an API provider. `url` is a remote image that was not downloaded. */
export interface ChatAttachment {
  kind: 'image' | 'audio' | 'file'
  name: string
  mime: string
  dataBase64?: string
  url?: string
}

export interface ChatMessage {
  role: Role
  content: string
  toolCalls?: ToolCall[]
  toolCallId?: string
  /** Tool name for `tool` messages. */
  name?: string
  attachments?: ChatAttachment[]
}

export interface JsonSchema {
  type?: string
  properties?: Record<string, unknown>
  required?: string[]
  [key: string]: unknown
}

export interface ToolSpec {
  name: string
  description: string
  parameters: JsonSchema
}

export type Delta =
  /** `replace` swaps the whole reply so far for `text` (used when a rewritten reply is not an extension of the old one). */
  | { type: 'text'; text: string; replace?: boolean }
  | { type: 'media'; mime: string; name?: string; base64: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'status'; message: string }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number }

export interface ChatOptions {
  model?: string
  tools?: ToolSpec[]
  signal?: AbortSignal
  temperature?: number
  maxTokens?: number
  /** Working directory for app providers that operate on files. */
  cwd?: string
  /** Set for the whole of one agent run. Web providers keep one site conversation open per id. */
  sessionId?: string
}

export type ProviderKind = 'api' | 'web' | 'app'

export type CapabilityTag = 'code' | 'long-context' | 'vision' | 'fast' | 'reasoning' | 'general' | 'media'

export interface ModelInfo {
  id: string
  name: string
  tags: CapabilityTag[]
  contextLength?: number
}

export type ProviderState = 'ready' | 'needs_setup' | 'unavailable' | 'error'

export interface ProviderStatus {
  state: ProviderState
  message?: string
}

export interface Provider {
  id: string
  name: string
  kind: ProviderKind
  description: string
  experimental?: boolean
  /** Native tool calling. Web providers emulate tools through text instead. */
  supportsTools: boolean
  tags: CapabilityTag[]
  models(): Promise<ModelInfo[]>
  defaultModel(): Promise<string | undefined>
  chat(messages: ChatMessage[], opts: ChatOptions): AsyncIterable<Delta>
  /** Releases anything kept open for `sessionId` (see `ChatOptions.sessionId`). */
  endSession?(sessionId: string): Promise<void>
  status(): Promise<ProviderStatus>
}

export type ProviderErrorKind =
  | 'rate_limit'
  | 'server'
  | 'timeout'
  | 'auth'
  | 'captcha'
  | 'not_logged_in'
  | 'unavailable'
  | 'bad_request'
  | 'aborted'

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind
  readonly providerId: string
  readonly status?: number

  constructor(providerId: string, kind: ProviderErrorKind, message: string, status?: number) {
    super(message)
    this.name = 'ProviderError'
    this.kind = kind
    this.providerId = providerId
    this.status = status
  }

  /** Whether the router should move on to the next provider. */
  get retryable(): boolean {
    return this.kind !== 'aborted'
  }
}

export function errorKindFromStatus(status: number): ProviderErrorKind {
  if (status === 429) return 'rate_limit'
  if (status === 401 || status === 403) return 'auth'
  if (status === 408 || status === 504) return 'timeout'
  if (status >= 500) return 'server'
  if (status === 402) return 'rate_limit'
  if (status === 404) return 'unavailable'
  return 'bad_request'
}
