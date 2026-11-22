import { ProviderError, type ChatMessage, type ChatOptions, type Delta, type ModelInfo, type Provider, type ProviderStatus } from '../../types'
import { str, type ProviderContext } from '../context'
import { appStatus, binaryFor, detect, singleModel, taskFromMessages } from './base'
import { streamProcess } from './process-stream'

interface KiloPart {
  type?: string
  text?: string
  tool?: string
  state?: { title?: string }
}

interface KiloEvent {
  type?: string
  part?: KiloPart
  error?: unknown
}

const AUTH_ERROR = /login|auth|unauthori[sz]ed|token/i

/**
 * Kilo's `-m` flag requires `provider/model`. A bare value such as `10` is looked up as `10/.`
 * and the CLI exits with "Model not found".
 */
export function kiloModelArg(model: string | undefined): string | undefined {
  const m = model?.trim()
  if (!m || m === 'default' || !m.includes('/') || m.startsWith('/') || m.endsWith('/')) return undefined
  return m
}

/** One stdout line from `kilo run --format json`. Non-JSON lines and ignored event types yield nothing. */
export function parseKiloRunLine(line: string): Delta[] {
  const ev = parseEvent(line)
  if (!ev) return []
  if (ev.type === 'text' && ev.part?.text) return [{ type: 'text', text: ev.part.text }]
  if (ev.type === 'tool_use') {
    const name = ev.part?.tool || ev.part?.state?.title || 'tool'
    return [{ type: 'status', message: `Kilo: ${name}` }]
  }
  if (ev.type === 'error') return [{ type: 'status', message: `Kilo: ${errorText(ev.error)}` }]
  return []
}

function parseEvent(line: string): KiloEvent | null {
  try {
    return JSON.parse(line) as KiloEvent
  } catch {
    return null
  }
}

function errorText(error: unknown): string {
  if (typeof error === 'string' && error.trim()) return error.trim()
  if (error && typeof error === 'object') {
    const e = error as { name?: string; message?: string; data?: { message?: string } }
    return e.data?.message || e.message || e.name || 'Kilo run failed'
  }
  return 'Kilo run failed'
}

/** Kilo Code's headless CLI. `--format json` prints one event per stdout line; the task is written to stdin. */
export class KiloProvider implements Provider {
  readonly id = 'kilo'
  readonly name = 'Kilo'
  readonly kind = 'app' as const
  readonly description = 'Kilo CLI agent in headless mode (`kilo run --auto --format json`), run in the project folder.'
  readonly supportsTools = false
  readonly tags = ['code' as const, 'general' as const]

  constructor(private readonly ctx: ProviderContext) {}

  private bin(): string {
    return binaryFor(this.ctx, 'kilo')
  }

  async status(): Promise<ProviderStatus> {
    const s = appStatus('Kilo CLI', detect(this.bin()), 'Install it from kilo.ai/docs/code-with-ai/platforms/cli, then run `kilo auth login`.')
    if (s.state === 'ready') s.message = `${s.message ?? ''} · uses your \`kilo auth login\` session`
    return s
  }

  async models(): Promise<ModelInfo[]> {
    const m = kiloModelArg(str(this.ctx.config().model))
    return m ? [{ id: m, name: m, tags: ['code', 'general'] }] : singleModel('Kilo')
  }

  async defaultModel(): Promise<string> {
    return kiloModelArg(str(this.ctx.config().model)) ?? 'default'
  }

  async *chat(messages: ChatMessage[], opts: ChatOptions): AsyncIterable<Delta> {
    if (!detect(this.bin()).path) throw new ProviderError(this.id, 'unavailable', 'Kilo CLI is not installed')
    const args = ['run', '--auto', '--format', 'json']
    const requested = str(this.ctx.config().model) ?? (opts.model && opts.model !== 'default' ? opts.model : undefined)
    const model = kiloModelArg(requested)
    if (requested && !model && requested.trim() !== 'default') {
      yield { type: 'status', message: `Kilo ignored model "${requested.trim()}". Use provider/model, for example kilo/anthropic/claude-sonnet-4.5.` }
    }
    if (model) args.push('-m', model)
    yield { type: 'status', message: 'Kilo is working…' }
    const proc = streamProcess(this.id, this.bin(), args, { cwd: opts.cwd, signal: opts.signal, input: taskFromMessages(messages) })
    let runError: string | undefined
    for await (const line of proc.lines) {
      if (line.stream !== 'stdout') continue
      const ev = parseEvent(line.text)
      if (ev?.type === 'error') {
        const message = errorText(ev.error)
        if (AUTH_ERROR.test(message)) throw new ProviderError(this.id, 'auth', message)
        runError = message
        continue
      }
      for (const d of parseKiloRunLine(line.text)) yield d
    }
    const { code, stderr } = await proc.done
    if (opts.signal?.aborted) throw new ProviderError(this.id, 'aborted', 'Cancelled')
    if (code !== 0) {
      const detail = runError || stderr.trim().slice(-400) || 'no output'
      const kind = AUTH_ERROR.test(`${runError ?? ''}\n${stderr}`) ? 'auth' : 'server'
      throw new ProviderError(this.id, kind, `kilo exited with ${code}: ${detail}`)
    }
  }
}
