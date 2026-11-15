import { useEffect, useRef, useState } from 'react'
import type { ChatMode } from '@core/api-types'
import { ArrowUp, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { ModeToggle } from './ModeToggle'
import { TargetPicker } from './TargetPicker'

interface Props {
  mode: ChatMode
  target: string
  onModeChange: (m: ChatMode) => void
  onTargetChange: (t: string) => void
  onSend: (text: string) => void
  onStop: () => void
  busy: boolean
  placeholder?: string
  autoFocus?: boolean
  initialText?: string
}

export function Composer(props: Props): React.JSX.Element {
  const [text, setText] = useState(props.initialText ?? '')
  const ref = useRef<HTMLTextAreaElement>(null)

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

  const send = (): void => {
    const t = text.trim()
    if (!t || props.busy) return
    props.onSend(t)
    setText('')
  }

  return (
    <div className="rounded-2xl border bg-card shadow-sm transition-shadow focus-within:shadow-md">
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
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
        <ModeToggle value={props.mode} onChange={props.onModeChange} />
        <div className="min-w-0 flex-1">
          <TargetPicker value={props.target} onChange={props.onTargetChange} />
        </div>
        {props.busy ? (
          <Button size="icon" variant="secondary" className="size-8 rounded-lg" onClick={props.onStop} aria-label="Stop">
            <Square className="size-3.5 fill-current" />
          </Button>
        ) : (
          <Button size="icon" className={cn('size-8 rounded-lg', !text.trim() && 'opacity-50')} onClick={send} disabled={!text.trim()} aria-label="Send">
            <ArrowUp />
          </Button>
        )}
      </div>
    </div>
  )
}
