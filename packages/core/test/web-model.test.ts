import { describe, expect, it } from 'vitest'
import { pickModelOption, webDefaultModel, webModelInfo } from '../src/providers/web/model'

describe('website model name', () => {
  it('falls back to the site default when no name is set', () => {
    expect(webModelInfo('ChatGPT', undefined)).toEqual({ id: 'default', name: 'ChatGPT default model', tags: ['general'] })
    expect(webDefaultModel(undefined)).toBe('default')
  })

  it('treats a blank name as unset', () => {
    expect(webModelInfo('Grok', '   ').id).toBe('default')
    expect(webDefaultModel('   ')).toBe('default')
  })

  it('ignores non-string values', () => {
    expect(webModelInfo('Kimi', 42).id).toBe('default')
    expect(webDefaultModel(null)).toBe('default')
  })

  it('uses the trimmed name as both id and label, matching the default model', () => {
    const info = webModelInfo('ChatGPT', '  GPT-5  ')
    expect(info).toEqual({ id: 'GPT-5', name: 'GPT-5', tags: ['general'] })
    expect(webDefaultModel('  GPT-5  ')).toBe(info.id)
  })
})

describe('pickModelOption', () => {
  const gemini = ['3.5 Flash-Lite\nFastest answers', '3.6 Flash\nAll-around help', '3.1 Pro\nAdvanced reasoning', '4 Argon\nComplex tasks', 'Sign in\nGet more access']

  it('finds a model by a word in its title, ignoring case and the description line', () => {
    expect(pickModelOption(gemini, 'argon')).toBe(3)
    expect(pickModelOption(gemini, 'Pro')).toBe(2)
  })

  it('prefers an exact title over a partial one', () => {
    expect(pickModelOption(['GLM-5.3', 'GLM-5.3-Flash', 'GLM-5.2'], 'GLM-5.3')).toBe(0)
    expect(pickModelOption(['Fast', 'Auto\nRequires sign-in', 'Expert'], 'expert')).toBe(2)
  })

  it('does not treat "Flash" as matching inside an unrelated word first when a whole word exists', () => {
    expect(pickModelOption(['3.5 Flash-Lite', '3.6 Flash'], 'Flash')).toBe(1)
  })

  it('falls back to the description text', () => {
    expect(pickModelOption(gemini, 'fastest')).toBe(0)
  })

  it('returns -1 when nothing matches or the name is empty', () => {
    expect(pickModelOption(gemini, 'Opus')).toBe(-1)
    expect(pickModelOption(gemini, '  ')).toBe(-1)
    expect(pickModelOption(['', '  '], 'x')).toBe(-1)
  })
})
