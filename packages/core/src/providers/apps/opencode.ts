import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { ProviderError, type ChatMessage, type ChatOptions, type Delta, type ModelInfo, type Provider, type ProviderStatus } from '../../types'
import { readSse, sleep } from '../../util'
import { str, type ProviderContext } from '../context'
import { appStatus, binaryFor, detect, singleModel, taskFromMessages } from './base'
import { streamProcess } from './process-stream'

interface OpenCodePart {
  id?: string
  sessionID?: string
  type: string
  text?: string
  tool?: string
  state?: { status?: string; title?: string }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      srv.close(() => resolve(typeof addr === 'object' && addr ? addr.port : 0))
    })
  })
}

/**
 * OpenCode coding agent. Runs `opencode serve` per working directory and drives it over HTTP,
 * falling back to `opencode run` when the server cannot start.
 */
export class OpenCodeProvider implements Provider {
  readonly id = 'opencode'
  readonly name = 'OpenCode'
  readonly kind = 'app' as const
  readonly description = 'Open-source coding agent. FreeAgent starts `opencode serve` in the project folder and sends it tasks over its HTTP API.'
  readonly supportsTools = false
  readonly tags = ['code' as const, 'general' as const]
  private servers = new Map<string, { url: string; proc: ChildProcess }>()

  constructor(private readonly ctx: ProviderContext) {}

  private bin(): string {
    return binaryFor(this.ctx, 'opencode')
  }

  async status(): Promise<ProviderStatus> {
    return appStatus('OpenCode', detect(this.bin()), 'Install it with `npm i -g opencode-ai` (or see opencode.ai), then run `opencode auth login` once.')
  }

  async models(): Promise<ModelInfo[]> {
    const configured = str(this.ctx.config().model)
    return configured ? [{ id: configured, name: configured, tags: ['code', 'general'] }] : singleModel('OpenCode')
  }

  async defaultModel(): Promise<string> {
    return str(this.ctx.config().model) ?? 'default'
  }

  private async server(cwd: string): Promise<string> {
    const existing = this.servers.get(cwd)
    if (existing && existing.proc.exitCode === null) return existing.url
    const port = await freePort()
    const proc = spawn(this.bin(), ['serve', '--port', String(port), '--hostname', '127.0.0.1'], {
      cwd,
      env: process.env,
      stdio: 'ignore',
      shell: process.platform === 'win32'
    })
    const url = `http://127.0.0.1:${port}`
    this.servers.set(cwd, { url, proc })
    proc.on('exit', () => {
      if (this.servers.get(cwd)?.proc === proc) this.servers.delete(cwd)
    })
    for (let i = 0; i < 60; i++) {
      if (proc.exitCode !== null) break
      try {
        const res = await fetch(`${url}/config`, { signal: AbortSignal.timeout(1000) })
        if (res.ok) return url
      } catch {
        // not up yet
      }
      await sleep(250)
    }
    proc.kill()
    throw new Error('opencode serve did not start')
  }

  dispose(): void {
    for (const s of this.servers.values()) s.proc.kill()
    this.servers.clear()
  }

  async *chat(messages: ChatMessage[], opts: ChatOptions): AsyncIterable<Delta> {
    const d = detect(this.bin())
    if (!d.path) throw new ProviderError(this.id, 'unavailable', 'OpenCode is not installed')
    const cwd = opts.cwd ?? process.cwd()
    const task = taskFromMessages(messages)
    let url: string
    try {
      url = await this.server(cwd)
    } catch {
      yield { type: 'status', message: 'OpenCode server unavailable, using `opencode run`' }
      yield* this.runFallback(task, cwd, opts)
      return
    }
    yield* this.runViaServer(url, task, opts)
  }

  private async *runViaServer(url: string, task: string, opts: ChatOptions): AsyncIterable<Delta> {
    const session = (await (
      await fetch(`${url}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: task.slice(0, 60) })
      })
    ).json()) as { id: string }

    const queue: Delta[] = []
    let streamedText = false
    let wake: (() => void) | undefined
    const push = (d: Delta): void => {
      queue.push(d)
      wake?.()
    }
    const events = new AbortController()
    const seenTools = new Set<string>()
    const eventLoop = (async () => {
      try {
        const res = await fetch(`${url}/event`, { signal: events.signal })
        if (!res.body) return
        for await (const ev of readSse(res.body, events.signal)) {
          const msg = JSON.parse(ev.data) as { type: string; properties?: { part?: OpenCodePart; delta?: string } }
          const part = msg.properties?.part
          if (msg.type !== 'message.part.updated' || !part || part.sessionID !== session.id) continue
          if (part.type === 'text' && msg.properties?.delta) {
            streamedText = true
            push({ type: 'text', text: msg.properties.delta })
          } else if (part.type === 'tool' && part.state?.status === 'running' && part.id && !seenTools.has(part.id)) {
            seenTools.add(part.id)
            push({ type: 'status', message: `OpenCode: ${part.state.title || part.tool}` })
          }
        }
      } catch {
        // event stream closed
      }
    })()

    const model = str(this.ctx.config().model) ?? (opts.model && opts.model !== 'default' ? opts.model : undefined)
    const body: Record<string, unknown> = { parts: [{ type: 'text', text: task }] }
    if (model?.includes('/')) {
      const [providerID, ...rest] = model.split('/')
      body.model = { providerID, modelID: rest.join('/') }
    }
    let result: { parts?: OpenCodePart[] } | undefined
    let error: unknown
    let done = false
    const request = fetch(`${url}/session/${session.id}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: opts.signal
    })
      .then(async (r) => {
        if (!r.ok) throw new ProviderError(this.id, 'server', `OpenCode returned ${r.status}: ${(await r.text()).slice(0, 300)}`)
        result = (await r.json()) as { parts?: OpenCodePart[] }
      })
      .catch((e) => {
        error = e
      })
      .finally(() => {
        done = true
        wake?.()
      })

    push({ type: 'status', message: 'OpenCode is working…' })
    while (true) {
      if (queue.length) {
        yield queue.shift()!
        continue
      }
      if (done) break
      await new Promise<void>((r) => (wake = r))
      wake = undefined
    }
    events.abort()
    await eventLoop
    if (opts.signal?.aborted) {
      await fetch(`${url}/session/${session.id}/abort`, { method: 'POST' }).catch(() => undefined)
      throw new ProviderError(this.id, 'aborted', 'Cancelled')
    }
    if (error) throw error instanceof ProviderError ? error : new ProviderError(this.id, 'server', String(error))
    if (!streamedText) {
      const text = (result?.parts ?? []).filter((p) => p.type === 'text' && p.text).map((p) => p.text).join('\n\n')
      yield { type: 'text', text: text || '(OpenCode finished without a text reply.)' }
    }
  }

  private async *runFallback(task: string, cwd: string, opts: ChatOptions): AsyncIterable<Delta> {
    const proc = streamProcess(this.id, this.bin(), ['run', task], { cwd, signal: opts.signal })
    for await (const line of proc.lines) {
      if (line.stream === 'stdout') yield { type: 'text', text: line.text + '\n' }
    }
    const { code, stderr } = await proc.done
    if (code !== 0) throw new ProviderError(this.id, 'server', `opencode run exited with ${code}: ${stderr.slice(-400)}`)
  }
}
