import type { ProviderSetupInfo, ProviderSummary } from '../api-types'
import type { Store } from '../store'
import type { ModelInfo, Provider } from '../types'
import { KiloProvider } from './apps/kilo'
import { KiroProvider } from './apps/kiro'
import { OpenCodeProvider } from './apps/opencode'
import { str, type ProviderContext } from './context'
import { GeminiProvider } from './gemini'
import { MockProvider } from './mock'
import { id as newId } from '../util'
import { normalizeBaseUrl, OpenAICompatibleProvider } from './openai-compatible'
import { ProfilePool } from './web/browser'
import { WEB_SITES } from './web/sites'
import { WebChatProvider } from './web/web-chat'

interface Defaults {
  enabled: boolean
  priority: number
  dailyLimit: number | null
  setup: ProviderSetupInfo
}

const WEB_FIELDS: ProviderSetupInfo['fields'] = [
  { key: 'model', label: 'Model name', placeholder: "Picked in the site's model menu before each chat, e.g. Argon, Pro, Expert. Empty keeps the site's current model." },
  { key: 'browserChannel', label: 'Browser channel', placeholder: 'chromium (default), chrome or msedge. Installed Chrome gets far fewer human checks.' },
  { key: 'dailyLimit', label: 'Daily request limit', placeholder: '100', type: 'number' }
]

const APP_FIELDS = (binary: string, modelHint: string): ProviderSetupInfo['fields'] => [
  { key: 'binaryPath', label: 'Executable path', placeholder: `${binary} (found on PATH)` },
  { key: 'model', label: 'Model override', placeholder: modelHint }
]

/** Ids of user-defined OpenAI-compatible APIs start with this prefix. */
export const CUSTOM_PREFIX = 'custom_'
const CUSTOM_PRIORITY = 40

export function isCustomProviderId(providerId: string): boolean {
  return providerId.startsWith(CUSTOM_PREFIX)
}

const CUSTOM_SETUP: ProviderSetupInfo = {
  docsUrl: 'https://platform.openai.com/docs/api-reference/chat',
  secretLabel: 'API key',
  secretOptional: true,
  fields: [
    { key: 'name', label: 'Name', placeholder: 'My API' },
    { key: 'baseUrl', label: 'Base URL', placeholder: 'https://api.groq.com/openai/v1' },
    { key: 'model', label: 'Default model', placeholder: 'Leave empty to use the first model from /models' },
    { key: 'dailyLimit', label: 'Daily request limit', placeholder: 'No limit', type: 'number' }
  ]
}

const DEFAULTS: Record<string, Defaults> = {
  openrouter: {
    enabled: true,
    priority: 10,
    dailyLimit: 50,
    setup: {
      keyUrl: 'https://openrouter.ai/settings/keys',
      docsUrl: 'https://openrouter.ai/models?max_price=0',
      secretLabel: 'OpenRouter API key',
      fields: [
        { key: 'model', label: 'Default model', placeholder: 'openrouter/free (picks a free model for you)' },
        { key: 'dailyLimit', label: 'Daily request limit', placeholder: '50 (1000 after a $10 top-up)', type: 'number' }
      ]
    }
  },
  'gemini-api': {
    enabled: true,
    priority: 20,
    dailyLimit: 250,
    setup: {
      keyUrl: 'https://aistudio.google.com/apikey',
      docsUrl: 'https://ai.google.dev/gemini-api/docs/rate-limits',
      secretLabel: 'Google AI Studio API key',
      fields: [
        { key: 'model', label: 'Default model', placeholder: 'gemini-2.5-flash' },
        { key: 'dailyLimit', label: 'Daily request limit', placeholder: '250', type: 'number' }
      ]
    }
  },
  opencode: {
    enabled: true,
    priority: 70,
    dailyLimit: null,
    setup: { docsUrl: 'https://opencode.ai/docs', fields: APP_FIELDS('opencode', 'provider/model, e.g. opencode/grok-code'), loginHint: 'Run `opencode auth login` once in a terminal.' }
  },
  kiro: {
    enabled: true,
    priority: 71,
    dailyLimit: null,
    setup: {
      docsUrl: 'https://kiro.dev/docs/cli/headless/',
      secretLabel: 'KIRO_API_KEY (optional)',
      secretOptional: true,
      fields: APP_FIELDS('kiro-cli', 'e.g. claude-sonnet-4.5'),
      loginHint: 'Run `kiro-cli login` once, or paste an API key.'
    }
  },
  kilo: {
    enabled: true,
    priority: 72,
    dailyLimit: null,
    setup: {
      docsUrl: 'https://kilo.ai/docs/code-with-ai/platforms/cli',
      fields: APP_FIELDS('kilo', 'provider/model, e.g. kilo/kilo-auto'),
      loginHint: 'Run `kilo auth login` once in a terminal.'
    }
  },
  mock: { enabled: true, priority: 999, dailyLimit: null, setup: { fields: [] } }
}

