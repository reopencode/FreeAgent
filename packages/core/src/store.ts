import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  AgentEvent,
  AppSettings,
  Automation,
  AutomationRun,
  Chat,
  ChatMode,
  McpServerConfig,
  MessageMeta,
  Project,
  ProjectFile,
  ProviderSettings,
  RunStatus,
  StoredMessage
} from './api-types'
import { Secrets } from './secrets'
import { id, now, safeJson, today } from './util'

type Row = Record<string, SQLInputValue>

const MIGRATIONS: string[] = [
  `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    instructions TEXT NOT NULL DEFAULT '',
    workspace_dir TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE project_files (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE chats (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'chat',
    target TEXT NOT NULL DEFAULT 'auto',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX chats_updated ON chats(updated_at DESC);
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    tool_calls TEXT,
    tool_call_id TEXT,
    meta TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX messages_chat ON messages(chat_id, created_at);
  CREATE TABLE automations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    schedule TEXT,
    mode TEXT NOT NULL DEFAULT 'agent',
    target TEXT NOT NULL DEFAULT 'auto',
    enabled INTEGER NOT NULL DEFAULT 1,
    last_run_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    output TEXT NOT NULL DEFAULT '',
    log TEXT NOT NULL DEFAULT '[]',
    error TEXT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER
  );
  CREATE INDEX runs_automation ON runs(automation_id, started_at DESC);
  CREATE TABLE providers (
    id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 1,
    priority INTEGER NOT NULL DEFAULT 100,
    config TEXT NOT NULL DEFAULT '{}',
    secret TEXT
  );
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE usage (
    provider_id TEXT NOT NULL,
    day TEXT NOT NULL,
    requests INTEGER NOT NULL DEFAULT 0,
    errors INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (provider_id, day)
  );
  CREATE TABLE mcp_servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    transport TEXT NOT NULL,
    command TEXT,
    args TEXT NOT NULL DEFAULT '[]',
    url TEXT,
    env TEXT,
    enabled INTEGER NOT NULL DEFAULT 1
  );
  `
]

export const DEFAULT_SETTINGS: AppSettings = {
  systemPrompt:
    'You are FreeAgent, a capable assistant running on the user\'s desktop. Be direct and accurate. When tools are available, use them to get real results instead of guessing, and say what you did.',
  theme: 'system',
  autoApprove: false,
  fallbackOnExplicit: true,
  councilSize: 3,
  showBrowser: false,
  maxAgentSteps: 12,
  webPlainText: true
}

export class Store {
  readonly db: DatabaseSync
  readonly secrets: Secrets

