import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { ProviderError, type ChatMessage, type ChatOptions, type Delta, type ModelInfo, type Provider, type ProviderStatus, type ToolSpec } from '../../types'
import { sleep } from '../../util'
import { str, type ProviderContext } from '../context'
import { flattenConversation, followUpPrompt, latestUserText, parseEmulatedToolCalls, repairPrompt, threadPrompt, type EmulatedToolCalls } from '../emulated-tools'
import { BrowserMissingError, type ProfilePool } from './browser'
import { isSiteDefaultModel, pickModelOption, webDefaultModel, webModelInfo } from './model'
import { htmlToMarkdown, REPLY_SNAPSHOT_SOURCE } from './reply-markdown'
import { loadSiteConfig, type WebSiteConfig } from './sites'

const REPLY_TIMEOUT_MS = 240_000
const STABLE_MS = 2_000
/** Some sites ignore clicks on the model picker until the page has finished starting up. */
const MODEL_MENU_ATTEMPTS = 6
/** A kept-open tab is closed after this long without a request, in case an agent run never ended cleanly. */
const SESSION_IDLE_MS = 10 * 60_000

/** Errors that retrying on a fresh tab cannot fix: the user cancelled, or the site needs a human. */
function isFinal(err: unknown): boolean {
  return err instanceof ProviderError && (err.kind === 'aborted' || err.kind === 'captcha' || err.kind === 'not_logged_in')
}

/** Swaps the shown reply for its prose, so tool blocks appear only as tool steps, then emits the calls. */
function emitToolCalls(parsed: EmulatedToolCalls, push: (d: Delta) => void): void {
  if (!parsed.calls.length) return
  push({ type: 'text', text: parsed.text, replace: true })
  for (const call of parsed.calls) push({ type: 'tool_call', call })
}

/** Whether two page URLs are the same page, ignoring a trailing slash. */
function sameUrl(a: string, b: string): boolean {
  const trim = (u: string): string => u.replace(/\/+$/, '')
  return trim(a) === trim(b)
}

/**
 * A site tab that stays open between requests: the steps of one agent run, or the turns of one saved chat.
 * `sent` counts the messages the site has already seen (agent runs) or the user turns it holds (saved chats).
 */
interface WebSession {
  page: Page
  sent: number
  timer?: NodeJS.Timeout
}

/** Where a saved chat's site conversation lives, so it can be reopened after its tab closed. */
interface WebThread {
  url: string
  /** User turns the site conversation holds. */
  sent: number
}

/**
 * Drives a logged-in chat website in a persistent Chromium profile.
 * A request without a session opens a new conversation, pastes the flattened prompt and reads the last reply as it grows.
 * A request with a session (an agent run, or a saved chat) keeps its site conversation and types only what is new.
 */
export class WebChatProvider implements Provider {
  readonly kind = 'web' as const
  readonly experimental = true
  /** Tools are emulated through text, so the router may still pick this provider for agent work. */
  readonly supportsTools = false
  readonly tags = ['general' as const]
  readonly id: string
  readonly name: string
  readonly description: string
  private connecting = false
  private readonly sessions = new Map<string, WebSession>()
  /** Saved chats whose site conversation has its own URL. Outlives the tab, not the app. */
  private readonly threads = new Map<string, WebThread>()

  constructor(
    private readonly siteId: string,
    private readonly ctx: ProviderContext,
    private readonly pool: ProfilePool
  ) {
    const site = this.site()
    this.id = `web-${site.id.replace(/-web$/, '')}`
    this.name = `${site.name} (web)`
    this.description = `Drives ${new URL(site.url).host} in a browser profile you log in to once. Experimental: breaks when the site changes and may be against its terms.`
  }

  site(): WebSiteConfig {
    return loadSiteConfig(this.ctx.dataDir, this.siteId)
  }

  async models(): Promise<ModelInfo[]> {
    return [webModelInfo(this.site().name, this.ctx.config().model)]
  }

  async defaultModel(): Promise<string> {
    return webDefaultModel(this.ctx.config().model)
  }

