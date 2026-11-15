import type { ModelInfo } from '../../types'
import { str } from '../context'

/**
 * A website provider's model is the name the user typed in settings. It is picked in the site's own model menu
 * before the prompt is sent. `defaultModel` and `models` must agree, or the router would queue the same site twice.
 */
export function webDefaultModel(configured: unknown): string {
  return str(configured) ?? 'default'
}

export function webModelInfo(siteName: string, configured: unknown): ModelInfo {
  const id = webDefaultModel(configured)
  return { id, name: id === 'default' ? `${siteName} default model` : id, tags: ['general'] }
}

/** True when a model name means "leave the site on whatever it is already using". */
export function isSiteDefaultModel(model: string | undefined): boolean {
  return !model || !model.trim() || model.trim() === 'default'
}

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase()

/**
 * Picks the menu entry for `wanted` from the visible text of each entry (e.g. "4 Argon\nComplex tasks").
 * The first line is the title and is preferred: exact title, then whole words in the title, then any substring of the
 * title, then anything in the description. Returns -1 when nothing matches.
 */
export function pickModelOption(optionTexts: string[], wanted: string): number {
  const w = norm(wanted)
  if (!w) return -1
  const entries = optionTexts.map((t) => {
    const lines = t.split('\n').map(norm).filter(Boolean)
    return { title: lines[0] ?? '', full: lines.join(' ') }
  })
  const rules: ((e: { title: string; full: string }) => boolean)[] = [
    (e) => e.title === w,
    (e) => ` ${e.title} `.includes(` ${w} `),
    (e) => e.title.includes(w),
    (e) => e.full.includes(w)
  ]
  for (const rule of rules) {
    const i = entries.findIndex((e) => e.title !== '' && rule(e))
    if (i >= 0) return i
  }
  return -1
}