WEB_SITES.forEach((site, i) => {
  const providerId = `web-${site.id.replace(/-web$/, '')}`
  DEFAULTS[providerId] = {
    enabled: true,
    priority: 50 + i,
    dailyLimit: 100,
    setup: { docsUrl: site.url, fields: WEB_FIELDS, loginHint: `Click Sign in, log in to ${site.name} in the window that opens, then close it.` }
  }
})

export class ProviderRegistry {
  readonly pool: ProfilePool
  private readonly providers = new Map<string, Provider>()

  constructor(
    private readonly store: Store,
    readonly dataDir: string
  ) {
    this.pool = new ProfilePool(dataDir)
    const ctx = (providerId: string): ProviderContext => this.ctx(providerId)

    const or = ctx('openrouter')
    this.add(
      new OpenAICompatibleProvider({
        id: 'openrouter',
        name: 'OpenRouter',
        description: 'One key for many models. FreeAgent lists only the free `:free` models.',
        baseUrl: () => 'https://openrouter.ai/api/v1',
        apiKey: or.secret,
        headers: () => ({ 'HTTP-Referer': 'https://github.com/freeagent-desktop', 'X-Title': 'FreeAgent' }),
        defaultModel: () => str(or.config().model),
        fallbackModels: ['openrouter/free'],
        filterModel: (m) => m.id.endsWith(':free') || m.id === 'openrouter/free'
      })
    )
    const gm = ctx('gemini-api')
    this.add(new GeminiProvider(gm.secret, () => str(gm.config().model)))
    for (const site of WEB_SITES) {
      const providerId = `web-${site.id.replace(/-web$/, '')}`
      this.add(new WebChatProvider(site.id, ctx(providerId), this.pool))
    }
    this.add(new OpenCodeProvider(ctx('opencode')))
    this.add(new KiroProvider(ctx('kiro')))
    this.add(new KiloProvider(ctx('kilo')))
    this.add(new MockProvider())

    for (const [pid, d] of Object.entries(DEFAULTS)) store.ensureProvider(pid, { enabled: d.enabled, priority: d.priority })
    for (const pid of store.listProviderIds(CUSTOM_PREFIX)) this.addCustom(pid)
  }

  private ctx(providerId: string): ProviderContext {
    return {
      dataDir: this.dataDir,
      config: () => this.store.getProviderSettings(providerId)?.config ?? {},
      saveConfig: (patch) => void this.store.updateProviderSettings(providerId, { config: patch }),
      secret: () => this.store.getProviderSecret(providerId),
      settings: () => this.store.getSettings()
    }
  }

  add(p: Provider): void {
    this.providers.set(p.id, p)
  }