  async status(): Promise<ProviderStatus> {
    if (this.connecting) return { state: 'needs_setup', message: 'Login window is open. Close it when you are signed in.' }
    const cfg = this.ctx.config()
    if (cfg.loggedIn === true) return { state: 'ready', message: cfg.checkedAt ? `Signed in (checked ${new Date(Number(cfg.checkedAt)).toLocaleString()})` : 'Signed in' }
    if (cfg.lastError) return { state: 'error', message: String(cfg.lastError) }
    // A failed Check login sets loggedIn=false; don't keep advertising ready for guest sites.
    if (cfg.loggedIn === false) {
      return { state: 'needs_setup', message: 'Could not find the chat box. Click Sign in (and turn on Show browser windows if the site shows a human check).' }
    }
    if (!this.site().loginRequired && cfg.connectedOnce) return { state: 'ready', message: 'Using the site without an account.' }
    return { state: 'needs_setup', message: 'Click Sign in and sign in once.' }
  }

  private headless(): boolean {
    return !this.ctx.settings().showBrowser
  }

  private channel(): string | undefined {
    return str(this.ctx.config().browserChannel)
  }

  /** Opens a visible browser on the site so the user can sign in. Resolves when the window is closed. */
  async connect(): Promise<void> {
    if (this.connecting) return
    this.connecting = true
    try {
      await this.dropAllSessions()
      await this.pool.close(this.siteId)
      const context = await this.pool.context(this.siteId, { headless: false, channel: this.channel() })
      const page = context.pages()[0] ?? (await context.newPage())
      await page.goto(this.site().url, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => undefined)
      await new Promise<void>((resolve) => context.once('close', () => resolve()))
    } catch (err) {
      this.ctx.saveConfig({ lastError: err instanceof Error ? err.message : String(err) })
      throw err
    } finally {
      this.connecting = false
    }
    this.ctx.saveConfig({ connectedOnce: true })
    await this.checkLogin().catch(() => undefined)
  }

  async disconnect(): Promise<void> {
    await this.dropAllSessions()
    await this.pool.close(this.siteId)
    const { rmSync } = await import('node:fs')
    rmSync(this.pool.profileDir(this.siteId), { recursive: true, force: true })
    this.ctx.saveConfig({ loggedIn: false, connectedOnce: false, checkedAt: Date.now(), lastError: null })
  }

