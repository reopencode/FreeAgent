import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { readPlugin, readSkill, type PluginDoc } from './instructions'
import type { ProviderRegistry } from '../providers/registry'
import { scratchBrowser } from '../providers/web/browser'
import type { Store } from '../store'
import type { ToolSpec } from '../types'
import { applyTextDelta, htmlToText, runProcess, truncate, which } from '../util'

export interface ToolContext {
  cwd: string
  signal?: AbortSignal
  registry: ProviderRegistry
  dataDir: string
  store: Store
  chatId?: string
}

export interface ToolImage {
  mime: string
  name?: string
  base64: string
}

export type ToolResult = string | { text: string; images?: ToolImage[] }

export interface AgentTool {
  spec: ToolSpec
  requiresApproval: boolean
  summarize(args: Record<string, unknown>): string
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>
}

const MAX_OUTPUT = 16_000

/** Resolves a path inside the workspace and refuses anything that escapes it. */
export function resolveInside(root: string, p: unknown): string {
  const target = resolve(root, typeof p === 'string' && p ? p : '.')
  const rel = relative(root, target)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Path "${String(p)}" is outside the project folder`)
  return target
}

const s = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)

const fsList: AgentTool = {
  spec: {
    name: 'fs_list',
    description: 'List files and folders in the project folder (non-recursive unless depth > 1).',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Folder relative to the project root. Defaults to the root.' }, depth: { type: 'number', description: '1 to 3' } }
    }
  },
  requiresApproval: false,
  summarize: (a) => `List ${s(a.path, '.')}`,
  async run(a, ctx) {
    const root = resolveInside(ctx.cwd, a.path)
    const depth = Math.min(Math.max(Number(a.depth) || 1, 1), 3)
    const lines: string[] = []
    const walk = (dir: string, level: number): void => {
      for (const name of readdirSync(dir).sort()) {
        if (name === 'node_modules' || name === '.git') continue
        const full = join(dir, name)
        const st = statSync(full)
        lines.push(`${'  '.repeat(level)}${name}${st.isDirectory() ? '/' : ` (${st.size} B)`}`)
        if (st.isDirectory() && level + 1 < depth) walk(full, level + 1)
        if (lines.length > 500) return
      }
    }
    walk(root, 0)
    return lines.join('\n') || '(empty folder)'
  }
}

const fsRead: AgentTool = {
  spec: {
    name: 'fs_read',
    description: 'Read a text file from the project folder.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  },
  requiresApproval: false,
  summarize: (a) => `Read ${s(a.path)}`,
  async run(a, ctx) {
    return truncate(readFileSync(resolveInside(ctx.cwd, a.path), 'utf8'), MAX_OUTPUT)
  }
}

const fsWrite: AgentTool = {
  spec: {
    name: 'fs_write',
    description: 'Create or overwrite a text file in the project folder.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] }
  },
  requiresApproval: true,
  summarize: (a) => `Write ${s(a.content).length} characters to ${s(a.path)}`,
  async run(a, ctx) {
    const target = resolveInside(ctx.cwd, a.path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, s(a.content))
    return `Wrote ${s(a.content).length} characters to ${relative(ctx.cwd, target)}`
  }
}

const shellExec: AgentTool = {
  spec: {
    name: 'shell_exec',
    description: 'Run a shell command in the project folder and return its output.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' }, timeout_seconds: { type: 'number', description: 'Default 60, max 600' } },
      required: ['command']
    }
  },
  requiresApproval: true,
  summarize: (a) => `$ ${s(a.command)}`,
  async run(a, ctx) {
    const timeoutMs = Math.min(Math.max(Number(a.timeout_seconds) || 60, 1), 600) * 1000
    const isWin = process.platform === 'win32'
    const res = await runProcess(isWin ? 'cmd.exe' : '/bin/bash', isWin ? ['/d', '/s', '/c', s(a.command)] : ['-lc', s(a.command)], {
      cwd: ctx.cwd,
      timeoutMs,
      signal: ctx.signal
    })
    const out = [`exit code: ${res.timedOut ? 'timed out' : res.code}`, res.stdout && `stdout:\n${res.stdout}`, res.stderr && `stderr:\n${res.stderr}`]
    return truncate(out.filter(Boolean).join('\n'), MAX_OUTPUT)
  }
}

const runCode: AgentTool = {
  spec: {
    name: 'run_code',
    description: 'Run a JavaScript (Node.js) or Python snippet in a temporary folder and return stdout/stderr.',
    parameters: {
      type: 'object',
      properties: { language: { type: 'string', enum: ['javascript', 'python'] }, code: { type: 'string' } },
      required: ['language', 'code']
    }
  },
  requiresApproval: true,
  summarize: (a) => `Run ${s(a.language)} (${s(a.code).split('\n').length} lines)`,
  async run(a, ctx) {
    const dir = await mkdtemp(join(tmpdir(), 'freeagent-run-'))
    try {
      const py = s(a.language) === 'python'
      const file = join(dir, py ? 'main.py' : 'main.mjs')
      await writeFile(file, s(a.code))
      const bin = py ? (which('python3') ?? which('python') ?? 'python3') : process.execPath
      const res = await runProcess(bin, [file], {
        cwd: dir,
        timeoutMs: 60_000,
        signal: ctx.signal,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      })
      return truncate(`exit code: ${res.timedOut ? 'timed out' : res.code}\n${res.stdout}${res.stderr ? `\nstderr:\n${res.stderr}` : ''}`, MAX_OUTPUT)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
}

const webFetch: AgentTool = {
  spec: {
    name: 'web_fetch',
    description: 'Download a web page or API response and return it as readable text.',
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }
  },
  requiresApproval: false,
  summarize: (a) => `Fetch ${s(a.url)}`,
  async run(a, ctx) {
    const url = s(a.url)
    if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) URLs are allowed')
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (FreeAgent desktop)' },
      signal: ctx.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      redirect: 'follow'
    })
    const type = res.headers.get('content-type') ?? ''
    const body = await res.text()
    const text = type.includes('html') ? htmlToText(body) : body
    return truncate(`HTTP ${res.status} ${type}\n\n${text}`, MAX_OUTPUT)
  }
}

export function parseDuckDuckGo(html: string): { title: string; url: string; snippet: string }[] {
  const results: { title: string; url: string; snippet: string }[] = []
  const segments = html.split(/(?=<a[^>]+class="result__a")/).slice(1)
  for (const seg of segments) {
    const m = /^<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(seg)
    if (!m) continue
    let url = m[1].replace(/&amp;/g, '&')
    const uddg = /[?&]uddg=([^&]+)/.exec(url)
    if (uddg) url = decodeURIComponent(uddg[1])
    if (url.startsWith('//')) url = 'https:' + url
    const snippet = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(seg)
    results.push({ title: htmlToText(m[2]), url, snippet: htmlToText(snippet?.[1] ?? '') })
    if (results.length >= 8) break
  }
  return results
}

const webSearch: AgentTool = {
  spec: {
    name: 'web_search',
    description: 'Search the web (DuckDuckGo) and return the top results with links and snippets.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
  },
  requiresApproval: false,
  summarize: (a) => `Search "${s(a.query)}"`,
  async run(a, ctx) {
    const res = await fetch('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0 (FreeAgent desktop)' },
      body: new URLSearchParams({ q: s(a.query) }).toString(),
      signal: ctx.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000)
    })
    const results = parseDuckDuckGo(await res.text())
    if (!results.length) return 'No results found.'
    return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n')
  }
}

const browserTask: AgentTool = {
  spec: {
    name: 'browser_task',
    description:
      'Open a page in a headless browser (runs JavaScript), optionally click/fill/press, then return the visible text, the links, or a screenshot. Use for pages web_fetch cannot read. A screenshot is shown in the thread.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        actions: {
          type: 'array',
          description: 'Steps run in order',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['click', 'fill', 'press', 'wait'] },
              selector: { type: 'string' },
              text: { type: 'string', description: 'Text for fill, key for press, milliseconds for wait' }
            },
            required: ['type']
          }
        },
        extract: { type: 'string', enum: ['text', 'links', 'screenshot'] }
      },
      required: ['url']
    }
  },
  requiresApproval: false,
  summarize: (a) => `Browse ${s(a.url)}`,
  async run(a) {
    const url = s(a.url)
    if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) URLs are allowed')
    const browser = await scratchBrowser()
    const page = await browser.newPage()
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      for (const step of (Array.isArray(a.actions) ? a.actions : []) as { type: string; selector?: string; text?: string }[]) {
        if (step.type === 'click' && step.selector) await page.click(step.selector, { timeout: 10_000 })
        if (step.type === 'fill' && step.selector) await page.fill(step.selector, step.text ?? '', { timeout: 10_000 })
        if (step.type === 'press') await page.keyboard.press(step.text ?? 'Enter')
        if (step.type === 'wait') await page.waitForTimeout(Math.min(Number(step.text) || 1000, 10_000))
      }
      await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined)
      if (a.extract === 'links') {
        const links = await page.$$eval('a[href]', (els) => els.slice(0, 200).map((e) => `${(e as HTMLAnchorElement).innerText.trim().slice(0, 80)} — ${(e as HTMLAnchorElement).href}`))
        return truncate(links.join('\n'), MAX_OUTPUT)
      }
      if (a.extract === 'screenshot') {
        const png = await page.screenshot({ type: 'png' })
        return {
          text: `Screenshot of ${page.url()} is shown in the thread.`,
          images: [{ mime: 'image/png', name: 'screenshot.png', base64: Buffer.from(png).toString('base64') }]
        }
      }
      return truncate(`${await page.title()}\n${page.url()}\n\n${await page.innerText('body')}`, MAX_OUTPUT)
    } finally {
      await page.close().catch(() => undefined)
    }
  }
}

const delegateToApp: AgentTool = {
  spec: {
    name: 'delegate_to_app',
    description:
      'Hand a self-contained coding task to a local coding agent (OpenCode, Kiro, Kilo or Claude Code). It works in the project folder and can edit files. Returns its final report.',
    parameters: {
      type: 'object',
      properties: {
        app: { type: 'string', enum: ['opencode', 'kiro', 'kilo', 'claude'] },
        task: { type: 'string', description: 'Full, specific instructions. The agent does not see this conversation.' }
      },
      required: ['app', 'task']
    }
  },
  requiresApproval: true,
  summarize: (a) => `Ask ${s(a.app)}: ${s(a.task).slice(0, 140)}`,
  async run(a, ctx) {
    const p = ctx.registry.get(s(a.app))
    if (!p || p.kind !== 'app') throw new Error(`Unknown app "${s(a.app)}"`)
    const st = await p.status()
    if (st.state !== 'ready') throw new Error(`${p.name} is not ready: ${st.message ?? st.state}`)
    let text = ''
    const statuses: string[] = []
    for await (const d of p.chat([{ role: 'user', content: s(a.task) }], { cwd: ctx.cwd, signal: ctx.signal })) {
      if (d.type === 'text') text = applyTextDelta(text, d)
      if (d.type === 'status') statuses.push(d.message)
    }
    const trail = statuses.length ? `Steps:\n${statuses.slice(-15).join('\n')}\n\n` : ''
    return truncate(`${trail}${text.trim() || '(no text output)'}`, MAX_OUTPUT)
  }
}

const gitEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_AUTHOR_NAME: 'FreeAgent',
  GIT_AUTHOR_EMAIL: 'freeagent@localhost',
  GIT_COMMITTER_NAME: 'FreeAgent',
  GIT_COMMITTER_EMAIL: 'freeagent@localhost'
})

async function gitOk(cwd: string, args: string[], timeoutMs = 20_000): Promise<string> {
  const res = await runProcess('git', args, { cwd, env: gitEnv(), timeoutMs })
  if (res.code !== 0) throw new Error((res.stderr || res.stdout || 'git failed').trim())
  return (res.stdout || res.stderr).trim()
}

const gitStatus: AgentTool = {
  spec: {
    name: 'git_status',
    description: 'Show git status for the project folder. Read-only.',
    parameters: { type: 'object', properties: {} }
  },
  requiresApproval: false,
  summarize: () => 'Git status',
  async run(_a, ctx) {
    return truncate(await gitOk(ctx.cwd, ['status', '--short', '--branch']), MAX_OUTPUT)
  }
}

const gitDiff: AgentTool = {
  spec: {
    name: 'git_diff',
    description: 'Show unstaged and staged diffs in the project folder. Read-only. Optional path must stay inside the folder.',
    parameters: { type: 'object', properties: { path: { type: 'string' } } }
  },
  requiresApproval: false,
  summarize: (a) => `Git diff ${s(a.path) || ''}`.trim(),
  async run(a, ctx) {
    const pathArg = s(a.path)
    const rel = pathArg ? relative(ctx.cwd, resolveInside(ctx.cwd, pathArg)) : ''
    const unstaged = await gitOk(ctx.cwd, rel ? ['diff', '--', rel] : ['diff'])
    const staged = await gitOk(ctx.cwd, rel ? ['diff', '--cached', '--', rel] : ['diff', '--cached'])
    const text = [unstaged && `Unstaged:\n${unstaged}`, staged && `Staged:\n${staged}`].filter(Boolean).join('\n\n')
    return truncate(text || 'No diff.', MAX_OUTPUT)
  }
}

const gitCommit: AgentTool = {
  spec: {
    name: 'git_commit',
    description: 'Stage the given paths inside the project folder and commit them. Does not push.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Files to stage, relative to the project folder' }
      },
      required: ['message', 'paths']
    }
  },
  requiresApproval: true,
  summarize: (a) => `Commit "${s(a.message)}" (${Array.isArray(a.paths) ? a.paths.length : 0} files)`,
  async run(a, ctx) {
    const message = s(a.message).trim()
    if (!message) throw new Error('Commit message is required')
    const paths = (Array.isArray(a.paths) ? a.paths : []).map((p) => relative(ctx.cwd, resolveInside(ctx.cwd, p))).filter(Boolean)
    if (!paths.length) throw new Error('Name the files to commit')
    await gitOk(ctx.cwd, ['rev-parse', '--is-inside-work-tree'])
    await gitOk(ctx.cwd, ['add', '--', ...paths])
    return truncate(await gitOk(ctx.cwd, ['-c', 'user.name=FreeAgent', '-c', 'user.email=freeagent@localhost', 'commit', '-m', message]), MAX_OUTPUT)
  }
}

function pluginIdsForChat(ctx: ToolContext): string[] {
  if (!ctx.chatId) throw new Error('No chat is open for this plugin change')
  const chat = ctx.store.getChat(ctx.chatId)
  if (!chat) throw new Error('Chat not found')
  if (chat.pluginIds !== null) return [...chat.pluginIds]
  const project = chat.projectId ? ctx.store.getProject(chat.projectId) : undefined
  return [...(project?.enabledPlugins ?? [])]
}

function rememberPlugin(ctx: ToolContext, ids: string[]): void {
  if (!ctx.chatId) throw new Error('No chat is open for this plugin change')
  ctx.store.updateChat(ctx.chatId, { pluginIds: ids })
}

const readSkillTool: AgentTool = {
  spec: {
    name: 'read_skill',
    description: 'Read one reusable skill by name. Skill names are listed in the instructions.',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
  },
  requiresApproval: false,
  summarize: (a) => `Read skill ${s(a.name)}`,
  async run(a, ctx) {
    return readSkill(ctx.dataDir, ctx.cwd, s(a.name))
  }
}

const enablePlugin: AgentTool = {
  spec: {
    name: 'enable_plugin',
    description: 'Turn a plugin on for this chat. Its instructions are included from the next message, and the body is returned now.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
  },
  requiresApproval: false,
  summarize: (a) => `Enable plugin ${s(a.id)}`,
  async run(a, ctx) {
    const doc: PluginDoc | undefined = readPlugin(ctx.dataDir, s(a.id))
    if (!doc) throw new Error(`Unknown plugin "${s(a.id)}"`)
    const ids = new Set(pluginIdsForChat(ctx))
    ids.add(doc.id)
    rememberPlugin(ctx, [...ids])
    return `Plugin ${doc.name} is on for this chat.\n\n${doc.body}`
  }
}

const disablePlugin: AgentTool = {
  spec: {
    name: 'disable_plugin',
    description: 'Turn a plugin off for this chat.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
  },
  requiresApproval: false,
  summarize: (a) => `Disable plugin ${s(a.id)}`,
  async run(a, ctx) {
    const id = s(a.id).trim().toLowerCase()
    rememberPlugin(ctx, pluginIdsForChat(ctx).filter((x) => x !== id))
    return `Plugin ${id} is off for this chat.`
  }
}

const memorySave: AgentTool = {
  spec: {
    name: 'memory_save',
    description: 'Remember one short fact the user asked to keep across chats. Do not call this unless the user asked you to remember something.',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
  },
  requiresApproval: false,
  summarize: (a) => `Remember ${s(a.text).slice(0, 80)}`,
  async run(a, ctx) {
    const fact = ctx.store.addMemory(s(a.text))
    return `Remembered: ${fact.text}`
  }
}

const memoryForget: AgentTool = {
  spec: {
    name: 'memory_forget',
    description: 'Forget a remembered fact by its id or its exact text.',
    parameters: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } } }
  },
  requiresApproval: false,
  summarize: (a) => `Forget ${s(a.id) || s(a.text)}`,
  async run(a, ctx) {
    const ok = ctx.store.forgetMemory({ id: s(a.id) || undefined, text: s(a.text) || undefined })
    if (!ok) throw new Error('No matching memory')
    return 'Forgot that fact.'
  }
}

export const BUILTIN_TOOLS: AgentTool[] = [
  fsList,
  fsRead,
  fsWrite,
  shellExec,
  runCode,
  webFetch,
  webSearch,
  browserTask,
  delegateToApp,
  gitStatus,
  gitDiff,
  gitCommit,
  readSkillTool,
  enablePlugin,
  disablePlugin,
  memorySave,
  memoryForget
]
