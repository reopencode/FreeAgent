import { ProviderError, type ChatMessage, type ChatOptions, type Delta, type ModelInfo, type Provider, type ProviderStatus } from '../../types'
import { str, type ProviderContext } from '../context'
import { appStatus, binaryFor, detect, singleModel, taskFromMessages } from './base'
import { streamProcess } from './process-stream'

/** Kiro's headless CLI. Prints a banner and tool chatter on stderr; the answer arrives on stdout. */
export function cleanKiroLine(line: string): string | null {
  const t = line.replace(/\s+$/, '')
  if (/^\s*(>|▸|●|⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏)\s*$/.test(t)) return null
  return t.replace(/^>\s?/, '')
}

export class KiroProvider implements Provider {
  readonly id = 'kiro'
  readonly name = 'Kiro'
  readonly kind = 'app' as const
  readonly description = 'Kiro CLI agent in headless mode (`kiro-cli chat --no-interactive --trust-all-tools`), run in the project folder.'
  readonly supportsTools = false
  readonly tags = ['code' as const, 'general' as const]

  constructor(private readonly ctx: ProviderContext) {}

  private bin(): string {
    return binaryFor(this.ctx, 'kiro-cli')
  }

  async status(): Promise<ProviderStatus> {
    const s = appStatus('Kiro CLI', detect(this.bin()), 'Install it from kiro.dev/cli, then run `kiro-cli login` (or set an API key here).')
    if (s.state === 'ready' && !this.ctx.secret() && !process.env.KIRO_API_KEY) s.message = `${s.message ?? ''} · uses your \`kiro-cli login\` session`
    return s
  }

  async models(): Promise<ModelInfo[]> {
    const m = str(this.ctx.config().model)
    return m ? [{ id: m, name: m, tags: ['code', 'general'] }] : singleModel('Kiro')
  }

  async defaultModel(): Promise<string> {
    return str(this.ctx.config().model) ?? 'default'
  }

  async *chat(messages: ChatMessage[], opts: ChatOptions): AsyncIterable<Delta> {
    if (!detect(this.bin()).path) throw new ProviderError(this.id, 'unavailable', 'Kiro CLI is not installed')
    const args = ['chat', '--no-interactive', '--trust-all-tools']
    const model = str(this.ctx.config().model) ?? (opts.model && opts.model !== 'default' ? opts.model : undefined)
    if (model) args.push('--model', model)
    const env: NodeJS.ProcessEnv = {}
    const key = this.ctx.secret()
    if (key) env.KIRO_API_KEY = key
    yield { type: 'status', message: 'Kiro is working…' }
    const proc = streamProcess(this.id, this.bin(), args, { cwd: opts.cwd, env, signal: opts.signal, input: taskFromMessages(messages) })
    let wrote = false
    for await (const line of proc.lines) {
      if (line.stream === 'stderr') {
        const t = line.text.trim()
        if (/^(Using tool|Running|Reading|Writing|Executing)/i.test(t)) yield { type: 'status', message: `Kiro: ${t.slice(0, 120)}` }
        continue
      }
      const cleaned = cleanKiroLine(line.text)
      if (cleaned === null) continue
      if (!wrote && !cleaned.trim()) continue
      wrote = true
      yield { type: 'text', text: cleaned + '\n' }
    }
    const { code, stderr } = await proc.done
    if (opts.signal?.aborted) throw new ProviderError(this.id, 'aborted', 'Cancelled')
    if (code !== 0) {
      const kind = /login|auth|unauthori[sz]ed|token/i.test(stderr) ? 'auth' : 'server'
      throw new ProviderError(this.id, kind, `kiro-cli exited with ${code}: ${stderr.trim().slice(-400) || 'no output'}`)
    }
  }
}
