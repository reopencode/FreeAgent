import { useEffect, useRef, useState } from 'react'
import type { ChatMode } from '@core/api-types'
import { ArrowUp, Mic, Paperclip, Square, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { fileToDraft, sizeProblem, type DraftAttachment } from './draft'
import { FileChip } from './Media'
import { ModeToggle } from './ModeToggle'
import { TargetPicker } from './TargetPicker'

interface Props {
  mode: ChatMode
  target: string
  onModeChange: (m: ChatMode) => void
  onTargetChange: (t: string) => void
  onSend: (text: string, attachments: DraftAttachment[]) => void
  onStop: () => void
  busy: boolean
  placeholder?: string
  autoFocus?: boolean
  initialText?: string
  initialAttachments?: DraftAttachment[]
}

export function Composer(props: Props): React.JSX.Element {
  const [text, setText] = useState(props.initialText ?? '')
  const [attachments, setAttachments] = useState<DraftAttachment[]>(props.initialAttachments ?? [])
  const [over, setOver] = useState(false)
  const [recording, setRecording] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const ref = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const recorder = useRef<MediaRecorder | null>(null)
  const chunks = useRef<Blob[]>([])

  useEffect(() => {
    if (props.initialText !== undefined) setText(props.initialText)
  }, [props.initialText])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = Math.min(el.scrollHeight, 280) + 'px'
  }, [text])

  useEffect(() => {
    if (props.autoFocus) ref.current?.focus()
  }, [props.autoFocus])

  useEffect(() => {
    if (!recording) return
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000)
    return () => clearInterval(timer)
  }, [recording])

  useEffect(() => {
    return () => recorder.current?.stop()
  }, [])

  const addFiles = async (files: File[]): Promise<void> => {
    const next = [...attachments]
    for (const file of files) {
      const problem = sizeProblem(file, next.length)
      if (problem) {
        toast.error(problem)
        continue
      }
      try {
        next.push(await fileToDraft(file))
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err))
      }
    }
    setAttachments(next)
  }

  const remove = (localId: string): void => {
    setAttachments((cur) => {
      const hit = cur.find((a) => a.localId === localId)
      if (hit?.previewUrl) URL.revokeObjectURL(hit.previewUrl)
      return cur.filter((a) => a.localId !== localId)
    })
  }

  const send = (): void => {
    const t = text.trim()
    if (props.busy || recording || (!t && attachments.length === 0)) return
    props.onSend(t, attachments)
    setText('')
    setAttachments([])
  }

  const stopRecording = (): void => {
    recorder.current?.stop()
    recorder.current = null
  }

  const toggleRecord = async (): Promise<void> => {
    if (recording) {
      stopRecording()
      return
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      toast.error('This browser cannot record audio.')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : ''
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
      chunks.current = []
      rec.ondataavailable = (ev) => {
        if (ev.data.size) chunks.current.push(ev.data)
      }
      rec.onstop = () => {
        stream.getTracks().forEach((track) => track.stop())
        setRecording(false)
        const blob = new Blob(chunks.current, { type: rec.mimeType || 'audio/webm' })
        const ext = (rec.mimeType || 'audio/webm').includes('mp4') ? 'm4a' : 'webm'
        const file = new File([blob], `recording-${Date.now()}.${ext}`, { type: blob.type || 'audio/webm' })
        void addFiles([file])
      }
      recorder.current = rec
      setSeconds(0)
      setRecording(true)
      rec.start()
    } catch {
      toast.error('Microphone permission was denied.')
    }
  }

  const canSend = (text.trim().length > 0 || attachments.length > 0) && !recording
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`

  return (
    <div
      className={cn('rounded-2xl border bg-card shadow-sm transition-shadow focus-within:shadow-md', over && 'ring-2 ring-primary')}
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        void addFiles([...e.dataTransfer.files])
      }}
    >
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 px-3 pt-3">
          {attachments.map((a) => (
            <span key={a.localId} className="relative">
              {a.kind === 'image' && a.previewUrl ? (
                <img src={a.previewUrl} alt={a.name} className="h-16 rounded-lg" />
              ) : a.kind === 'audio' && a.previewUrl ? (
                <audio controls src={a.previewUrl} className="h-10 max-w-56" />
              ) : (
                <FileChip name={a.name} />
              )}
              <button type="button" className="absolute -top-1.5 -right-1.5 rounded-full border bg-background p-0.5" onClick={() => remove(a.localId)} aria-label={`Remove ${a.name}`}>
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      {recording && <div className="px-4 pt-3 text-sm text-destructive">Recording {clock}</div>}
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onPaste={(e) => {
          const files = [...e.clipboardData.files]
          if (!files.length) return
          e.preventDefault()
          void addFiles(files)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            send()
          }
        }}
        placeholder={props.placeholder ?? 'How can I help you today?'}
        rows={1}
        className="block max-h-72 min-h-[52px] w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[15px] outline-none placeholder:text-muted-foreground/70"
        aria-label="Message"
      />
      <div className="flex items-center gap-2 px-2 pb-2">
        <input
          ref={fileRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            void addFiles([...(e.target.files ?? [])])
            e.target.value = ''
          }}
        />
        <Button type="button" size="icon" variant="ghost" className="size-8 rounded-lg" onClick={() => fileRef.current?.click()} aria-label="Attach a file" disabled={props.busy}>
          <Paperclip />
        </Button>
        <Button
          type="button"
          size="icon"
          variant={recording ? 'secondary' : 'ghost'}
          className="size-8 rounded-lg"
          onClick={() => void toggleRecord()}
          aria-label={recording ? 'Stop recording' : 'Record audio'}
          disabled={props.busy}
        >
          {recording ? <Square className="size-3.5 fill-current" /> : <Mic />}
        </Button>
        <ModeToggle value={props.mode} onChange={props.onModeChange} />
        <div className="min-w-0 flex-1">
          <TargetPicker value={props.target} onChange={props.onTargetChange} />
        </div>
        {props.busy ? (
          <Button size="icon" variant="secondary" className="size-8 rounded-lg" onClick={props.onStop} aria-label="Stop">
            <Square className="size-3.5 fill-current" />
          </Button>
        ) : (
          <Button size="icon" className={cn('size-8 rounded-lg', !canSend && 'opacity-50')} onClick={send} disabled={!canSend} aria-label="Send">
            <ArrowUp />
          </Button>
        )}
      </div>
    </div>
  )
}
