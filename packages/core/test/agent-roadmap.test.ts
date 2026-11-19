import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentEvent, AgentTask } from '../src/api-types'
import { AgentRunner } from '../src/agent/runner'
import { BUILTIN_TOOLS, type AgentTool } from '../src/agent/tools'
import { deletePlugin, deleteSkill, savePlugin, saveSkill } from '../src/agent/instructions'
import { testCore, type TestCore } from './helpers'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'FreeAgent',
      GIT_AUTHOR_EMAIL: 'freeagent@localhost',
      GIT_COMMITTER_NAME: 'FreeAgent',
      GIT_COMMITTER_EMAIL: 'freeagent@localhost'
    }
  })
}

describe('agent roadmap', () => {
  let core: TestCore
  let cwd: string

  beforeEach(() => {
    core = testCore(['mock'])
    cwd = mkdtempSync(join(tmpdir(), 'freeagent-ws-'))
  })

  afterEach(async () => {
    await core.cleanup()
    rmSync(cwd, { recursive: true, force: true })
  })

  it('includes AGENTS.md and ignores a missing rules file', () => {
    writeFileSync(join(cwd, 'AGENTS.md'), 'Always use tabs.')
    const project = core.store.createProject({ name: 'Rules', workspaceDir: cwd })
    const withRules = core.chats.systemPrompt(project.id, 'chat', cwd)
    expect(withRules).toContain('Always use tabs.')
    expect(withRules).not.toContain('Project instructions:')

    const empty = mkdtempSync(join(tmpdir(), 'freeagent-empty-'))
    try {
      const bare = core.chats.systemPrompt(null, 'chat', empty)
      expect(bare).not.toContain('Always use tabs.')
      expect(bare).not.toContain('AGENTS.md')
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it('loads a skill body by name', async () => {
    saveSkill(core.dataDir, 'Review', '# Review\nCheck edge cases.\n\nLook at nulls.')
    const prompt = core.chats.systemPrompt(null, 'agent', cwd)
    expect(prompt).toContain('Review')
    expect(prompt).toContain('Check edge cases.')

    const events: AgentEvent[] = []
    await core.runner.run({
      messages: [{ role: 'user', content: '/tool read_skill {"name":"Review"}' }],
      mode: 'agent',
      target: 'auto',
      cwd,
      emit: (e) => events.push(e)
    })
    const result = events.find((e) => e.type === 'tool_result')
    expect(result && result.type === 'tool_result' && result.ok).toBe(true)
    if (result && result.type === 'tool_result') expect(result.output).toContain('Look at nulls.')
    deleteSkill(core.dataDir, 'review')
  })

  it('changes the prompt when a plugin is enabled or disabled for the chat', async () => {
    const plugin = savePlugin(core.dataDir, 'Careful', '# Careful\nDouble-check file writes.\n\nNever delete the workspace.')
    const project = core.store.createProject({ name: 'Plug', workspaceDir: cwd, enabledPlugins: [plugin.id] })
    const chat = core.store.createChat({ projectId: project.id, mode: 'agent' })
    expect(core.chats.systemPrompt(project.id, 'agent', cwd, chat.id)).toContain('Never delete the workspace.')

    const events: AgentEvent[] = []
    await core.runner.run({
      messages: [{ role: 'user', content: `/tool disable_plugin {"id":"${plugin.id}"}` }],
      mode: 'agent',
      target: 'auto',
      cwd,
      chatId: chat.id,
      emit: (e) => events.push(e)
    })
    expect(events.some((e) => e.type === 'tool_result' && e.ok)).toBe(true)
    expect(core.chats.systemPrompt(project.id, 'agent', cwd, chat.id)).not.toContain('Never delete the workspace.')

    await core.runner.run({
      messages: [{ role: 'user', content: `/tool enable_plugin {"id":"${plugin.id}"}` }],
      mode: 'agent',
      target: 'auto',
      cwd,
      chatId: chat.id,
      emit: () => undefined
    })
    expect(core.chats.systemPrompt(project.id, 'agent', cwd, chat.id)).toContain('Never delete the workspace.')
    deletePlugin(core.dataDir, plugin.id)
  })

  it('emits an ordered task list for a large request and skips it for a short one', async () => {
    const pad = 'x'.repeat(180)
    const large = `/tool update_tasks ${JSON.stringify({ tasks: [{ title: `Write ${pad}` }, { title: `Read ${pad}` }] })}`
    expect(large.length).toBeGreaterThanOrEqual(400)

    const events: AgentEvent[] = []
    const planned = await core.runner.run({
      messages: [{ role: 'user', content: large }],
      mode: 'agent',
      target: 'auto',
      cwd,
      emit: (e) => events.push(e)
    })
    const lists = events.filter((e): e is Extract<AgentEvent, { type: 'task_list' }> => e.type === 'task_list')
    expect(lists.length).toBeGreaterThan(0)
    const last = lists[lists.length - 1].tasks
    expect(last.map((t) => t.title.startsWith('Write') || t.title.startsWith('Read'))).toEqual([true, true])
    expect(last[0].title.startsWith('Write')).toBe(true)
    expect(last[1].title.startsWith('Read')).toBe(true)
    expect(last.every((t) => t.status === 'done')).toBe(true)
    expect(lists.some((e) => e.tasks[0]?.status === 'running' && e.tasks[1]?.status === 'pending')).toBe(true)
    expect(planned.meta.tasks?.map((t: AgentTask) => t.status)).toEqual(['done', 'done'])

    const short: AgentEvent[] = []
    await core.runner.run({
      messages: [{ role: 'user', content: 'hi' }],
      mode: 'agent',
      target: 'auto',
      cwd,
      emit: (e) => short.push(e)
    })
    expect(short.some((e) => e.type === 'task_list')).toBe(false)
  })

  it('shows a saved memory on the next prompt and drops it when forgotten', async () => {
    const events: AgentEvent[] = []
    await core.runner.run({
      messages: [{ role: 'user', content: '/tool memory_save {"text":"User likes tea"}' }],
      mode: 'agent',
      target: 'auto',
      cwd,
      emit: (e) => events.push(e)
    })
    expect(events.some((e) => e.type === 'tool_result' && e.ok)).toBe(true)
    expect(core.chats.systemPrompt(null, 'chat', cwd)).toContain('User likes tea')

    await core.runner.run({
      messages: [{ role: 'user', content: '/tool memory_forget {"text":"User likes tea"}' }],
      mode: 'agent',
      target: 'auto',
      cwd,
      emit: () => undefined
    })
    expect(core.chats.systemPrompt(null, 'chat', cwd)).not.toContain('User likes tea')
  })

  it('waits to commit and rejects a path outside the project folder', async () => {
    git(cwd, ['init'])
    writeFileSync(join(cwd, 'note.txt'), 'hello')

    const denied: AgentEvent[] = []
    await core.runner.run({
      messages: [{ role: 'user', content: '/tool git_commit {"message":"nope","paths":["note.txt"]}' }],
      mode: 'agent',
      target: 'auto',
      cwd,
      emit: (e) => {
        denied.push(e)
        if (e.type === 'approval_request') core.approvals.resolve(e.id, false)
      }
    })
    expect(denied.some((e) => e.type === 'approval_request' && e.name === 'git_commit')).toBe(true)
    expect(denied.some((e) => e.type === 'tool_result' && !e.ok)).toBe(true)
    let head = ''
    try {
      head = git(cwd, ['rev-parse', '--verify', 'HEAD']).trim()
    } catch {
      head = ''
    }
    expect(head).toBe('')
  })

  it('rejects a git path outside the folder and commits an inside path after approval', async () => {
    git(cwd, ['init'])
    writeFileSync(join(cwd, 'note.txt'), 'hello')

    const outside: AgentEvent[] = []
    await core.runner.run({
      messages: [{ role: 'user', content: '/tool git_commit {"message":"bad","paths":["../../outside.txt"]}' }],
      mode: 'agent',
      target: 'auto',
      cwd,
      emit: (e) => {
        outside.push(e)
        if (e.type === 'approval_request') core.approvals.resolve(e.id, true)
      }
    })
    const rejected = outside.find((e) => e.type === 'tool_result')
    expect(rejected && rejected.type === 'tool_result' && rejected.ok).toBe(false)

    const allowed: AgentEvent[] = []
    await core.runner.run({
      messages: [{ role: 'user', content: '/tool git_commit {"message":"Add note","paths":["note.txt"]}' }],
      mode: 'agent',
      target: 'auto',
      cwd,
      emit: (e) => {
        allowed.push(e)
        if (e.type === 'approval_request') core.approvals.resolve(e.id, true)
      }
    })
    expect(allowed.some((e) => e.type === 'tool_result' && e.ok)).toBe(true)
    const subject = git(cwd, ['log', '-1', '--format=%s']).trim()
    expect(subject).toBe('Add note')
  })

  it('turns a screenshot tool result into a media event and keeps the bytes out of the tool text', async () => {
    const png = Buffer.from('png-bytes').toString('base64')
    const shot: AgentTool = {
      spec: { name: 'shot', description: 'test screenshot', parameters: { type: 'object', properties: {} } },
      requiresApproval: false,
      summarize: () => 'shot',
      async run() {
        return { text: 'Screenshot of https://example.com is shown in the thread.', images: [{ mime: 'image/png', name: 'screenshot.png', base64: png }] }
      }
    }
    const runner = new AgentRunner({
      router: core.router,
      registry: core.registry,
      store: core.store,
      approvals: core.approvals,
      mcp: core.mcp,
      dataDir: core.dataDir,
      extraTools: [shot]
    })
    const events: AgentEvent[] = []
    const res = await runner.run({
      messages: [{ role: 'user', content: '/tool shot {}' }],
      mode: 'agent',
      target: 'auto',
      cwd,
      emit: (e) => events.push(e)
    })
    const media = events.find((e) => e.type === 'media')
    expect(media && media.type === 'media' && media.base64).toBe(png)
    const result = events.find((e) => e.type === 'tool_result')
    expect(result && result.type === 'tool_result' && result.ok && !result.output.includes(png)).toBe(true)
    expect(res.media?.[0]?.base64).toBe(png)
    expect(BUILTIN_TOOLS.find((t) => t.spec.name === 'browser_task')?.spec.parameters.properties).toBeTruthy()
    const extract = BUILTIN_TOOLS.find((t) => t.spec.name === 'browser_task')?.spec.parameters.properties?.extract as { enum?: string[] }
    expect(extract.enum).toContain('screenshot')
  })

  it('reads a project skill from the working folder', () => {
    const dir = join(cwd, '.freeagent', 'skills')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'local.md'), '# Local\nProject-only skill.\n')
    const prompt = core.chats.systemPrompt(null, 'agent', cwd)
    expect(prompt).toContain('Local')
    expect(prompt).toContain('Project-only skill.')
  })
})