  /** Registers a stored `custom_*` row as an OpenAI-compatible provider. Settings are read live from the store. */
  private addCustom(providerId: string): Provider {
    const c = this.ctx(providerId)
    const p = new OpenAICompatibleProvider({
      id: providerId,
      name: () => str(c.config().name) ?? 'Custom API',
      description: 'Custom OpenAI-compatible API (streaming Chat Completions).',
      baseUrl: () => {
        const raw = str(c.config().baseUrl)
        if (!raw) return ''
        try {
          return normalizeBaseUrl(raw)
        } catch {
          return ''
        }
      },
      apiKey: c.secret,
      keyOptional: true,
      noKeyMessage: 'No API key set. Requests are sent without an Authorization header.',
      defaultModel: () => str(c.config().model),
      fallbackModels: () => {
        const m = str(c.config().model)
        return m ? [m] : []
      }
    })
    this.add(p)
    return p
  }

  /** Validates and stores a new custom API, then registers it. Throws an Error with a user-facing message. */
  createCustom(input: { name: string; baseUrl: string; model?: string; secret?: string }): Provider {
    const name = input.name?.trim()
    if (!name) throw new Error('Name is required')
    const baseUrl = normalizeBaseUrl(input.baseUrl ?? '')
    const model = input.model?.trim()
    const secret = input.secret?.trim()
    const pid = newId(CUSTOM_PREFIX)
    this.store.ensureProvider(pid, { enabled: true, priority: CUSTOM_PRIORITY })
    this.store.updateProviderSettings(pid, { config: { name, baseUrl, ...(model ? { model } : {}) } })
    if (secret) this.store.setProviderSecret(pid, secret)
    return this.addCustom(pid)
  }

  /** Removes a custom API and its stored settings. Returns false when `providerId` is not a registered custom API. */
  removeCustom(providerId: string): boolean {
    if (!isCustomProviderId(providerId) || !this.providers.has(providerId)) return false
    this.providers.delete(providerId)
    this.store.deleteProvider(providerId)
    return true
  }

  get(providerId: string): Provider | undefined {
    return this.providers.get(providerId)
  }

  list(): Provider[] {
    return [...this.providers.values()]
  }

  web(providerId: string): WebChatProvider | undefined {
    const p = this.providers.get(providerId)
    return p instanceof WebChatProvider ? p : undefined
  }

  enabled(providerId: string): boolean {
    return this.store.getProviderSettings(providerId)?.enabled ?? false
  }

  priority(providerId: string): number {
    return this.store.getProviderSettings(providerId)?.priority ?? 500
  }

  dailyLimit(providerId: string): number | null {
    const configured = Number(this.store.getProviderSettings(providerId)?.config.dailyLimit)
    if (Number.isFinite(configured) && configured > 0) return configured
    return DEFAULTS[providerId]?.dailyLimit ?? null
  }

  async summary(p: Provider): Promise<ProviderSummary> {
    const s = this.store.ensureProvider(p.id, { enabled: true, priority: 500 })
    const status = await p.status().catch((err) => ({ state: 'error' as const, message: String(err) }))
    return {
      id: p.id,
      name: p.name,
      kind: p.kind,
      description: p.description,
      experimental: !!p.experimental,
      supportsTools: p.supportsTools,
      tags: p.tags,
      enabled: s.enabled,
      priority: s.priority,
      status,
      config: s.config,
      hasSecret: s.hasSecret,
      usageToday: this.store.usageToday(p.id),
      dailyLimit: this.dailyLimit(p.id),
      setup: DEFAULTS[p.id]?.setup ?? (isCustomProviderId(p.id) ? CUSTOM_SETUP : { fields: [] })
    }
  }

  async summaries(): Promise<ProviderSummary[]> {
    const all = await Promise.all(this.list().map((p) => this.summary(p)))
    return all.sort((a, b) => a.priority - b.priority)
  }

  async modelsFor(providerId: string): Promise<ModelInfo[]> {
    return (await this.get(providerId)?.models()) ?? []
  }

  /** Tells every provider that keeps per-run state to release it. Never throws. */
  async endSession(sessionId: string): Promise<void> {
    await Promise.all(this.list().map((p) => p.endSession?.(sessionId).catch(() => undefined)))
  }

  async dispose(): Promise<void> {
    ;(this.get('opencode') as OpenCodeProvider | undefined)?.dispose()
    await this.pool.closeAll()
  }
}
