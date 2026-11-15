import type { ChatMessage, ModelInfo, ProviderStatus } from '../../types'
import { commandVersion, which } from '../../util'
import { str, type ProviderContext } from '../context'

export interface Detection {
  path?: string
  version?: string
}

const cache = new Map<string, { at: number; value: Detection }>()

export function detect(binary: string): Detection {
  const hit = cache.get(binary)
  if (hit && Date.now() - hit.at < 30_000) return hit.value
  const path = which(binary)
  const value = path ? { path, version: commandVersion(path) } : {}
  cache.set(binary, { at: Date.now(), value })
  return value
}

export function binaryFor(ctx: ProviderContext, fallback: string): string {
  return str(ctx.config().binaryPath) ?? fallback
}

export function appStatus(name: string, d: Detection, installHint: string): ProviderStatus {
  if (!d.path) return { state: 'unavailable', message: `${name} is not installed. ${installHint}` }
  return { state: 'ready', message: d.version ? `${d.version} at ${d.path}` : d.path }
}

/** App agents receive one task, so earlier turns are summarized into the prompt. */
export function taskFromMessages(messages: ChatMessage[]): string {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
  const turns = messages.filter((m) => m.role === 'user' || (m.role === 'assistant' && m.content))
  const last = turns[turns.length - 1]
  const history = turns.slice(0, -1).slice(-6)
  const parts: string[] = []
  if (system) parts.push(`Context:\n${system}`)
  if (history.length) parts.push('Earlier conversation:\n' + history.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 2000)}`).join('\n\n'))
  parts.push(history.length || system ? `Task:\n${last?.content ?? ''}` : (last?.content ?? ''))
  return parts.join('\n\n')
}

export function singleModel(name: string): ModelInfo[] {
  return [{ id: 'default', name: `${name} default`, tags: ['code', 'general'] }]
}
