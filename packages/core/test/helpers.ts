import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCore, type Core } from '../src/core'
import { ProviderError, type ChatMessage, type ChatOptions, type Delta, type Provider, type ProviderErrorKind } from '../src/types'

export interface TestCore extends Core {
  cleanup(): Promise<void>
}

/** A core in a temp folder with every built-in provider disabled except `keep`. */
export function testCore(keep: string[] = []): TestCore {
  const dir = mkdtempSync(join(tmpdir(), 'freeagent-test-'))
  const core = createCore({ dataDir: dir })
  for (const p of core.registry.list()) {
    core.store.ensureProvider(p.id, { enabled: false, priority: 500 })
    core.store.updateProviderSettings(p.id, { enabled: keep.includes(p.id) })
  }
  return Object.assign(core, {
    async cleanup() {
      await core.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

export class FakeProvider implements Provider {
  readonly kind = 'api' as const
  readonly description = 'test'
  readonly supportsTools = true
  readonly tags = ['general' as const]
  calls = 0

  constructor(
    readonly id: string,
    private readonly behavior: { reply?: string; fail?: ProviderErrorKind; failAfterText?: boolean }
  ) {}

  get name(): string {
    return this.id
  }
  async status() {
    return { state: 'ready' as const }
  }
  async models() {
    return [{ id: 'm', name: 'm', tags: ['general' as const] }]
  }
  async defaultModel() {
    return 'm'
  }
  async *chat(_messages: ChatMessage[], _opts: ChatOptions): AsyncIterable<Delta> {
    this.calls++
    if (this.behavior.fail && !this.behavior.failAfterText) throw new ProviderError(this.id, this.behavior.fail, `${this.id} failed`)
    yield { type: 'text', text: this.behavior.reply ?? `hello from ${this.id}` }
    if (this.behavior.fail) throw new ProviderError(this.id, this.behavior.fail, `${this.id} broke mid-reply`)
  }
}

export function addFake<T extends Provider>(core: Core, p: T, priority: number): T {
  core.registry.add(p)
  core.store.ensureProvider(p.id, { enabled: true, priority })
  core.store.updateProviderSettings(p.id, { enabled: true, priority })
  return p
}
