import type { AttachmentKind, ProviderSummary } from '@core/api-types'

export const LIMITS = { maxCount: 6, image: 8_000_000, audio: 15_000_000, file: 1_000_000 } as const

export interface DraftAttachment {
  localId: string
  name: string
  mime: string
  kind: AttachmentKind
  dataBase64: string
  previewUrl?: string
}

export function kindOf(mime: string): AttachmentKind {
  const m = mime.toLowerCase()
  if (m.startsWith('image/')) return 'image'
  if (m.startsWith('audio/')) return 'audio'
  return 'file'
}

export function sizeProblem(file: { name: string; type: string; size: number }, count: number): string | undefined {
  if (count >= LIMITS.maxCount) return `You can attach up to ${LIMITS.maxCount} files.`
  const kind = kindOf(file.type || 'application/octet-stream')
  if (file.size > LIMITS[kind]) return `"${file.name}" is too large.`
  return undefined
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  return btoa(binary)
}

export function fileToDraft(file: File): Promise<DraftAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`))
    reader.onload = () => {
      const mime = file.type || 'application/octet-stream'
      const kind = kindOf(mime)
      resolve({
        localId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: file.name || (kind === 'image' ? 'image' : kind === 'audio' ? 'audio' : 'file'),
        mime,
        kind,
        dataBase64: String(reader.result ?? '').split(',')[1] ?? '',
        previewUrl: kind === 'image' || kind === 'audio' ? URL.createObjectURL(file) : undefined
      })
    }
    reader.readAsDataURL(file)
  })
}

function readyApi(p: ProviderSummary): boolean {
  return p.kind === 'api' && p.id !== 'mock' && p.enabled && p.status.state === 'ready'
}

/** Why this target cannot accept the attached images or audio, if it cannot. */
export function providerProblem(target: string, providers: ProviderSummary[], drafts: { kind: AttachmentKind }[]): string | undefined {
  const audio = drafts.some((d) => d.kind === 'audio')
  const image = drafts.some((d) => d.kind === 'image')
  if (!audio && !image) return undefined
  const explicit = target.startsWith('auto') ? undefined : target.split('::')[0]
  if (audio) {
    if (!explicit) {
      if (!providers.some((p) => p.id === 'gemini-api' && readyApi(p))) return 'No ready provider accepts audio. Add a Gemini API key, or pick an API provider that accepts it.'
    } else {
      const p = providers.find((x) => x.id === explicit)
      if (p && !readyApi(p)) return `${p.name} cannot take audio.`
    }
  }
  if (image) {
    if (!explicit) {
      if (!providers.some(readyApi)) return 'No ready provider accepts images. Website and app providers cannot take them.'
    } else {
      const p = providers.find((x) => x.id === explicit)
      if (p && !readyApi(p)) return `${p.name} cannot take images.`
    }
  }
  return undefined
}
