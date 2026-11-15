import { spawn } from 'node:child_process'
import { ProviderError } from '../../types'
import { AsyncQueue, stripAnsi } from '../../util'

export interface StreamedProcess {
  lines: AsyncIterable<{ stream: 'stdout' | 'stderr'; text: string }>
  done: Promise<{ code: number | null; stderr: string }>
}

/** Spawns a CLI and yields stdout line by line, ANSI codes removed. */
export function streamProcess(
  providerId: string,
  command: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs?: number; input?: string }
): StreamedProcess {
  const queue = new AsyncQueue<{ stream: 'stdout' | 'stderr'; text: string }>()
  let stderr = ''
  const child = spawn(command, args, {
    cwd: opts.cwd,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', ...opts.env },
    shell: process.platform === 'win32',
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 20 * 60_000)
  const abort = (): void => {
    child.kill('SIGTERM')
  }
  opts.signal?.addEventListener('abort', abort, { once: true })

  const splitter = (stream: 'stdout' | 'stderr') => {
    let buf = ''
    return {
      push(chunk: Buffer): void {
        buf += chunk.toString()
        const parts = buf.split(/\r?\n/)
        buf = parts.pop() ?? ''
        for (const p of parts) queue.push({ stream, text: stripAnsi(p) })
      },
      flush(): void {
        if (buf) queue.push({ stream, text: stripAnsi(buf) })
        buf = ''
      }
    }
  }
  const out = splitter('stdout')
  const err = splitter('stderr')
  child.stdout.on('data', (d: Buffer) => out.push(d))
  child.stderr.on('data', (d: Buffer) => {
    stderr += d.toString()
    err.push(d)
  })

  const done = new Promise<{ code: number | null; stderr: string }>((resolve) => {
    child.on('error', (e) => {
      clearTimeout(timer)
      queue.fail(new ProviderError(providerId, 'unavailable', `Could not start ${command}: ${e.message}`))
      resolve({ code: -1, stderr: e.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', abort)
      out.flush()
      err.flush()
      queue.close()
      resolve({ code, stderr: stripAnsi(stderr) })
    })
  })
  if (opts.input !== undefined) child.stdin.end(opts.input)
  else child.stdin.end()
  return { lines: queue, done }
}
