import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseDuckDuckGo, resolveInside } from '../src/agent/tools'
import { parseClaudeStreamLine } from '../src/providers/apps/claude'
import { cleanKiroLine } from '../src/providers/apps/kiro'
import { flattenConversation, followUpPrompt, latestUserText, parseEmulatedToolCalls } from '../src/providers/emulated-tools'
import { cleanSchema, toGeminiRequest } from '../src/providers/gemini'
import { mediaFromOpenAIDelta, toOpenAIMessages } from '../src/providers/openai-compatible'
import { GENERIC_DISMISS, loadSiteConfig, siteOverridePath, validateSiteConfig, WEB_SITES } from '../src/providers/web/sites'
import type { ToolSpec } from '../src/types'

const tools: ToolSpec[] = [{ name: 'fs_read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }]

describe('emulated tool calls for web providers', () => {
  it('extracts a fenced tool_call block and keeps the prose', () => {
    const out = parseEmulatedToolCalls('Let me look.\n```tool_call\n{"name":"fs_read","arguments":{"path":"a.txt"}}\n```', tools)
    expect(out.calls).toHaveLength(1)
    expect(out.calls[0].name).toBe('fs_read')
    expect(JSON.parse(out.calls[0].arguments)).toEqual({ path: 'a.txt' })
    expect(out.text).toBe('Let me look.')
  })

  it('ignores unknown tools and broken JSON', () => {
    expect(parseEmulatedToolCalls('```tool_call\n{"name":"rm_rf","arguments":{}}\n```', tools).calls).toHaveLength(0)
    expect(parseEmulatedToolCalls('```tool_call\n{"name": fs_read}\n```', tools).calls).toHaveLength(0)
  })

  it('sends a lone user message as-is and flattens longer conversations', () => {
    expect(flattenConversation([{ role: 'user', content: 'hi' }])).toBe('hi')
    const flat = flattenConversation(
      [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'read a.txt' },
        { role: 'assistant', content: '', toolCalls: [{ id: '1', name: 'fs_read', arguments: '{"path":"a.txt"}' }] },
        { role: 'tool', toolCallId: '1', name: 'fs_read', content: 'file body' }
      ],
      tools
    )
    expect(flat).toContain('Be brief.')
    expect(flat).toContain('file body')
    expect(flat).toContain('tool_call')
  })

  it('followUpPrompt sends only new tool results, skips assistant turns and lists tool names', () => {
    const out = followUpPrompt(
      [
        { role: 'assistant', content: 'calling', toolCalls: [{ id: '1', name: 'fs_read', arguments: '{}' }] },
        { role: 'tool', toolCallId: '1', name: 'fs_read', content: 'file body' },
        { role: 'user', content: 'and also this' }
      ],
      tools
    )
    expect(out).toContain('Tool result (fs_read):\nfile body')
    expect(out).toContain('User: and also this')
    expect(out).not.toContain('calling')
    expect(out).toContain('```tool_call')
    expect(out).toContain('fs_read')
    expect(out).not.toContain('Read a file')
  })

  it('latestUserText returns the last non-empty user message', () => {
    expect(
      latestUserText([
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'one' },
        { role: 'assistant', content: 'a' },
        { role: 'user', content: ' two ' }
      ])
    ).toBe('two')
    expect(latestUserText([{ role: 'system', content: 'sys' }])).toBeUndefined()
    expect(latestUserText([{ role: 'user', content: '   ' }])).toBeUndefined()
  })
})

