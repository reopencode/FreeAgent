import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Browser, BrowserContext } from 'playwright'

export interface BrowserOptions {
  headless: boolean
  channel?: string
}

let playwrightModule: typeof import('playwright') | undefined

async function loadPlaywright(): Promise<typeof import('playwright')> {
  if (!playwrightModule) playwrightModule = await import('playwright')
  return playwrightModule
}

export class BrowserMissingError extends Error {
  constructor() {
    super('Chromium for Playwright is not installed. Run `pnpm browsers` (or `npx playwright install chromium`) and try again.')
  }
}

function wrapLaunchError(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err)
  if (/Executable doesn't exist|browserType\.launch.*not found|Please run the following command/i.test(msg)) return new BrowserMissingError()
  return err instanceof Error ? err : new Error(msg)
}

/** One persistent Chromium profile per web site, so logins survive restarts. */
export class ProfilePool {
  private contexts = new Map<string, { ctx: BrowserContext; headless: boolean; idle?: NodeJS.Timeout }>()
  private locks = new Map<string, Promise<void>>()

  constructor(private readonly dataDir: string) {}

  profileDir(siteId: string): string {
    const dir = join(this.dataDir, 'browser-profiles', siteId)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  async context(siteId: string, opts: BrowserOptions): Promise<BrowserContext> {
    const cur = this.contexts.get(siteId)
    if (cur && cur.headless === opts.headless) {
      if (cur.idle) clearTimeout(cur.idle)
      return cur.ctx
    }
    if (cur) await this.close(siteId)
    const { chromium } = await loadPlaywright()
    let ctx: BrowserContext
    try {
      ctx = await chromium.launchPersistentContext(this.profileDir(siteId), {
        headless: opts.headless,
        channel: opts.channel || undefined,
        viewport: { width: 1280, height: 900 },
        args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check']
      })
    } catch (err) {
      throw wrapLaunchError(err)
    }
    ctx.on('close', () => {
      if (this.contexts.get(siteId)?.ctx === ctx) this.contexts.delete(siteId)
    })
    this.contexts.set(siteId, { ctx, headless: opts.headless })
    return ctx
  }

  /** Close the profile after a quiet period so Chromium is not left running. */
  release(siteId: string, idleMs = 5 * 60_000): void {
    const cur = this.contexts.get(siteId)
    if (!cur) return
    // Headed windows used for captcha/login should also idle-close so the profile lock is released.
    if (cur.idle) clearTimeout(cur.idle)
    cur.idle = setTimeout(() => void this.close(siteId), cur.headless ? idleMs : Math.min(idleMs, 60_000))
  }

  async close(siteId: string): Promise<void> {
    const cur = this.contexts.get(siteId)
    if (!cur) return
    this.contexts.delete(siteId)
    if (cur.idle) clearTimeout(cur.idle)
    await cur.ctx.close().catch(() => undefined)
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.contexts.keys()].map((k) => this.close(k)))
  }

  /** Serializes work per site; a profile can only drive one conversation at a time. */
  async withLock<T>(siteId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(siteId) ?? Promise.resolve()
    let release!: () => void
    const next = new Promise<void>((r) => (release = r))
    this.locks.set(siteId, prev.then(() => next))
    await prev
    try {
      return await fn()
    } finally {
      release()
    }
  }
}

let sharedBrowser: Browser | undefined

/** Throwaway headless browser for the browser_task tool. */
export async function scratchBrowser(channel?: string): Promise<Browser> {
  if (sharedBrowser?.isConnected()) return sharedBrowser
  const { chromium } = await loadPlaywright()
  try {
    sharedBrowser = await chromium.launch({ headless: true, channel: channel || undefined })
  } catch (err) {
    throw wrapLaunchError(err)
  }
  return sharedBrowser
}

export async function closeScratchBrowser(): Promise<void> {
  await sharedBrowser?.close().catch(() => undefined)
  sharedBrowser = undefined
}
