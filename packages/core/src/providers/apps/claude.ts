import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ProviderError, type ChatMessage, type ChatOptions, type Delta, type ModelInfo, type Provider, type ProviderStatus } from '../../types'
import { str, type ProviderContext } from '../context'
import { binaryFor, detect, taskFromMessages } from './base'
import { streamProcess } from './process-stream'

export function claudeDesktopConfigPath(): string {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json')
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'Claude', 'claude_desktop_config.json')
}

export function claudeDesktopLinked(): boolean {
  const file = claudeDesktopConfigPath()
  if (!existsSync(file)) return false
  try {
    return !!JSON.parse(readFileSync(file, 'utf8'))?.mcpServers?.freeagent
  } catch {
    return false
  }
}

/** Parses one line of `claude -p --output-format stream-json`. */
export function parseClaudeStreamLine(line: string): Delta[] {
  let ev: { type?: string; subtype?: string; message?: { content?: { type: string; text?: string; name?: string; input?: Record<string, unknown> }[] }; result?: string; is_error?: boolean }
  try {
    ev = JSON.parse(line)
  } catch {
    return []
  }
  const out: Delta[] = []
  if (ev.type === 'assistant') {
    for (const block of ev.message?.content ?? []) {
      if (block.type === 'text' && block.text) out.push({ type: 'text', text: block.text })
      if (block.type === 'tool_use') {
        const detail = block.input?.file_path ?? block.input?.command ?? block.input?.pattern ?? ''
        out.push({ type: 'status', message: `Claude: ${block.name}${detail ? ` ${String(detail).slice(0, 80)}` : ''}` })
      }
    }
  }
  return out
}

/**
 * Claude Desktop has no API another program can drive, so it connects the other way: it loads FreeAgent's MCP server.
 * When the Claude Code CLI is installed, this provider also runs it as a sub-agent.
 */
export class ClaudeProvider implements Provider {
  readonly id = 'claude'
  readonly name = 'Claude Desktop'
  readonly kind = 'app' as const
  readonly description =
    'Claude Desktop uses FreeAgent through MCP (set it up under Customize → Integrations). If the `claude` CLI (Claude Code) is installed, FreeAgent can also hand it tasks.'
  readonly supportsTools = false
  readonly tags = ['code' as const, 'general' as const, 'reasoning' as const]

  constructor(private readonly ctx: ProviderContext) {}

  private bin(): string {
    return binaryFor(this.ctx, 'claude')
  }

  async status(): Promise<ProviderStatus> {
    const linked = claudeDesktopLinked()
    const cli = detect(this.bin())
    if (cli.path) return { state: 'ready', message: `Claude Code ${cli.version ?? ''} found${linked ? ' · Claude Desktop linked through MCP' : ''}`.trim() }
    if (linked) return { state: 'ready', message: 'Claude Desktop is linked through MCP. Install the `claude` CLI to also send it tasks from here.' }
    return { state: 'needs_setup', message: 'Link Claude Desktop under Customize → Integrations, or install Claude Code (`npm i -g @anthropic-ai/claude-code`).' }
  }

  async models(): Promise<ModelInfo[]> {
    return ['default', 'sonnet', 'opus', 'haiku'].map((m) => ({ id: m, name: m === 'default' ? 'Claude Code default' : `Claude ${m}`, tags: ['code', 'general'] }))
  }

  async defaultModel(): Promise<string> {
    return str(this.ctx.config().model) ?? 'default'
  }

  async *chat(messages: ChatMessage[], opts: ChatOptions): AsyncIterable<Delta> {
    if (!detect(this.bin()).path) {
      throw new ProviderError(this.id, 'unavailable', 'Claude Desktop cannot take tasks from other apps. Install the Claude Code CLI to use Claude as a sub-agent, or use FreeAgent from inside Claude Desktop through MCP.')
    }
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', this.ctx.config().skipPermissions ? 'bypassPermissions' : 'acceptEdits']
    const model = opts.model && opts.model !== 'default' ? opts.model : str(this.ctx.config().model)
    if (model && model !== 'default') args.push('--model', model)
    yield { type: 'status', message: 'Claude Code is working…' }
    const proc = streamProcess(this.id, this.bin(), args, { cwd: opts.cwd, signal: opts.signal, input: taskFromMessages(messages) })
    let lastText = ''
    for await (const line of proc.lines) {
      if (line.stream !== 'stdout') continue
      for (const d of parseClaudeStreamLine(line.text)) {
        if (d.type === 'text') {
          yield { type: 'text', text: (lastText ? '\n\n' : '') + d.text }
          lastText = d.text
        } else yield d
      }
    }
    const { code, stderr } = await proc.done
    if (opts.signal?.aborted) throw new ProviderError(this.id, 'aborted', 'Cancelled')
    if (code !== 0) throw new ProviderError(this.id, /auth|login|api key/i.test(stderr) ? 'auth' : 'server', `claude exited with ${code}: ${stderr.trim().slice(-400)}`)
  }
}