  constructor(file: string, secrets: Secrets) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    this.secrets = secrets
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
    this.migrate()
  }

  private migrate(): void {
    const current = Number((this.db.prepare('PRAGMA user_version').get() as Row).user_version)
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.db.exec('BEGIN')
      try {
        this.db.exec(MIGRATIONS[v])
        this.db.exec(`PRAGMA user_version = ${v + 1}`)
        this.db.exec('COMMIT')
      } catch (err) {
        this.db.exec('ROLLBACK')
        throw err
      }
    }
  }

  private all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[]
  }

  private get(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined
  }

  private run(sql: string, ...params: SQLInputValue[]): void {
    this.db.prepare(sql).run(...params)
  }

  // Projects

  listProjects(): Project[] {
    return this.all('SELECT * FROM projects ORDER BY updated_at DESC').map(toProject)
  }

  getProject(projectId: string): Project | undefined {
    const row = this.get('SELECT * FROM projects WHERE id = ?', projectId)
    return row ? toProject(row) : undefined
  }

  createProject(input: Partial<Project> & { name: string }): Project {
    const t = now()
    const p: Project = {
      id: id('prj_'),
      name: input.name,
      description: input.description ?? '',
      instructions: input.instructions ?? '',
      workspaceDir: input.workspaceDir ?? null,
      createdAt: t,
      updatedAt: t
    }
    this.run(
      'INSERT INTO projects (id, name, description, instructions, workspace_dir, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      p.id,
      p.name,
      p.description,
      p.instructions,
      p.workspaceDir,
      t,
      t
    )
    return p
  }

  updateProject(projectId: string, patch: Partial<Project>): Project | undefined {
    const p = this.getProject(projectId)
    if (!p) return undefined
    const next = { ...p, ...patch, id: p.id, updatedAt: now() }
    this.run(
      'UPDATE projects SET name = ?, description = ?, instructions = ?, workspace_dir = ?, updated_at = ? WHERE id = ?',
      next.name,
      next.description,
      next.instructions,
      next.workspaceDir,
      next.updatedAt,
      p.id
    )
    return next
  }

  deleteProject(projectId: string): void {
    this.run('DELETE FROM projects WHERE id = ?', projectId)
  }

  listProjectFiles(projectId: string): ProjectFile[] {
    return this.all('SELECT * FROM project_files WHERE project_id = ? ORDER BY created_at', projectId).map(toProjectFile)
  }

  addProjectFile(projectId: string, name: string, content: string): ProjectFile {
    const f = { id: id('pf_'), projectId, name, content, size: content.length, createdAt: now() }
    this.run('INSERT INTO project_files (id, project_id, name, content, created_at) VALUES (?, ?, ?, ?, ?)', f.id, projectId, name, content, f.createdAt)
    this.run('UPDATE projects SET updated_at = ? WHERE id = ?', f.createdAt, projectId)
    return f
  }

  deleteProjectFile(fileId: string): void {
    this.run('DELETE FROM project_files WHERE id = ?', fileId)
  }

  // Chats and messages

  listChats(opts: { projectId?: string; limit?: number; query?: string } = {}): Chat[] {
    const where: string[] = []
    const params: SQLInputValue[] = []
    if (opts.projectId) {
      where.push('project_id = ?')
      params.push(opts.projectId)
    }
    if (opts.query) {
      where.push('title LIKE ?')
      params.push(`%${opts.query}%`)
    }
    const sql = `SELECT * FROM chats ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY updated_at DESC LIMIT ?`
    return this.all(sql, ...params, opts.limit ?? 100).map(toChat)
  }

  getChat(chatId: string): Chat | undefined {
    const row = this.get('SELECT * FROM chats WHERE id = ?', chatId)
    return row ? toChat(row) : undefined
  }

  createChat(input: { title?: string; projectId?: string | null; mode?: ChatMode; target?: string }): Chat {
    const t = now()
    const c: Chat = {
      id: id('chat_'),
      projectId: input.projectId ?? null,
      title: input.title || 'New chat',
      mode: input.mode ?? 'chat',
      target: input.target ?? 'auto',
      createdAt: t,
      updatedAt: t
    }
    this.run(
      'INSERT INTO chats (id, project_id, title, mode, target, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      c.id,
      c.projectId,
      c.title,
      c.mode,
      c.target,
      t,
      t
    )
    return c
  }

  updateChat(chatId: string, patch: Partial<Pick<Chat, 'title' | 'mode' | 'target' | 'projectId'>>): Chat | undefined {
    const c = this.getChat(chatId)
    if (!c) return undefined
    const next = { ...c, ...patch, updatedAt: now() }
    this.run(
      'UPDATE chats SET title = ?, mode = ?, target = ?, project_id = ?, updated_at = ? WHERE id = ?',
      next.title,
      next.mode,
      next.target,
      next.projectId,
      next.updatedAt,
      c.id
    )
    return next
  }

  deleteChat(chatId: string): void {
    this.run('DELETE FROM chats WHERE id = ?', chatId)
  }

  listMessages(chatId: string): StoredMessage[] {
    return this.all('SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at, rowid', chatId).map(toMessage)
  }

  addMessage(input: Omit<StoredMessage, 'id' | 'createdAt' | 'meta' | 'toolCalls' | 'toolCallId'> & Partial<StoredMessage>): StoredMessage {
    const m: StoredMessage = {
      id: id('msg_'),
      chatId: input.chatId,
      role: input.role,
      content: input.content,
      toolCalls: input.toolCalls ?? null,
      toolCallId: input.toolCallId ?? null,
      meta: input.meta ?? {},
      createdAt: now()
    }
    this.run(
      'INSERT INTO messages (id, chat_id, role, content, tool_calls, tool_call_id, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      m.id,
      m.chatId,
      m.role,
      m.content,
      m.toolCalls ? JSON.stringify(m.toolCalls) : null,
      m.toolCallId,
      JSON.stringify(m.meta),
      m.createdAt
    )
    this.run('UPDATE chats SET updated_at = ? WHERE id = ?', m.createdAt, m.chatId)
    return m
  }

  updateMessageMeta(messageId: string, meta: MessageMeta): void {
    this.run('UPDATE messages SET meta = ? WHERE id = ?', JSON.stringify(meta), messageId)
  }

  // Automations and runs

  listAutomations(): Automation[] {
    return this.all('SELECT * FROM automations ORDER BY created_at DESC').map(toAutomation)
  }

  getAutomation(automationId: string): Automation | undefined {
    const row = this.get('SELECT * FROM automations WHERE id = ?', automationId)
    return row ? toAutomation(row) : undefined
  }

  createAutomation(input: Partial<Automation> & { name: string; prompt: string }): Automation {
    const a: Automation = {
      id: id('auto_'),
      name: input.name,
      prompt: input.prompt,
      projectId: input.projectId ?? null,
      schedule: input.schedule ?? null,
      mode: input.mode ?? 'agent',
      target: input.target ?? 'auto',
      enabled: input.enabled ?? true,
      lastRunAt: null,
      nextRunAt: null,
      createdAt: now()
    }
    this.run(
      'INSERT INTO automations (id, name, prompt, project_id, schedule, mode, target, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      a.id,
      a.name,
      a.prompt,
      a.projectId,
      a.schedule,
      a.mode,
      a.target,
      a.enabled ? 1 : 0,
      a.createdAt
    )
    return a
  }

  updateAutomation(automationId: string, patch: Partial<Automation>): Automation | undefined {
    const a = this.getAutomation(automationId)
    if (!a) return undefined
    const next = { ...a, ...patch, id: a.id }
    this.run(
      'UPDATE automations SET name = ?, prompt = ?, project_id = ?, schedule = ?, mode = ?, target = ?, enabled = ?, last_run_at = ? WHERE id = ?',
      next.name,
      next.prompt,
      next.projectId,
      next.schedule,
      next.mode,
      next.target,
      next.enabled ? 1 : 0,
      next.lastRunAt,
      a.id
    )
    return next
  }

  deleteAutomation(automationId: string): void {
    this.run('DELETE FROM automations WHERE id = ?', automationId)
  }

  listRuns(automationId: string, limit = 30): AutomationRun[] {
    return this.all('SELECT * FROM runs WHERE automation_id = ? ORDER BY started_at DESC LIMIT ?', automationId, limit).map(toRun)
  }

  getRun(runId: string): AutomationRun | undefined {
    const row = this.get('SELECT * FROM runs WHERE id = ?', runId)
    return row ? toRun(row) : undefined
  }

  startRun(automationId: string): AutomationRun {
    const r: AutomationRun = { id: id('run_'), automationId, status: 'running', output: '', log: [], error: null, startedAt: now(), finishedAt: null }
    this.run('INSERT INTO runs (id, automation_id, status, started_at) VALUES (?, ?, ?, ?)', r.id, automationId, r.status, r.startedAt)
    this.run('UPDATE automations SET last_run_at = ? WHERE id = ?', r.startedAt, automationId)
    return r
  }

  finishRun(runId: string, result: { status: RunStatus; output: string; log: AgentEvent[]; error?: string | null }): void {
    this.run(
      'UPDATE runs SET status = ?, output = ?, log = ?, error = ?, finished_at = ? WHERE id = ?',
      result.status,
      result.output,
      JSON.stringify(result.log),
      result.error ?? null,
      now(),
      runId
    )
  }

  // Providers

  getProviderSettings(providerId: string): ProviderSettings | undefined {
    const row = this.get('SELECT * FROM providers WHERE id = ?', providerId)
    if (!row) return undefined
    return { id: String(row.id), enabled: !!row.enabled, priority: Number(row.priority), config: safeJson(row.config as string, {}), hasSecret: !!row.secret }
  }

  ensureProvider(providerId: string, defaults: { enabled: boolean; priority: number }): ProviderSettings {
    const existing = this.getProviderSettings(providerId)
    if (existing) return existing
    this.run('INSERT INTO providers (id, enabled, priority) VALUES (?, ?, ?)', providerId, defaults.enabled ? 1 : 0, defaults.priority)
    return this.getProviderSettings(providerId)!
  }

  updateProviderSettings(providerId: string, patch: { enabled?: boolean; priority?: number; config?: Record<string, unknown> }): ProviderSettings {
    const cur = this.ensureProvider(providerId, { enabled: true, priority: 100 })
    const next = { ...cur, ...patch, config: patch.config ? { ...cur.config, ...patch.config } : cur.config }
    this.run('UPDATE providers SET enabled = ?, priority = ?, config = ? WHERE id = ?', next.enabled ? 1 : 0, next.priority, JSON.stringify(next.config), providerId)
    return this.getProviderSettings(providerId)!
  }

  /** Ids of stored providers that start with `prefix` (compared literally, so `_` is not a wildcard). */
  listProviderIds(prefix: string): string[] {
    return this.all('SELECT id FROM providers WHERE substr(id, 1, ?) = ? ORDER BY rowid', prefix.length, prefix).map((r) => String(r.id))
  }

  deleteProvider(providerId: string): void {
    this.run('DELETE FROM providers WHERE id = ?', providerId)
    this.run('DELETE FROM usage WHERE provider_id = ?', providerId)
  }

  setProviderSecret(providerId: string, secret: string | null): void {
    this.ensureProvider(providerId, { enabled: true, priority: 100 })
    this.run('UPDATE providers SET secret = ? WHERE id = ?', secret ? this.secrets.encrypt(secret) : null, providerId)
  }

  getProviderSecret(providerId: string): string | undefined {
    const row = this.get('SELECT secret FROM providers WHERE id = ?', providerId)
    if (!row?.secret) return undefined
    try {
      return this.secrets.decrypt(String(row.secret))
    } catch {
      return undefined
    }
  }

  // Settings

  getSettings(): AppSettings {
    const rows = this.all('SELECT key, value FROM settings')
    const out: Record<string, unknown> = { ...DEFAULT_SETTINGS }
    for (const r of rows) out[String(r.key)] = safeJson(String(r.value), null)
    return out as unknown as AppSettings
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in DEFAULT_SETTINGS) || v === undefined) continue
      this.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, JSON.stringify(v))
    }
    return this.getSettings()
  }

  // Usage

  recordUsage(providerId: string, u: { ok: boolean; inputTokens?: number; outputTokens?: number }): void {
    this.run(
      `INSERT INTO usage (provider_id, day, requests, errors, input_tokens, output_tokens) VALUES (?, ?, 1, ?, ?, ?)
       ON CONFLICT(provider_id, day) DO UPDATE SET requests = requests + 1, errors = errors + excluded.errors,
       input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens`,
      providerId,
      today(),
      u.ok ? 0 : 1,
      u.inputTokens ?? 0,
      u.outputTokens ?? 0
    )
  }

  usageToday(providerId: string): { requests: number; errors: number; inputTokens: number; outputTokens: number } {
    const row = this.get('SELECT * FROM usage WHERE provider_id = ? AND day = ?', providerId, today())
    return {
      requests: Number(row?.requests ?? 0),
      errors: Number(row?.errors ?? 0),
      inputTokens: Number(row?.input_tokens ?? 0),
      outputTokens: Number(row?.output_tokens ?? 0)
    }
  }

  // MCP servers

  listMcpServers(): McpServerConfig[] {
    return this.all('SELECT * FROM mcp_servers ORDER BY name').map(toMcp)
  }

  getMcpEnv(serverId: string): Record<string, string> {
    const row = this.get('SELECT env FROM mcp_servers WHERE id = ?', serverId)
    if (!row?.env) return {}
    try {
      return safeJson(this.secrets.decrypt(String(row.env)), {})
    } catch {
      return {}
    }
  }

  upsertMcpServer(input: Partial<McpServerConfig> & { name: string; transport: 'stdio' | 'http'; env?: Record<string, string> }): McpServerConfig {
    const serverId = input.id ?? id('mcp_')
    const env = input.env && Object.keys(input.env).length ? this.secrets.encrypt(JSON.stringify(input.env)) : null
    const existing = this.get('SELECT env FROM mcp_servers WHERE id = ?', serverId)
    this.run(
      `INSERT INTO mcp_servers (id, name, transport, command, args, url, env, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, transport = excluded.transport, command = excluded.command,
       args = excluded.args, url = excluded.url, env = excluded.env, enabled = excluded.enabled`,
      serverId,
      input.name,
      input.transport,
      input.command ?? null,
      JSON.stringify(input.args ?? []),
      input.url ?? null,
      input.env === undefined ? ((existing?.env as string | null) ?? null) : env,
      input.enabled === false ? 0 : 1
    )
    return this.listMcpServers().find((s) => s.id === serverId)!
  }

  deleteMcpServer(serverId: string): void {
    this.run('DELETE FROM mcp_servers WHERE id = ?', serverId)
  }

  close(): void {
    this.db.close()
  }
}