  /** Loads the site headless and checks for the signed-out marker and the prompt box. */
  async checkLogin(): Promise<boolean> {
    return this.pool.withLock(this.siteId, async () => {
      const site = this.site()
      try {
        const context = await this.pool.context(this.siteId, { headless: this.headless(), channel: this.channel() })
        const page = await context.newPage()
        try {
          await page.goto(site.newChatUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 })
          const state = await this.waitForState(page, site, 20_000)
          const loggedIn = state === 'ready'
          this.ctx.saveConfig({ loggedIn, checkedAt: Date.now(), lastError: state === 'captcha' ? 'The site is showing a human check. Click Connect and solve it.' : null })
          return loggedIn
        } finally {
          await page.close().catch(() => undefined)
          this.pool.release(this.siteId)
        }
      } catch (err) {
        this.ctx.saveConfig({ loggedIn: false, checkedAt: Date.now(), lastError: err instanceof Error ? err.message : String(err) })
        return false
      }
    })
  }

  private async waitForState(page: Page, site: WebSiteConfig, timeoutMs: number): Promise<'ready' | 'logged_out' | 'captcha' | 'unknown'> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const title = await page.title().catch(() => '')
      // Cloudflare interstitial often has no matching iframe yet, only this title.
      if (/just a moment/i.test(title)) return 'captcha'
      if (site.captcha && (await page.locator(site.captcha).count().catch(() => 0))) return 'captcha'
      // Prefer the prompt box: guest UIs often still show a Log in banner.
      if ((await page.locator(site.input).count().catch(() => 0)) > 0) return 'ready'
      const loggedOut = site.loginRequired && (await page.locator(site.loggedOutSelector).count().catch(() => 0)) > 0
      if (loggedOut) return 'logged_out'
      await sleep(500)
    }
    // Still stuck on the challenge title after the timeout → treat as captcha, not a missing selector.
    if (/just a moment/i.test(await page.title().catch(() => ''))) return 'captcha'
    return 'unknown'
  }

  async *chat(messages: ChatMessage[], opts: ChatOptions): AsyncIterable<Delta> {
    const tools = opts.tools?.length ? opts.tools : undefined
    // Tools only work through the full emulated-tool prompt, so plain-text mode applies to chat only.
    const plain = this.ctx.settings().webPlainText && !tools
    const plainText = plain ? latestUserText(messages) : undefined
    const prompt = plainText ?? flattenConversation(messages, tools)
    const site = this.site()
    const queue: Delta[] = []
    let finished = false
    let failure: unknown
    let wake: (() => void) | undefined
    const push = (d: Delta): void => {
      queue.push(d)
      wake?.()
    }

    // A session id without tools is a saved chat (one site conversation per chat). With tools it is an agent run,
    // which keeps one tab across its steps. Anything else is a one-off in its own tab.
    const inThread = !!opts.sessionId && !tools
    const inRun = !!opts.sessionId && !!tools

    const work = this.pool
      .withLock(this.siteId, async () => {
        if (inThread) await this.runInThread(site, messages, opts, push)
        else if (inRun) await this.runInSession(site, messages, opts, push)
        else {
          const full = await this.runConversation(site, prompt, opts, push)
          if (tools) emitToolCalls(parseEmulatedToolCalls(full, tools), push)
        }
      })
      .then(
        () => undefined,
        (err) => {
          failure = err
        }
      )
      .finally(() => {
        finished = true
        wake?.()
      })

    while (true) {
      if (queue.length) {
        yield queue.shift()!
        continue
      }
      if (finished) break
      await new Promise<void>((r) => (wake = r))
      wake = undefined
    }
    await work
    if (failure) throw failure
  }

  /** One request in its own tab: open a new chat, send the prompt, read the reply, close the tab. */
  private async runConversation(site: WebSiteConfig, prompt: string, opts: ChatOptions, push: (d: Delta) => void): Promise<string> {
    let page: Page | undefined
    try {
      page = await this.openChat(site, opts, push)
      return await this.sendAndRead(page, site, prompt, opts, push)
    } catch (err) {
      throw this.toProviderError(err, site)
    } finally {
      await page?.close().catch(() => undefined)
      this.pool.release(this.siteId)
    }
  }

  /**
   * One request of an agent run. The first call opens a chat and sends the whole conversation; later calls
   * type only the new tool results into the same tab. If the tab is gone or fails, it starts over on a new chat.
   */
  private async runInSession(site: WebSiteConfig, messages: ChatMessage[], opts: ChatOptions, push: (d: Delta) => void): Promise<string> {
    const sessionId = opts.sessionId!
    const tools = opts.tools!
    try {
      // Reusing the profile context also cancels its idle-close timer while the run is active.
      await this.pool.context(this.siteId, { headless: this.headless(), channel: this.channel() })
      let session = this.sessions.get(sessionId)
      if (session && session.page.isClosed()) {
        await this.dropSession(sessionId)
        session = undefined
      }

      if (session) {
        if (session.timer) clearTimeout(session.timer)
        let produced = false
        const track = (d: Delta): void => {
          if (d.type === 'text') produced = true
          push(d)
        }
        try {
          const reply = await this.sendAndRead(session.page, site, followUpPrompt(messages.slice(session.sent), tools), opts, track)
          session.sent = messages.length
          await this.readToolCalls(session.page, site, reply, tools, opts, track)
          this.armSession(sessionId, session)
          return reply
        } catch (err) {
          const kind = err instanceof ProviderError ? err.kind : undefined
          const final = opts.signal?.aborted || produced || kind === 'aborted' || kind === 'captcha' || kind === 'not_logged_in'
          if (final) throw err
          // The tab went stale (closed, prompt box missing, no reply). Start over with the full conversation.
          await this.dropSession(sessionId)
          push({ type: 'status', message: `Reopening ${site.name}…` })
        }
      }

      const page = await this.openChat(site, opts, push)
      const fresh: WebSession = { page, sent: 0 }
      // Register before sending so endSession can close the tab even if this request is cancelled.
      this.sessions.set(sessionId, fresh)
      const reply = await this.sendAndRead(page, site, flattenConversation(messages, tools), opts, push)
      fresh.sent = messages.length
      await this.readToolCalls(page, site, reply, tools, opts, push)
      this.armSession(sessionId, fresh)
      return reply
    } catch (err) {
      await this.dropSession(sessionId)
      throw this.toProviderError(err, site)
    } finally {
      this.pool.release(this.siteId)
    }
  }

  /**
   * Emits the tool calls in an agent step's reply. When the reply holds a call that cannot be read, the site is asked
   * once, in the same chat, to resend it; the broken reply is cleared so only the corrected one is shown.
   */
  private async readToolCalls(page: Page, site: WebSiteConfig, reply: string, tools: ToolSpec[], opts: ChatOptions, push: (d: Delta) => void): Promise<void> {
    let parsed = parseEmulatedToolCalls(reply, tools)
    if (!parsed.calls.length && parsed.malformed && !opts.signal?.aborted) {
      push({ type: 'text', text: '', replace: true })
      push({ type: 'status', message: `Asking ${site.name} to resend its tool call…` })
      parsed = parseEmulatedToolCalls(await this.sendAndRead(page, site, repairPrompt(tools), opts, push), tools)
    }
    emitToolCalls(parsed, push)
  }

  /**
   * One turn of a saved chat. The first turn opens a site chat; later turns type only the new message into the same tab.
   * When the tab is gone, the saved conversation URL is reopened. When that is not possible either, a new site chat
   * receives the earlier turns once so the model still has the thread.
   */
  private async runInThread(site: WebSiteConfig, messages: ChatMessage[], opts: ChatOptions, push: (d: Delta) => void): Promise<string> {
    const sessionId = opts.sessionId!
    const plain = this.ctx.settings().webPlainText
    const users = messages.filter((m) => m.role === 'user').length
    try {
      // Reusing the profile context also cancels its idle-close timer while the chat is active.
      await this.pool.context(this.siteId, { headless: this.headless(), channel: this.channel() })
      let session = this.sessions.get(sessionId)
      if (session && session.page.isClosed()) {
        await this.dropSession(sessionId)
        session = undefined
      }

      if (session) {
        if (session.timer) clearTimeout(session.timer)
        let produced = false
        const track = (d: Delta): void => {
          if (d.type === 'text') produced = true
          push(d)
        }
        try {
          const reply = await this.sendAndRead(session.page, site, threadPrompt(messages, { plain, known: session.sent }), opts, track)
          this.finishTurn(sessionId, session, users, site)
          return reply
        } catch (err) {
          if (opts.signal?.aborted || produced || isFinal(err)) throw err
          // The tab went stale (closed, prompt box missing, no reply). Reopen the conversation below.
          await this.dropSession(sessionId)
          push({ type: 'status', message: `Reopening ${site.name}…` })
        }
      }

      let page: Page | undefined
      let known: number | undefined
      const saved = this.threads.get(sessionId)
      if (saved) {
        try {
          page = await this.openChat(site, opts, push, saved.url)
          known = saved.sent
        } catch (err) {
          if (opts.signal?.aborted || isFinal(err)) throw err
          this.threads.delete(sessionId)
        }
      }
      page ??= await this.openChat(site, opts, push)
      const fresh: WebSession = { page, sent: known ?? 0 }
      // Register before sending so endSession can close the tab even if this request is cancelled.
      this.sessions.set(sessionId, fresh)
      const reply = await this.sendAndRead(page, site, threadPrompt(messages, { plain, known }), opts, push)
      this.finishTurn(sessionId, fresh, users, site)
      return reply
    } catch (err) {
      await this.dropSession(sessionId)
      throw this.toProviderError(err, site)
    } finally {
      this.pool.release(this.siteId)
    }
  }

  /** Records what the site conversation holds after a turn, and where it lives so a closed tab can be reopened. */
  private finishTurn(sessionId: string, session: WebSession, users: number, site: WebSiteConfig): void {
    session.sent = users
    const url = session.page.isClosed() ? '' : session.page.url()
    if (url && url !== 'about:blank' && !sameUrl(url, site.newChatUrl)) this.threads.set(sessionId, { url, sent: users })
    else this.threads.delete(sessionId)
    this.armSession(sessionId, session)
  }

  /** Releases the tab and the saved conversation of an agent run or a chat. Called when the run ends or the chat is deleted. */
  async endSession(sessionId: string): Promise<void> {
    this.threads.delete(sessionId)
    await this.dropSession(sessionId)
  }

  private armSession(sessionId: string, session: WebSession): void {
    if (session.timer) clearTimeout(session.timer)
    // Safety net for a run that never ends cleanly. Longer than a typical approval wait.
    session.timer = setTimeout(() => void this.dropSession(sessionId), SESSION_IDLE_MS)
    session.timer.unref?.()
  }

  private async dropSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.sessions.delete(sessionId)
    if (session.timer) clearTimeout(session.timer)
    await session.page.close().catch(() => undefined)
  }

  private async dropAllSessions(): Promise<void> {
    // Signing in or out can change the account, so saved site conversations may no longer be reachable.
    this.threads.clear()
    await Promise.all([...this.sessions.keys()].map((id) => this.dropSession(id)))
  }

  private toProviderError(err: unknown, site: WebSiteConfig): ProviderError {
    if (err instanceof ProviderError) return err
    if (err instanceof BrowserMissingError) return new ProviderError(this.id, 'unavailable', err.message)
    return new ProviderError(this.id, 'server', `${site.name} automation failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  /**
   * Opens a new tab on a fresh chat, checks the login state and selects the configured model.
   * With `resumeUrl` it opens that existing conversation instead and leaves its model as it was.
   */
  private async openChat(site: WebSiteConfig, opts: ChatOptions, push: (d: Delta) => void, resumeUrl?: string): Promise<Page> {
    push({ type: 'status', message: `Opening ${site.name}…` })
    const context = await this.pool.context(this.siteId, { headless: this.headless(), channel: this.channel() })
    const page = await context.newPage()
    try {
      await page.goto(resumeUrl ?? site.newChatUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 })
      const state = await this.waitForState(page, site, 25_000)
      if (state === 'captcha') throw new ProviderError(this.id, 'captcha', `${site.name} is asking for a human check. Open Customize → Providers and click Connect to solve it.`)
      if (state === 'logged_out') {
        this.ctx.saveConfig({ loggedIn: false, checkedAt: Date.now() })
        throw new ProviderError(this.id, 'not_logged_in', `Not signed in to ${site.name}. Click Connect in Customize → Providers.`)
      }
      if (state !== 'ready') throw new ProviderError(this.id, 'unavailable', `Could not find the prompt box on ${site.name}. The site layout may have changed; edit its selectors in Customize.`)

      const wanted = opts.model ?? str(this.ctx.config().model)
      if (!resumeUrl && !isSiteDefaultModel(wanted)) {
        push({ type: 'status', message: `Selecting ${wanted} on ${site.name}…` })
        await this.selectModel(page, site, wanted!.trim())
      }
      return page
    } catch (err) {
      await page.close().catch(() => undefined)
      throw err
    }
  }

  /** Types the prompt into an open chat and streams the new reply until it stops changing. Returns the full reply. */
  private async sendAndRead(page: Page, site: WebSiteConfig, prompt: string, opts: ChatOptions, push: (d: Delta) => void): Promise<string> {
    const before = await this.readReplies(page, site)
    await this.typePrompt(page, site, prompt)
    push({ type: 'status', message: `Waiting for ${site.name} to reply…` })

    let emitted = ''
    let lastChange = Date.now()
    let lastText = ''
    const started = Date.now()
    while (true) {
      if (opts.signal?.aborted) throw new ProviderError(this.id, 'aborted', 'Cancelled')
      if (Date.now() - started > REPLY_TIMEOUT_MS) {
        if (emitted) break
        throw new ProviderError(this.id, 'timeout', `${site.name} did not reply within ${REPLY_TIMEOUT_MS / 1000}s`)
      }
      const now = await this.readReplies(page, site)
      const current = now.count > before.count ? now.last : now.last !== before.last ? now.last : ''
      if (current !== lastText) {
        lastText = current
        lastChange = Date.now()
        if (current.startsWith(emitted)) {
          if (current.length > emitted.length) push({ type: 'text', text: current.slice(emitted.length) })
          emitted = current
        } else if (current) {
          // The converted markdown was rewritten (e.g. a table row finished), so swap the reply instead of appending.
          push({ type: 'text', text: current, replace: true })
          emitted = current
        }
      }
      const generating = site.generating ? (await page.locator(site.generating).count().catch(() => 0)) > 0 : false
      if (current && !generating && Date.now() - lastChange > STABLE_MS) break
      if (site.captcha && (await page.locator(site.captcha).count().catch(() => 0))) {
        throw new ProviderError(this.id, 'captcha', `${site.name} asked for a human check mid-reply.`)
      }
      await sleep(350)
    }
    if (lastText && lastText !== emitted) push({ type: 'text', text: lastText, replace: true })
    this.ctx.saveConfig({ loggedIn: true, checkedAt: Date.now(), lastError: null, connectedOnce: true })
    return lastText
  }

  /** Opens the site's own model menu and clicks the entry that matches `model`. */
  private async selectModel(page: Page, site: WebSiteConfig, model: string): Promise<void> {
    if (!site.modelPicker || !site.modelOption) {
      throw new ProviderError(
        this.id,
        'bad_request',
        `${site.name} has no model menu configured, so "${model}" cannot be selected. Clear the Model name, or add modelPicker and modelOption under Selectors.`
      )
    }
    const picker = page.locator(site.modelPicker).first()
    const options = page.locator(site.modelOption)

    // A click made before the page finishes loading can open nothing, so retry a few times.
    // The menu fills in after it opens, so wait for an entry that matches rather than for any entry.
    let texts: string[] = []
    let index = -1
    for (let attempt = 0; attempt < MODEL_MENU_ATTEMPTS && index < 0; attempt++) {
      if (attempt > 0) await sleep(1_500)
      try {
        await picker.click({ timeout: 10_000 })
      } catch {
        if (attempt === MODEL_MENU_ATTEMPTS - 1) throw new ProviderError(this.id, 'bad_request', `Could not open the ${site.name} model menu. The site layout may have changed; edit modelPicker under Selectors.`)
        continue
      }
      const deadline = Date.now() + 3_000
      while (Date.now() < deadline) {
        texts = await options.allInnerTexts().catch(() => [])
        index = pickModelOption(texts, model)
        if (index >= 0) break
        await sleep(200)
      }
      if (index >= 0) break
      await page.keyboard.press('Escape').catch(() => undefined)
      // The menu opened and listed entries, none of which match: retrying will not help.
      if (texts.some((t) => t.trim())) break
    }
    if (index < 0) {
      await page.keyboard.press('Escape').catch(() => undefined)
      const available = texts.map((t) => t.split('\n')[0].trim()).filter(Boolean)
      throw new ProviderError(
        this.id,
        'bad_request',
        available.length
          ? `${site.name} has no model matching "${model}". Its menu offers: ${available.join(', ')}.`
          : `Could not read any entries from the ${site.name} model menu. The page may still be loading, or modelPicker / modelOption under Selectors may be out of date.`
      )
    }
    const entry = options.nth(index)
    const disabled = await entry
      .evaluate((el) => (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('data-disabled'))
      .catch(() => false)
    if (disabled) {
      await page.keyboard.press('Escape').catch(() => undefined)
      throw new ProviderError(this.id, 'bad_request', `${site.name} lists "${model}" but it is disabled, usually because it needs a signed-in or paid account.`)
    }
    await entry.click({ timeout: 10_000 })
    await sleep(600)
  }

  /**
   * Reads the last reply as markdown so tables and code keep their structure; falls back to the visible text.
   * Evaluated as a string (not a function) so a site's CSP cannot block the snapshot code.
   */
  private async readReplies(page: Page, site: WebSiteConfig): Promise<{ count: number; last: string }> {
    const expression = `(() => {
      const snapshot = ${REPLY_SNAPSHOT_SOURCE};
      const nodes = Array.from(document.querySelectorAll(${JSON.stringify(site.reply)}));
      const roots = nodes.filter((n) => !nodes.some((o) => o !== n && o.contains(n)));
      const last = roots[roots.length - 1];
      let html = '';
      try { html = last ? snapshot(last) : ''; } catch (e) { html = ''; }
      return { count: nodes.length, text: ((last && last.innerText) || '').trim(), html };
    })()`
    const raw = await page.evaluate<{ count: number; text: string; html: string }>(expression).catch(() => ({ count: 0, text: '', html: '' }))
    let markdown = ''
    try {
      markdown = htmlToMarkdown(raw.html)
    } catch {
      markdown = ''
    }
    if (raw.text && !markdown) this.warnFallback(site)
    this.dumpReply(site, raw.html, markdown || raw.text)
    return { count: raw.count, last: markdown || raw.text }
  }

  private warnedFallback = false
  private lastDump = ''

  /** The markdown conversion produced nothing, so the plain innerText is used and code blocks lose their structure. */
  private warnFallback(site: WebSiteConfig): void {
    if (this.warnedFallback) return
    this.warnedFallback = true
    console.warn(`[freeagent] ${site.name}: could not read the reply as markdown, using plain text. Set FREEAGENT_DEBUG_WEB_REPLY=1 to capture the page markup.`)
  }

  /** With FREEAGENT_DEBUG_WEB_REPLY=1, saves the latest reply snapshot and its markdown under <dataDir>/web-debug/. */
  private dumpReply(site: WebSiteConfig, html: string, markdown: string): void {
    if (process.env.FREEAGENT_DEBUG_WEB_REPLY !== '1' || !(html || markdown)) return
    const key = `${html}\u0000${markdown}`
    if (key === this.lastDump) return
    this.lastDump = key
    try {
      const dir = join(this.ctx.dataDir, 'web-debug')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, `${this.siteId}.html`), html)
      writeFileSync(join(dir, `${this.siteId}.md`), markdown)
    } catch {
      // Debug output must never break a chat.
    }
  }

  private async typePrompt(page: Page, site: WebSiteConfig, prompt: string): Promise<void> {
    const input = page.locator(site.input).first()
    await input.click({ timeout: 10_000 })
    const tag = await input.evaluate((el) => el.tagName.toLowerCase())
    // Prefer keyboard input: Angular/React composers often ignore fill() and leave Send disabled.
    if (tag === 'textarea' || tag === 'input') await input.fill('')
    await page.keyboard.insertText(prompt)
    await sleep(400)

    if (!site.send) {
      await page.keyboard.press('Enter')
      return
    }

    const send = page.locator(site.send).first()
    // Wait until the site enables Submit after text lands (Gemini keeps it disabled briefly).
    const deadline = Date.now() + 8_000
    while (Date.now() < deadline) {
      if ((await send.count().catch(() => 0)) > 0) {
        const enabled = await send.isEnabled().catch(() => false)
        const ariaDisabled = (await send.getAttribute('aria-disabled').catch(() => null)) === 'true'
        if (enabled && !ariaDisabled) {
          await send.click({ timeout: 5_000 })
          return
        }
      }
      await sleep(200)
    }

    if (site.requireSendClick) {
      // Last resort: force the submit control — never Enter on these sites.
      await send.click({ timeout: 5_000, force: true })
      return
    }
    await page.keyboard.press('Enter')
  }
}
