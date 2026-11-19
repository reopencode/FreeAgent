import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PluginInfo, SkillInfo } from '../api-types'
import { truncate } from '../util'

export const RULES_LIMIT = 8_000
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function slug(name: string): string {
  const id = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return id || 'item'
}

function safeId(id: string): string {
  const clean = slug(id)
  if (!ID_RE.test(clean)) throw new Error('Invalid id')
  return clean
}

interface Doc {
  id: string
  name: string
  summary: string
  body: string
}

function parseDoc(id: string, text: string): Doc {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const headingIdx = lines.findIndex((l) => /^#\s+\S/.test(l))
  const name = headingIdx >= 0 ? lines[headingIdx].replace(/^#\s+/, '').trim() : id
  const summary = lines.map((l) => l.trim()).find((l, i) => i !== headingIdx && l.length > 0 && !l.startsWith('#')) ?? ''
  return { id, name, summary: summary.slice(0, 200), body: text.trim() }
}

function readDocs(dir: string): Doc[] {
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const docs: Doc[] = []
  for (const file of names) {
    if (!file.endsWith('.md')) continue
    const id = file.slice(0, -3)
    if (!ID_RE.test(id)) continue
    try {
      docs.push(parseDoc(id, readFileSync(join(dir, file), 'utf8')))
    } catch {
      // A skill the user is editing can disappear between the listing and the read.
    }
  }
  return docs.sort((a, b) => a.name.localeCompare(b.name))
}

function writeDoc(dir: string, id: string, markdown: string): Doc {
  mkdirSync(dir, { recursive: true })
  const text = markdown.trim()
  writeFileSync(join(dir, `${id}.md`), text.endsWith('\n') ? text : `${text}\n`)
  return parseDoc(id, text)
}

export function readRules(cwd: string): string {
  try {
    const text = readFileSync(join(cwd, 'AGENTS.md'), 'utf8').trim()
    return text ? truncate(text, RULES_LIMIT) : ''
  } catch {
    return ''
  }
}

export function listAppSkills(dataDir: string): SkillInfo[] {
  return readDocs(join(dataDir, 'skills')).map((d) => ({ id: d.id, name: d.name, summary: d.summary, source: 'app' as const }))
}

export function listSkills(dataDir: string, cwd: string): SkillInfo[] {
  const project = readDocs(join(cwd, '.freeagent', 'skills')).map((d) => ({ id: d.id, name: d.name, summary: d.summary, source: 'project' as const }))
  const app = listAppSkills(dataDir).filter((s) => !project.some((p) => p.id === s.id))
  return [...project, ...app]
}

export function readSkill(dataDir: string, cwd: string, name: string): string {
  const want = name.trim().toLowerCase()
  const docs = [...readDocs(join(cwd, '.freeagent', 'skills')), ...readDocs(join(dataDir, 'skills'))]
  const found = docs.find((d) => d.id === safeId(want) || d.name.toLowerCase() === want)
  if (!found) throw new Error(`Unknown skill "${name}"`)
  return found.body
}

export function saveSkill(dataDir: string, name: string, markdown: string): SkillInfo {
  const doc = writeDoc(join(dataDir, 'skills'), safeId(name), markdown)
  return { id: doc.id, name: doc.name, summary: doc.summary, source: 'app' }
}

export function deleteSkill(dataDir: string, id: string): void {
  unlinkSync(join(dataDir, 'skills', `${safeId(id)}.md`))
}

export interface PluginDoc extends PluginInfo {
  body: string
}

export function listPlugins(dataDir: string): PluginInfo[] {
  return readDocs(join(dataDir, 'plugins')).map((d) => ({ id: d.id, name: d.name, description: d.summary }))
}

export function readPlugin(dataDir: string, id: string): PluginDoc | undefined {
  const clean = safeId(id)
  return readDocs(join(dataDir, 'plugins'))
    .filter((d) => d.id === clean)
    .map((d) => ({ id: d.id, name: d.name, description: d.summary, body: d.body }))[0]
}

export function savePlugin(dataDir: string, name: string, markdown: string): PluginInfo {
  const doc = writeDoc(join(dataDir, 'plugins'), safeId(name), markdown)
  return { id: doc.id, name: doc.name, description: doc.summary }
}

export function deletePlugin(dataDir: string, id: string): void {
  unlinkSync(join(dataDir, 'plugins', `${safeId(id)}.md`))
}
