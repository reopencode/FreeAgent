import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface Link {
  chatId: string
  target: string
}

/** Maps a Telegram chat id to its FreeAgent chat, persisted as JSON. */
export class LinkStore {
  private links: Record<string, Link> = {}

  constructor(private readonly file: string) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Link>
      for (const [key, value] of Object.entries(parsed)) {
        if (value && typeof value.chatId === 'string' && typeof value.target === 'string') this.links[key] = value
      }
    } catch {
      this.links = {}
    }
  }

  get(telegramChatId: number | string): Link | undefined {
    return this.links[String(telegramChatId)]
  }

  set(telegramChatId: number | string, link: Link): void {
    this.links[String(telegramChatId)] = link
    this.save()
  }

  delete(telegramChatId: number | string): void {
    delete this.links[String(telegramChatId)]
    this.save()
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.links, null, 2) + '\n')
    renameSync(tmp, this.file)
  }
}
