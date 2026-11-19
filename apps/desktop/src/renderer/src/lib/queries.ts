import { QueryClient, useQuery } from '@tanstack/react-query'
import type {
  AppSettings,
  Automation,
  AutomationRun,
  Chat,
  McpServerConfig,
  ModelOption,
  Project,
  ProjectFile,
  ProviderSummary,
  ServerInfo,
  StoredMessage
} from '@core/api-types'
import { api } from './api'

export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 5_000 } }
})

export type ProjectListItem = Project & { chatCount: number; fileCount: number }
export type AutomationItem = Automation & { running: boolean }
export interface PendingApproval {
  id: string
  chatId?: string
  toolCallId: string
  name: string
  args: string
  summary: string
  createdAt: number
}

export const keys = {
  chats: ['chats'] as const,
  chat: (id: string) => ['chat', id] as const,
  projects: ['projects'] as const,
  project: (id: string) => ['project', id] as const,
  automations: ['automations'] as const,
  runs: (id: string) => ['runs', id] as const,
  providers: ['providers'] as const,
  models: ['models'] as const,
  settings: ['settings'] as const,
  info: ['info'] as const,
  mcp: ['mcp'] as const,
  approvals: ['approvals'] as const,
  claudeDesktop: ['claude-desktop'] as const,
  tools: ['tools'] as const
}

export const useChats = (query = '') =>
  useQuery({
    queryKey: [...keys.chats, query],
    queryFn: () => api.get<Chat[]>(`/api/chats?limit=60${query ? `&q=${encodeURIComponent(query)}` : ''}`)
  })
export const useChat = (id: string | undefined) =>
  useQuery({
    queryKey: keys.chat(id ?? ''),
    queryFn: () => api.get<{ chat: Chat; messages: StoredMessage[]; running: boolean }>(`/api/chats/${id}`),
    enabled: !!id
  })
export const useProjects = () => useQuery({ queryKey: keys.projects, queryFn: () => api.get<ProjectListItem[]>('/api/projects') })
export const useProject = (id: string | undefined) =>
  useQuery({
    queryKey: keys.project(id ?? ''),
    queryFn: () => api.get<{ project: Project; files: ProjectFile[]; chats: Chat[]; workspace: string }>(`/api/projects/${id}`),
    enabled: !!id
  })
export const useAutomations = () =>
  useQuery({ queryKey: keys.automations, queryFn: () => api.get<AutomationItem[]>('/api/automations'), refetchInterval: 5_000 })
export const useRuns = (id: string | undefined) =>
  useQuery({ queryKey: keys.runs(id ?? ''), queryFn: () => api.get<AutomationRun[]>(`/api/automations/${id}/runs`), enabled: !!id, refetchInterval: 4_000 })
export const useProviders = () => useQuery({ queryKey: keys.providers, queryFn: () => api.get<ProviderSummary[]>('/api/providers') })
export const useModels = () => useQuery({ queryKey: keys.models, queryFn: () => api.get<{ auto: string[]; models: ModelOption[] }>('/api/models'), staleTime: 60_000 })
export const useSettings = () => useQuery({ queryKey: keys.settings, queryFn: () => api.get<AppSettings>('/api/settings') })
export const useInfo = () => useQuery({ queryKey: keys.info, queryFn: () => api.get<ServerInfo>('/api/info'), staleTime: Infinity })
export const useMcpServers = () =>
  useQuery({
    queryKey: keys.mcp,
    queryFn: () => api.get<{ servers: McpServerConfig[]; status: Record<string, { connected: boolean; tools: string[]; error?: string }> }>('/api/mcp-servers')
  })
export const useApprovals = () => useQuery({ queryKey: keys.approvals, queryFn: () => api.get<PendingApproval[]>('/api/approvals'), refetchInterval: 3_000 })
export const useClaudeDesktop = () =>
  useQuery({
    queryKey: keys.claudeDesktop,
    queryFn: () => api.get<{ linked: boolean; configPath: string; entry: { command: string; args: string[]; env: Record<string, string> } }>('/api/integrations/claude-desktop')
  })
export const useTools = () =>
  useQuery({ queryKey: keys.tools, queryFn: () => api.get<{ name: string; description: string; requiresApproval: boolean }[]>('/api/tools'), staleTime: 30_000 })
