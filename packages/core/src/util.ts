import { randomBytes } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

export function id(prefix = ''): string {
  return prefix + randomBytes(9).toString('base64url')
}

export function now(): number {
  return Date.now()
}

export function today(at = new Date()): string {
  return at.toISOString().slice(0, 10)
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max) + `\n…[truncated ${text.length - max} characters]`
}

export function safeJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '')
}

/** Finds an executable on PATH, or returns the path itself if it exists. */
export function which(command: string): string | undefined {
  if (command.includes('/') || command.includes('\\')) return existsSync(command) ? command : undefined
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    for (const ext of exts) {
      const full = join(dir, command + ext)
      if (existsSync(full)) return full
    }
  }
  return undefined
}

export function commandVersion(bin: string, args = ['--version']): string | undefined {
  try {
    const res = spawnSync(bin, args, { encoding: 'utf8', timeout: 8000, shell: process.platform === 'win32' })
    if (res.status !== 0) return undefined
    return stripAnsi(res.stdout || res.stderr).trim().split('\n')[0]
  } catch {
    return undefined
  }
}

export interface ProcessResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export function runProcess(
  command: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; signal?: AbortSignal; input?: string; shell?: boolean }
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      shell: opts.shell ?? false,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          child.kill('SIGKILL')
        }, opts.timeoutMs)
      : undefined
    const onAbort = (): void => {
      child.kill('SIGKILL')
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (d) => (stdout += d.toString()))
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      resolve({ code, stdout, stderr, timedOut })
    })
    if (opts.input !== undefined) child.stdin.end(opts.input)
    else child.stdin.end()
  })
}

/** Creates an async queue that a producer pushes into and a consumer iterates. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = []
  private waiters: Array<(r: IteratorResult<T>) => void> = []
  private closed = false
  private failure: unknown

  push(item: T): void {
    if (this.closed) return
    const w = this.waiters.shift()
    if (w) w({ value: item, done: false })
    else this.items.push(item)
  }

  close(): void {
    this.closed = true
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true })
  }

  fail(err: unknown): void {
    this.failure = err
    this.close()
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift() as T, done: false })
        if (this.failure) return Promise.reject(this.failure)
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true })
        return new Promise((resolve) => this.waiters.push(resolve))
      }
    }
  }
}

/** Parses a `text/event-stream` body into `data:` payloads. */
export async function* readSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncIterable<{ event?: string; data: string }> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      if (signal?.aborted) return
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const raw = buffer.slice(0, idx)
        buffer = buffer.slice(idx).replace(/^\r?\n\r?\n/, '')
        let event: string | undefined
        const data: string[] = []
        for (const line of raw.split(/\r?\n/)) {
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
        }
        if (data.length) yield { event, data: data.join('\n') }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      resolve()
    })
  })
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim()
}

/** Folds a text delta into the reply so far: `replace` swaps the whole reply, otherwise the text is appended. */
export function applyTextDelta(current: string, delta: { text: string; replace?: boolean }): string {
  return delta.replace ? delta.text : current + delta.text
}

/**
 * Turns text deltas (some of which replace the reply so far) into append-only chunks for streams that cannot retract text.
 * A replacement that extends what was already sent yields only its new tail; `end()` flushes what a diverging replacement left unsent.
 */
export function appendOnlyText(): { next(delta: { text: string; replace?: boolean }): string; end(): string } {
  let sent = ''
  let pending: string | null = null
  return {
    next(delta) {
      if (!delta.replace) {
        sent += delta.text
        pending = null
        return delta.text
      }
      if (delta.text.startsWith(sent)) {
        const tail = delta.text.slice(sent.length)
        sent = delta.text
        pending = null
        return tail
      }
      pending = delta.text
      return ''
    },
    end() {
      if (pending === null) return ''
      let i = 0
      while (i < sent.length && i < pending.length && sent[i] === pending[i]) i++
      const tail = pending.slice(i)
      sent = pending
      pending = null
      return tail
    }
  }
}
