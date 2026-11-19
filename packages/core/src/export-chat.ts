import type { Chat, StoredMessage } from './api-types'

/** One chat as Markdown: title, each turn, attachment names, and the assistant's provider. */
export function chatToMarkdown(chat: Chat, messages: StoredMessage[]): string {
  const lines = [`# ${chat.title}`, '']
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue
    lines.push(m.role === 'user' ? '## You' : '## Assistant', '')
    if (m.role === 'assistant' && m.meta.providerId) {
      const who = [m.meta.providerId, m.meta.model && m.meta.model !== 'default' ? m.meta.model : ''].filter(Boolean).join(' · ')
      lines.push(`_${who}_`, '')
    }
    if (m.content.trim()) lines.push(m.content.trim(), '')
    for (const a of m.attachments ?? []) lines.push(`Attached: ${a.name} (${a.kind})`, '')
  }
  return lines.join('\n').trimEnd() + '\n'
}

export function markdownFilename(title: string): string {
  const base = title.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'chat'
  return `${base}.md`
}
