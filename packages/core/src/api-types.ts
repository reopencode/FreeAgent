// Plain data types shared by the server and the desktop renderer. Keep this file free of Node imports.

export type ChatMode = 'chat' | 'agent' | 'council'

export interface Project {
  id: string
  name: string
  description: string
  instructions: string
  workspaceDir: string | null
  /** Plugin ids turned on for every chat in this project, unless a chat sets its own list. */
  enabledPlugins: string[]
  createdAt: number
  updatedAt: number
}

export interface ProjectFile {
  id: string
  projectId: string
  name: string
  content: string
  size: number
  createdAt: number
}

export interface Chat {
  id: string
  projectId: string | null
  title: string
  mode: ChatMode
  target: string
  /** `null` uses the project's enabled plugins. An array replaces that set for this chat. */
  pluginIds: string[] | null
  createdAt: number
  updatedAt: number
}

export interface RouteAttempt {
  providerId: string
  model?: string
  error?: string
}

export interface AgentTask {
  id: string
  title: string
  status: 'pending' | 'running' | 'done'
}

export interface ToolStep {
  id: string
  name: string
  args: string
  output?: string
  ok?: boolean
  status: 'pending_approval' | 'running' | 'done' | 'denied' | 'error'
}

export interface CouncilAnswer {
  providerId: string
  model?: string
  text: string
  error?: string
}

export interface MessageMeta {
  providerId?: string
  model?: string
  attempts?: RouteAttempt[]
  steps?: ToolStep[]
  tasks?: AgentTask[]
  council?: CouncilAnswer[]
  error?: string
  durationMs?: number
}

export type AttachmentKind = 'image' | 'audio' | 'file'

/** A file saved next to a chat. The bytes live under `chat-media/`, not in SQLite. */
export interface Attachment {
  id: string
  kind: AttachmentKind
  name: string
  mime: string
  bytes: number
}

/** Attachment payload on a message POST. The server writes it to disk and stores {@link Attachment}. */
export interface IncomingAttachment {
  name: string
  mime: string
  dataBase64: string
}

export interface StoredMessage {
  id: string
  chatId: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  toolCalls: { id: string; name: string; arguments: string }[] | null
  toolCallId: string | null
  attachments?: Attachment[]
  meta: MessageMeta
  createdAt: number
}

export interface Automation {
  id: string
  name: string
  prompt: string
  projectId: string | null
  schedule: string | null
  mode: ChatMode
  target: string
  enabled: boolean
  lastRunAt: number | null
  nextRunAt: number | null
  createdAt: number
}

export type RunStatus = 'running' | 'success' | 'error'

export interface AutomationRun {
  id: string
  automationId: string
  status: RunStatus
  output: string
  log: AgentEvent[]
  error: string | null
  startedAt: number
  finishedAt: number | null
}

export interface ProviderSettings {
  id: string
  enabled: boolean
  priority: number
  config: Record<string, unknown>
  hasSecret: boolean
}

export interface ProviderSummary {
  id: string
  name: string
  kind: 'api' | 'web' | 'app'
  description: string
  experimental: boolean
  supportsTools: boolean
  tags: string[]
  enabled: boolean
  priority: number
  status: { state: 'ready' | 'needs_setup' | 'unavailable' | 'error'; message?: string }
  config: Record<string, unknown>
  hasSecret: boolean
  usageToday: { requests: number; errors: number; inputTokens: number; outputTokens: number }
  dailyLimit: number | null
  setup: ProviderSetupInfo
}

export interface ProviderSetupInfo {
  keyUrl?: string
  docsUrl?: string
  secretLabel?: string
  secretOptional?: boolean
  fields: { key: string; label: string; placeholder?: string; type?: 'text' | 'number' | 'boolean' }[]
  loginHint?: string
}

export interface ModelOption {
  providerId: string
  id: string
  name: string
  tags: string[]
}

export interface McpServerConfig {
  id: string
  name: string
  transport: 'stdio' | 'http'
  command: string | null
  args: string[]
  url: string | null
  enabled: boolean
  hasEnv: boolean
}

export interface SkillInfo {
  id: string
  name: string
  summary: string
  source: 'app' | 'project'
}

export interface PluginInfo {
  id: string
  name: string
  description: string
}

export interface MemoryFact {
  id: string
  text: string
  createdAt: number
}

export interface AppSettings {
  systemPrompt: string
  theme: 'system' | 'light' | 'dark'
  autoApprove: boolean
  fallbackOnExplicit: boolean
  councilSize: number
  showBrowser: boolean
  maxAgentSteps: number
  /** Provider ids that receive a short Agent-mode prompt: the current request, this run's tool results, and a one-line instruction. */
  minimalAgentProviders: string[]
}

export interface ServerInfo {
  version: string
  port: number
  dataDir: string
  token: string
  gatewayUrl: string
  mcpUrl: string
  mcpStdio: { command: string; args: string[]; env: Record<string, string> }
  claudeDesktopConfigPath: string
}

export type AgentEvent =
  | { type: 'user_message'; message: StoredMessage }
  | { type: 'route'; providerId: string; model?: string; attempt: number }
  | { type: 'fallback'; providerId: string; model?: string; error: string }
  | { type: 'text'; text: string; replace?: boolean }
  | { type: 'media'; mime: string; name?: string; base64: string }
  | { type: 'status'; message: string }
  | { type: 'step_start'; step: number }
  | { type: 'tool_call'; id: string; name: string; args: string }
  | { type: 'approval_request'; id: string; toolCallId: string; name: string; args: string; summary: string }
  | { type: 'approval_resolved'; id: string; approved: boolean }
  | { type: 'tool_result'; id: string; ok: boolean; output: string }
  | { type: 'task_list'; tasks: AgentTask[] }
  | { type: 'council_answer'; answer: CouncilAnswer }
  | { type: 'error'; message: string }
  | { type: 'done'; message: StoredMessage | null }
