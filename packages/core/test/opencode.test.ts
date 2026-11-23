import { chmodSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { parseOpenCodeRunLine, opencodeModelArg } from '../src/providers/apps/opencode'
import type { Delta } from '../src/types'
import { ProviderError } from '../src/types'
import { testCore, type TestCore } from './helpers'

const fixture = fileURLToPath(new URL('./fixtures/opencode-fake.mjs', import.meta.url))

async function collect(deltas: AsyncIterable<Delta>): Promise<Delta[]> {
  const out: Delta[] = []
  for await (const delta of deltas) out.push(delta)
  return out
}

describe('opencodeModelArg', () => {
  it('keeps provider/model and drops a bare name', () => {
    expect(opencodeModelArg('opencode/beam-free')).toBe('opencode/beam-free')
    expect(opencodeModelArg(' beam-free ')).toBeUndefined()
    expect(opencodeModelArg('default')).toBeUndefined()
    expect(opencodeModelArg(undefined)).toBeUndefined()
  })
})

describe('parseOpenCodeRunLine', () => {
  it('reads text and finished tool events and ignores other lines', () => {
    expect(parseOpenCodeRunLine(JSON.stringify({ type: 'text', part: { text: 'pong' } }))).toEqual([{ type: 'text', text: 'pong' }])
    expect(parseOpenCodeRunLine(JSON.stringify({ type: 'tool_use', part: { tool: 'bash', state: { title: 'list files' } } }))).toEqual([
      { type: 'status', message: 'OpenCode: bash' }
    ])
    expect(parseOpenCodeRunLine(JSON.stringify({ type: 'step_start' }))).toEqual([])
    expect(parseOpenCodeRunLine('not json')).toEqual([])
  })
})

describe('OpenCode provider', () => {
  let core: TestCore
  const previousLog = process.env.FREEAGENT_OPENCODE_LOG
  const previousMode = process.env.FREEAGENT_OPENCODE_MODE

  afterEach(async () => {
    await core?.cleanup()
    if (previousLog === undefined) delete process.env.FREEAGENT_OPENCODE_LOG
    else process.env.FREEAGENT_OPENCODE_LOG = previousLog
    if (previousMode === undefined) delete process.env.FREEAGENT_OPENCODE_MODE
    else process.env.FREEAGENT_OPENCODE_MODE = previousMode
  })

  it('runs opencode run --auto --format json and passes a configured model', async () => {
    chmodSync(fixture, 0o755)
    const log = join(mkdtempSync(join(tmpdir(), 'opencode-log-')), 'requests.log')
    process.env.FREEAGENT_OPENCODE_LOG = log
    core = testCore(['opencode'])
    core.store.updateProviderSettings('opencode', { config: { binaryPath: fixture, model: 'opencode/gemini-4-neon' } })

    const deltas = await collect(core.registry.get('opencode')!.chat([{ role: 'user', content: 'Reply with exactly: pong' }], {}))
    const lines = readFileSync(log, 'utf8').trim().split('\n')
    const run = lines.find((line) => line.startsWith('ARGS ') && line.includes('"run"'))

    expect(deltas.filter((d) => d.type === 'text')).toEqual([{ type: 'text', text: 'pong' }])
    expect(run).toContain('"--auto"')
    expect(run).toContain('"--format"')
    expect(run).toContain('"json"')
    expect(run).toContain('"--model"')
    expect(run).toContain('"opencode/gemini-4-neon"')
    expect(lines.some((line) => line.startsWith('STDIN ') && line.includes('Reply with exactly: pong'))).toBe(true)
    expect(lines.some((line) => line.startsWith('ARGS ') && line.includes('"models"'))).toBe(false)
  })

  it('picks the first free model when none is configured', async () => {
    chmodSync(fixture, 0o755)
    const log = join(mkdtempSync(join(tmpdir(), 'opencode-log-')), 'requests.log')
    process.env.FREEAGENT_OPENCODE_LOG = log
    process.env.FREEAGENT_OPENCODE_MODE = 'tool'
    core = testCore(['opencode'])
    core.store.updateProviderSettings('opencode', { config: { binaryPath: fixture } })

    const deltas = await collect(core.registry.get('opencode')!.chat([{ role: 'user', content: 'hi' }], {}))
    const lines = readFileSync(log, 'utf8')

    expect(deltas.some((d) => d.type === 'status' && d.message === 'OpenCode: bash')).toBe(true)
    expect(deltas.some((d) => d.type === 'text' && d.text === 'pong')).toBe(true)
    expect(lines).toContain('ARGS ["models"]')
    expect(lines).toContain('"--model","opencode/beam-free"')
  })

  it('surfaces a non-zero JSON error from the CLI', async () => {
    chmodSync(fixture, 0o755)
    process.env.FREEAGENT_OPENCODE_MODE = 'error'
    core = testCore(['opencode'])
    core.store.updateProviderSettings('opencode', { config: { binaryPath: fixture, model: 'opencode/gemini-4-neon' } })

    await expect(collect(core.registry.get('opencode')!.chat([{ role: 'user', content: 'hi' }], {}))).rejects.toThrow(/Insufficient balance/)
  })

  it('treats a 429 JSON error as a rate limit', async () => {
    chmodSync(fixture, 0o755)
    process.env.FREEAGENT_OPENCODE_MODE = 'limit'
    core = testCore(['opencode'])
    core.store.updateProviderSettings('opencode', { config: { binaryPath: fixture, model: 'opencode/beam-free' } })

    const failure = collect(core.registry.get('opencode')!.chat([{ role: 'user', content: 'hi' }], {}))
    await expect(failure).rejects.toBeInstanceOf(ProviderError)
    await expect(failure).rejects.toMatchObject({ kind: 'rate_limit' })
  })
})
