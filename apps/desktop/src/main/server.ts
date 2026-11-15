import { app, safeStorage } from 'electron'
import { fork, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const PORT = Number(process.env.FREEAGENT_PORT || 47821)

export interface Connection {
  baseUrl: string
  token: string
  dataDir: string
  external: boolean
}

export function dataDir(): string {
  return process.env.FREEAGENT_DATA_DIR || join(homedir(), '.freeagent')
}

/** Token shared with the server and with Claude Desktop's MCP bridge; same file the headless server uses. */
function token(dir: string): string {
  const file = join(dir, 'token')
  if (existsSync(file)) return readFileSync(file, 'utf8').trim()
  const t = 'fa_' + randomBytes(24).toString('base64url')
  writeFileSync(file, t, { mode: 0o600 })
  return t
}

/**
 * Master key for encrypting API keys. Kept in the OS keychain through safeStorage when available.
 * If a headless server already created a plain key file, reuse it so both can read the same data.
 */
function secretKey(dir: string): string | undefined {
  if (existsSync(join(dir, 'secret.key'))) return undefined
  if (!safeStorage.isEncryptionAvailable()) return undefined
  const file = join(dir, 'secret.key.enc')
  if (existsSync(file)) return safeStorage.decryptString(readFileSync(file))
  const key = randomBytes(32).toString('base64')
  writeFileSync(file, safeStorage.encryptString(key), { mode: 0o600 })
  return key
}

function serverScript(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'server', 'index.js')
  return join(app.getAppPath(), '..', 'server', 'dist', 'index.js')
}

async function healthy(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}

let child: ChildProcess | undefined
let lastError = ''

export async function startServer(): Promise<Connection> {
  const dir = dataDir()
  mkdirSync(dir, { recursive: true })
  const conn: Connection = { baseUrl: `http://127.0.0.1:${PORT}`, token: token(dir), dataDir: dir, external: false }

  // A headless `pnpm server` on the same data folder is reused instead of starting a second one.
  if (await healthy(conn.baseUrl)) {
    const res = await fetch(`${conn.baseUrl}/api/info`, { headers: { Authorization: `Bearer ${conn.token}` } }).catch(() => undefined)
    if (res?.ok) return { ...conn, external: true }
    throw new Error(`Port ${PORT} is used by another program. Set FREEAGENT_PORT to a free port.`)
  }

  const script = serverScript()
  if (!existsSync(script)) throw new Error(`Server bundle not found at ${script}. Run \`pnpm --filter @freeagent/server build\`.`)
  const key = secretKey(dir)
  child = fork(script, [], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      FREEAGENT_DATA_DIR: dir,
      FREEAGENT_PORT: String(PORT),
      FREEAGENT_TOKEN: conn.token,
      FREEAGENT_QUIET: '1',
      ...(key ? { FREEAGENT_SECRET_KEY: key } : {})
    },
    execArgv: ['--disable-warning=ExperimentalWarning'],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  })
  child.stdout?.on('data', (d) => process.stdout.write(`[server] ${d}`))
  child.stderr?.on('data', (d) => {
    lastError = String(d).slice(-2000)
    process.stderr.write(`[server] ${d}`)
  })

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server did not start in time. ${lastError}`)), 20_000)
    child!.once('message', (m: { type?: string }) => {
      if (m?.type === 'ready') {
        clearTimeout(timer)
        resolve()
      }
    })
    child!.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`Server exited with code ${code}. ${lastError}`))
    })
  })
  return conn
}

export function stopServer(): void {
  if (child && child.exitCode === null) child.kill('SIGTERM')
  child = undefined
}