function toProject(r: Row): Project {
  return {
    id: String(r.id),
    name: String(r.name),
    description: String(r.description ?? ''),
    instructions: String(r.instructions ?? ''),
    workspaceDir: (r.workspace_dir as string | null) ?? null,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at)
  }
}

function toProjectFile(r: Row): ProjectFile {
  const content = String(r.content)
  return { id: String(r.id), projectId: String(r.project_id), name: String(r.name), content, size: content.length, createdAt: Number(r.created_at) }
}

function toChat(r: Row): Chat {
  return {
    id: String(r.id),
    projectId: (r.project_id as string | null) ?? null,
    title: String(r.title),
    mode: String(r.mode) as ChatMode,
    target: String(r.target),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at)
  }
}

function toMessage(r: Row): StoredMessage {
  return {
    id: String(r.id),
    chatId: String(r.chat_id),
    role: String(r.role) as StoredMessage['role'],
    content: String(r.content),
    toolCalls: safeJson(r.tool_calls as string | null, null),
    toolCallId: (r.tool_call_id as string | null) ?? null,
    meta: safeJson(r.meta as string, {}),
    createdAt: Number(r.created_at)
  }
}

function toAutomation(r: Row): Automation {
  return {
    id: String(r.id),
    name: String(r.name),
    prompt: String(r.prompt),
    projectId: (r.project_id as string | null) ?? null,
    schedule: (r.schedule as string | null) ?? null,
    mode: String(r.mode) as ChatMode,
    target: String(r.target),
    enabled: !!r.enabled,
    lastRunAt: r.last_run_at == null ? null : Number(r.last_run_at),
    nextRunAt: null,
    createdAt: Number(r.created_at)
  }
}

function toRun(r: Row): AutomationRun {
  return {
    id: String(r.id),
    automationId: String(r.automation_id),
    status: String(r.status) as RunStatus,
    output: String(r.output ?? ''),
    log: safeJson(r.log as string, []),
    error: (r.error as string | null) ?? null,
    startedAt: Number(r.started_at),
    finishedAt: r.finished_at == null ? null : Number(r.finished_at)
  }
}

function toMcp(r: Row): McpServerConfig {
  return {
    id: String(r.id),
    name: String(r.name),
    transport: String(r.transport) as 'stdio' | 'http',
    command: (r.command as string | null) ?? null,
    args: safeJson(r.args as string, []),
    url: (r.url as string | null) ?? null,
    enabled: !!r.enabled,
    hasEnv: !!r.env
  }
}
