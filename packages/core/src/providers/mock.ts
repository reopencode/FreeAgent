import type { ChatMessage, ChatOptions, Delta, ModelInfo, Provider, ProviderStatus } from '../types'
import { sleep } from '../util'

/**
 * Offline provider so the app works before any key or login exists.
 * A user message of the form `/tool <name> <json>` makes it call that tool, which is how tests drive the agent loop.
 */
export class MockProvider implements Provider {
  readonly id = 'mock'
  readonly name = 'Offline demo'
  readonly kind = 'api' as const
  readonly description = 'Built-in offline provider for trying the app without keys. Replies are canned.'
  readonly supportsTools = true
  readonly tags = ['general' as const, 'fast' as const]

  constructor(private readonly delayMs = 12) {}

  async status(): Promise<ProviderStatus> {
    return { state: 'ready', message: 'Canned replies for testing.' }
  }

  async models(): Promise<ModelInfo[]> {
    return [{ id: 'echo', name: 'Echo', tags: ['general', 'fast'] }]
  }

  async defaultModel(): Promise<string> {
    return 'echo'
  }

  async *chat(messages: ChatMessage[], opts: ChatOptions): AsyncIterable<Delta> {
    const last = [...messages].reverse().find((m) => m.role === 'user' || m.role === 'tool')
    if (last?.role === 'tool') {
      yield* this.stream(`Tool \`${last.name ?? 'tool'}\` returned:\n\n\`\`\`\n${last.content.slice(0, 1500)}\n\`\`\``, opts.signal)
      return
    }
    const text = last?.content ?? ''
    const toolMatch = /^\/tool\s+(\S+)\s*([\s\S]*)$/.exec(text.trim())
    if (toolMatch && opts.tools?.some((t) => t.name === toolMatch[1])) {
      yield { type: 'tool_call', call: { id: `call_${Date.now()}`, name: toolMatch[1], arguments: toolMatch[2]?.trim() || '{}' } }
      return
    }
    const reply = [
      `This is the **offline demo provider**, so this reply is canned. You said:`,
      '',
      `> ${text.split('\n').join('\n> ') || '(empty message)'}`,
      '',
      'To get real answers, open **Customize → Providers** and add a free OpenRouter or Gemini key, connect a web plan, or install OpenCode, Kiro or Kilo.'
    ].join('\n')
    yield* this.stream(reply, opts.signal)
    yield { type: 'usage', inputTokens: Math.ceil(text.length / 4), outputTokens: Math.ceil(reply.length / 4) }
  }

  private async *stream(text: string, signal?: AbortSignal): AsyncIterable<Delta> {
    for (const piece of text.match(/\S+\s*/g) ?? [text]) {
      if (signal?.aborted) return
      yield { type: 'text', text: piece }
      if (this.delayMs) await sleep(this.delayMs, signal)
    }
  }
}