describe('web site selector config', () => {
  it('ships a config for each supported site', () => {
    expect(WEB_SITES.map((s) => s.id).sort()).toEqual(['chatgpt', 'claude', 'deepseek', 'gemini-web', 'grok', 'kimi', 'pi', 'zai'].sort())
    for (const s of WEB_SITES) expect(validateSiteConfig(s)).toEqual([])
    const chatgpt = WEB_SITES.find((s) => s.id === 'chatgpt')!
    expect(chatgpt.input).toMatch(/ProseMirror|data-composer-markdown|Ask ChatGPT/)
    expect(chatgpt.send).toMatch(/aria-label="Send"/)
    expect(chatgpt.reply).toMatch(/data-markdown-text-style="assistant-message"/)
    const claude = WEB_SITES.find((s) => s.id === 'claude')!
    expect(claude.input).toMatch(/chat-input|ProseMirror/)
    expect(claude.send).toMatch(/aria-label="Send Message"/)
    expect(claude.reply).toMatch(/assistant-message.*standard-markdown/)
    expect(claude.generating).toMatch(/chat-input-stop/)
    const gemini = WEB_SITES.find((s) => s.id === 'gemini-web')!
    expect(gemini.input).toMatch(/Ask Gemini|gds-body-l/)
    const deepseek = WEB_SITES.find((s) => s.id === 'deepseek')!
    expect(deepseek.loginRequired).toBe(true)
    expect(deepseek.input).toMatch(/#chat-input/)
    expect(deepseek.reply).toMatch(/\.ds-markdown/)
  })

  it('rejects bad overrides and applies good ones', () => {
    expect(validateSiteConfig({ url: 'http://insecure.example' })).toHaveLength(1)
    expect(validateSiteConfig({ input: '' })).toHaveLength(1)
    const dir = mkdtempSync(join(tmpdir(), 'freeagent-sites-'))
    try {
      const file = siteOverridePath(dir, 'grok')
      mkdirSync(join(dir, 'web-sites'), { recursive: true })
      writeFileSync(file, JSON.stringify({ input: 'textarea.custom' }))
      const cfg = loadSiteConfig(dir, 'grok')
      expect(cfg.input).toBe('textarea.custom')
      expect(cfg.url).toBe(WEB_SITES.find((s) => s.id === 'grok')!.url)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('accepts popup dismiss selectors and lets users override them', () => {
    expect(validateSiteConfig({ dismiss: '' })).toHaveLength(1)
    expect(validateSiteConfig({ dismiss: 'button.close' })).toEqual([])
    expect(GENERIC_DISMISS).toMatch(/onetrust-accept-btn-handler/)
    expect(GENERIC_DISMISS).not.toMatch(/(^|, )\[role="dialog"\] button\[aria-label="Close"\]/)
    expect(WEB_SITES.find((s) => s.id === 'chatgpt')!.dismiss).toMatch(/Stay logged out/)
    const dir = mkdtempSync(join(tmpdir(), 'freeagent-sites-'))
    try {
      mkdirSync(join(dir, 'web-sites'), { recursive: true })
      writeFileSync(siteOverridePath(dir, 'kimi'), JSON.stringify({ dismiss: '.promo-close' }))
      const cfg = loadSiteConfig(dir, 'kimi')
      expect(cfg.dismiss).toBe('.promo-close')
      expect(cfg.input).toBe(WEB_SITES.find((s) => s.id === 'kimi')!.input)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('app provider output parsing', () => {
  it('parses Claude Code stream-json lines', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }, { type: 'tool_use', name: 'Edit', input: { file_path: 'src/a.ts' } }] } })
    expect(parseClaudeStreamLine(line)).toEqual([
      { type: 'text', text: 'Done.' },
      { type: 'status', message: 'Claude: Edit src/a.ts' }
    ])
    expect(parseClaudeStreamLine('not json')).toEqual([])
  })

  it('strips Kiro prompt markers and spinners', () => {
    expect(cleanKiroLine('> Hello')).toBe('Hello')
    expect(cleanKiroLine('⠋')).toBeNull()
    expect(cleanKiroLine('plain text   ')).toBe('plain text')
  })
})

describe('API provider message conversion', () => {
  it('maps tool calls to the OpenAI format', () => {
    const msgs = toOpenAIMessages([
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'fs_read', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'c1', name: 'fs_read', content: 'ok' }
    ]) as Record<string, unknown>[]
    expect(msgs[0]).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'fs_read', arguments: '{}' } }] })
    expect(msgs[1]).toMatchObject({ role: 'tool', tool_call_id: 'c1', content: 'ok' })
  })

  it('maps system prompts and tool results to Gemini', () => {
    const req = toGeminiRequest([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'fs_read', arguments: '{"path":"a"}' }] },
      { role: 'tool', toolCallId: 'c1', name: 'fs_read', content: 'body' }
    ])
    expect(req.systemInstruction?.parts[0]).toEqual({ text: 'sys' })
    expect(req.contents.map((c) => c.role)).toEqual(['user', 'model', 'user'])
    expect(JSON.stringify(req.contents[2])).toContain('functionResponse')
  })

  it('sends image and audio parts to OpenAI and Gemini', () => {
    const attachments = [
      { kind: 'image' as const, name: 'a.png', mime: 'image/png', dataBase64: 'aaa' },
      { kind: 'audio' as const, name: 'a.mp3', mime: 'audio/mpeg', dataBase64: 'bbb' }
    ]
    const open = toOpenAIMessages([{ role: 'user', content: 'look', attachments }]) as { content: { type: string; image_url?: { url: string }; input_audio?: { format: string } }[] }[]
    expect(open[0].content.map((p) => p.type)).toEqual(['text', 'image_url', 'input_audio'])
    expect(open[0].content[1].image_url?.url).toBe('data:image/png;base64,aaa')
    expect(open[0].content[2].input_audio?.format).toBe('mp3')
    const gemini = toGeminiRequest([{ role: 'user', content: '', attachments }])
    expect(gemini.contents[0].parts).toEqual([
      { inlineData: { mimeType: 'image/png', data: 'aaa' } },
      { inlineData: { mimeType: 'audio/mpeg', data: 'bbb' } }
    ])
  })

  it('reads an image out of an OpenAI stream delta', () => {
    expect(mediaFromOpenAIDelta({ images: [{ image_url: { url: 'data:image/png;base64,aaa' } }] })).toEqual([{ mime: 'image/png', base64: 'aaa' }])
  })

  it('removes JSON schema keys Gemini rejects', () => {
    const cleaned = cleanSchema({ type: 'object', $schema: 'x', additionalProperties: false, properties: { a: { type: 'string', default: 'z' } } }) as Record<string, unknown>
    expect(cleaned.$schema).toBeUndefined()
    expect(cleaned.additionalProperties).toBeUndefined()
  })
})

describe('agent tool helpers', () => {
  it('keeps paths inside the project folder', () => {
    expect(resolveInside('/tmp/ws', 'a/b.txt')).toBe('/tmp/ws/a/b.txt')
    expect(() => resolveInside('/tmp/ws', '../outside')).toThrow()
    expect(() => resolveInside('/tmp/ws', '/etc/passwd')).toThrow()
  })

  it('parses DuckDuckGo HTML results', () => {
    const html = `
      <div class="result"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&rut=x">Example <b>Page</b></a>
      <a class="result__snippet" href="#">A short <b>snippet</b> here.</a></div>`
    expect(parseDuckDuckGo(html)).toEqual([{ title: 'Example Page', url: 'https://example.com/page', snippet: 'A short snippet here.' }])
  })
})
