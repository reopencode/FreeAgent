import { ProviderError, errorKindFromStatus, type ChatMessage, type ChatOptions, type Delta, type ModelInfo, type Provider, type ProviderStatus } from '../../types'
import { runProcess } from '../../util'
import { str, type ProviderContext } from '../context'
import { appStatus, binaryFor, detect, singleModel, taskFromMessages } from './base'
import { streamProcess } from './process-stream'

interface OpenCodePart {
  type?: string
  text?: string
  tool?: string
  state?: { title?: string; status?: string }
}

interface OpenCodeEvent {
  type?: string
  part?: OpenCodePart
  error?: unknown
}

const AUTH_ERROR = /login|auth|unauthori[sz]ed|token/i

/** `--model` requires `provider/model`. A bare name is left unset. */
export function opencodeModelArg(model: string | undefined): string | undefined {
  const m = model?.trim()
  if (!m || m === 'default' || !m.includes('/') || m.startsWith('/') || m.endsWith('/')) return undefined
  return m
}

/** One stdout line from `opencode run --format json`. Non-JSON lines and ignored event types yield nothing. */
export function parseOpenCodeRunLine(line: string): Delta[] {
  const ev = parseEvent(line)
  if (!ev) return []
  if (ev.type === 'text' && ev.part?.text) return [{ type: 'text', text: ev.part.text }]
  if (ev.type === 'tool_use') {
    const name = ev.part?.tool || ev.part?.state?.title || 'tool'
    return [{ type: 'status', message: `OpenCode: ${name}` }]
  }
  if (ev.type === 'error') return [{ type: 'status', message: `OpenCode: ${errorText(ev.error)}` }]
  return []
}

function parseEvent(line: string): OpenCodeEvent | null {
  try {
    return JSON.parse(line) as OpenCodeEvent
  } catch {
    return null
  }
}

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || !('status' in error)) return undefined
  const status = (error as { status?: unknown }).status
  return typeof status === 'number' ? status : undefined
}

function errorText(error: unknown): string {
  if (typeof error === 'string' && error.trim()) return error.trim()
  if (error && typeof error === 'object') {
    const e = error as { name?: string; message?: string; data?: { message?: string } }
    return e.data?.message || e.message || e.name || 'OpenCode run failed'
  }
  return 'OpenCode run failed'
}

/** OpenCode's headless CLI. `--format json` prints one event per stdout line; the task is written to stdin. */
export class OpenCodeProvider implements Provider {
  readonly id = 'opencode'
  readonly name = 'OpenCode'
  readonly kind = 'app' as const
  readonly description = 'OpenCode CLI agent in headless mode (`opencode run --auto --format json`), run in the project folder.'
  readonly supportsTools = false
  readonly tags = ['code' as const, 'general' as const]
  private cachedFreeModel: string | undefined

  constructor(private readonly ctx: ProviderContext) {}

  private bin(): string {
    return binaryFor(this.ctx, 'opencode')
  }

  async status(): Promise<ProviderStatus> {
    return appStatus('OpenCode', detect(this.bin()), 'Install it with `npm i -g opencode-ai` (or see opencode.ai), then run `opencode auth login` once.')
  }

  async models(): Promise<ModelInfo[]> {
    const configured = opencodeModelArg(str(this.ctx.config().model))
    return configured ? [{ id: configured, name: configured, tags: ['code', 'general'] }] : singleModel('OpenCode')
  }

  async defaultModel(): Promise<string> {
    return opencodeModelArg(str(this.ctx.config().model)) ?? 'default'
  }

  /** First zero-cost id from `opencode models` (`*-free` or `big-pickle`). The account default can be paid. */
  private async freeModel(): Promise<string | undefined> {
    if (this.cachedFreeModel) return this.cachedFreeModel
    const listed = await runProcess(this.bin(), ['models'], { timeoutMs: 20_000 })
    if (listed.code !== 0) return undefined
    const id = listed.stdout
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.endsWith('-free') || line.endsWith('/big-pickle'))
    if (id) this.cachedFreeModel = id
    return id
  }

  async *chat(messages: ChatMessage[], opts: ChatOptions): AsyncIterable<Delta> {
    if (!detect(this.bin()).path) throw new ProviderError(this.id, 'unavailable', 'OpenCode is not installed')
    const args = ['run', '--auto', '--format', 'json']
    const requested = str(this.ctx.config().model) ?? (opts.model && opts.model !== 'default' ? opts.model : undefined)
    const configured = opencodeModelArg(requested)
    if (requested && !configured && requested.trim() !== 'default') {
      yield { type: 'status', message: `OpenCode ignored model "${requested.trim()}". Use provider/model, for example opencode/beam-free.` }
    }
    const model = configured ?? (await this.freeModel())
    if (model) args.push('--model', model)
    if (!configured && model) yield { type: 'status', message: `OpenCode model: ${model}` }
    yield { type: 'status', message: 'OpenCode is working…' }
    const proc = streamProcess(this.id, this.bin(), args, { cwd: opts.cwd, signal: opts.signal, input: taskFromMessages(messages) })
    let runError: string | undefined
    let runStatus: number | undefined
    for await (const line of proc.lines) {
      if (line.stream !== 'stdout') continue
      const ev = parseEvent(line.text)
      if (ev?.type === 'error') {
        const message = errorText(ev.error)
        const status = errorStatus(ev.error)
        if (AUTH_ERROR.test(message)) throw new ProviderError(this.id, 'auth', message, status)
        runError = message
        runStatus = status
        continue
      }
      for (const delta of parseOpenCodeRunLine(line.text)) yield delta
    }
    const { code, stderr } = await proc.done
    if (opts.signal?.aborted) throw new ProviderError(this.id, 'aborted', 'Cancelled')
    if (code !== 0) {
      const detail = runError || stderr.trim().slice(-400) || 'no output'
      const kind = AUTH_ERROR.test(`${runError ?? ''}\n${stderr}`) ? 'auth' : runStatus ? errorKindFromStatus(runStatus) : 'server'
      throw new ProviderError(this.id, kind, `opencode run exited with ${code}: ${detail}`, runStatus)
    }
  }
}
