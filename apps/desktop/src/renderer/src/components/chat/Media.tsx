import { useEffect, useState } from 'react'
import type { Attachment } from '@core/api-types'
import { FileText } from 'lucide-react'
import { connection } from '@/lib/api'

/** Loads one saved attachment with the bearer token and renders it. */
export function MediaFile({ chatId, attachment }: { chatId: string; attachment: Attachment }): React.JSX.Element {
  const [src, setSrc] = useState<string>()
  useEffect(() => {
    if (attachment.kind === 'file') return
    let url: string | undefined
    let cancelled = false
    const c = connection()
    void fetch(`${c.baseUrl}/api/media/${chatId}/${attachment.id}`, { headers: { Authorization: `Bearer ${c.token}` } })
      .then((res) => (res.ok ? res.blob() : Promise.reject(new Error('missing'))))
      .then((blob) => {
        if (cancelled) return
        url = URL.createObjectURL(blob)
        setSrc(url)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [chatId, attachment.id, attachment.kind])

  if (attachment.kind === 'image') {
    return src ? <img src={src} alt={attachment.name} className="max-h-64 rounded-lg" /> : <FileChip name={attachment.name} />
  }
  if (attachment.kind === 'audio') {
    return src ? <audio controls src={src} className="max-w-full" /> : <FileChip name={attachment.name} />
  }
  return <FileChip name={attachment.name} />
}

export function FileChip({ name }: { name: string }): React.JSX.Element {
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-lg border bg-background px-2 py-1 text-xs text-muted-foreground">
      <FileText className="size-3.5 shrink-0" />
      <span className="truncate">{name}</span>
    </span>
  )
}

export function DataMedia({ mime, base64, name }: { mime: string; base64: string; name?: string }): React.JSX.Element {
  const src = `data:${mime};base64,${base64}`
  if (mime.startsWith('audio/')) return <audio controls src={src} className="max-w-full" />
  if (mime.startsWith('image/')) return <img src={src} alt={name ?? ''} className="max-h-64 rounded-lg" />
  return <FileChip name={name ?? 'file'} />
}
