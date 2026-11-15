import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChatMode, StoredMessage } from '@core/api-types'
import { useQueryClient } from '@tanstack/react-query'
import { Code2, FolderKanban, Globe, Loader2, Newspaper, Sparkles, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Composer } from '@/components/chat/Composer'
import { AssistantMessage, UserMessage, type AssistantView } from '@/components/chat/Messages'
import { api } from '@/lib/api'
import { useNav } from '@/lib/nav'
import { keys, useChat, useProject, useProviders } from '@/lib/queries'
import { startReply, stopReply, useLiveReply } from '@/lib/streams'

const SUGGESTIONS = [
  { icon: Code2, text: 'Write a Python script that renames photos by the date they were taken', mode: 'agent' as ChatMode },
  { icon: Globe, text: 'Search the web for this week\'s biggest open-source AI releases and summarize them', mode: 'agent' as ChatMode },
  { icon: Sparkles, text: 'Explain the difference between RAG and fine-tuning with a simple example', mode: 'council' as ChatMode },
  { icon: Newspaper, text: 'Draft a polite email asking my landlord to fix the heating', mode: 'chat' as ChatMode }
]

function greeting(): string {
  const h = new Date().getHours()
  if (h < 5) return 'Working late?'
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
}

function lastUsed(): { mode: ChatMode; target: string } {
  return {
    mode: (localStorage.getItem('freeagent.mode') as ChatMode) || 'chat',
    target: localStorage.getItem('freeagent.target') || 'auto'
  }
}

function toView(m: StoredMessage): AssistantView {
  return {
    content: m.content,
    providerId: m.meta.providerId,
    model: m.meta.model,
    attempts: m.meta.attempts,
    steps: m.meta.steps,
    council: m.meta.council,
    error: m.meta.error,
    durationMs: m.meta.durationMs
  }
}

export function ChatView({ chatId, projectId }: { chatId?: string; projectId?: string }): React.JSX.Element {
  const { go } = useNav()
  const qc = useQueryClient()
  const chat = useChat(chatId)
  const providers = useProviders()
  const project = useProject(chat.data?.chat.projectId ?? projectId)
  const live = useLiveReply(chatId)
  const [mode, setMode] = useState<ChatMode>(lastUsed().mode)
  const [target, setTarget] = useState<string>(lastUsed().target)
  const [draft, setDraft] = useState<string | undefined>()
  const [creating, setCreating] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  useEffect(() => {
    if (chat.data) {
      setMode(chat.data.chat.mode)
      setTarget(chat.data.chat.target)
    }
  }, [chat.data?.chat.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const changeMode = (m: ChatMode): void => {
    setMode(m)
    localStorage.setItem('freeagent.mode', m)
  }
  const changeTarget = (t: string): void => {
    setTarget(t)
    localStorage.setItem('freeagent.target', t)
  }

  const messages = useMemo(() => (chat.data?.messages ?? []).filter((m) => m.role === 'user' || m.role === 'assistant'), [chat.data])

  useEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [messages.length, live?.content, live?.steps.length, live?.status])

  const readyReal = (providers.data ?? []).filter((p) => p.enabled && p.status.state === 'ready' && p.id !== 'mock')

  const send = async (text: string): Promise<void> => {
    if (chatId) {
      startReply(chatId, { content: text, mode, target })
      return
    }
    setCreating(true)
    try {
      const c = await api.post<{ id: string }>('/api/chats', { projectId: projectId ?? null, mode, target })
      startReply(c.id, { content: text, mode, target })
      void qc.invalidateQueries({ queryKey: keys.chats })
      go({ view: 'chat', chatId: c.id })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
      setCreating(false)
    }
  }

  const composer = (
    <Composer
      mode={mode}
      target={target}
      onModeChange={changeMode}
      onTargetChange={changeTarget}
      onSend={(t) => void send(t)}
      onStop={() => chatId && stopReply(chatId)}
      busy={!!live || creating}
      autoFocus
      initialText={draft}
      placeholder={chatId ? 'Reply…' : mode === 'agent' ? 'Describe a task. The agent can use files, the shell, the web and coding agents…' : undefined}
    />
  )

  if (!chatId) {
    return (
      <div className="flex h-full flex-col items-center overflow-y-auto px-4">
        <div className="flex w-full max-w-2xl flex-1 flex-col justify-center gap-6 py-10">
          <div className="text-center">
            {project.data && (
              <Badge variant="secondary" className="mb-3 gap-1">
                <FolderKanban className="size-3" />
                {project.data.project.name}
              </Badge>
            )}
            <h1 className="font-serif text-3xl tracking-tight sm:text-4xl">{greeting()}</h1>
            <p className="mt-2 text-muted-foreground">Free models, your web plans and local coding agents, in one place.</p>
          </div>
          {providers.isSuccess && readyReal.length === 0 && (
            <div className="flex flex-col gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 sm:flex-row sm:items-center">
              <TriangleAlert className="size-5 shrink-0 text-amber-600" />
              <div className="flex-1 text-sm">
                <div className="font-medium">No provider is set up yet</div>
                <div className="text-muted-foreground">Replies will come from the offline demo. Add a free OpenRouter or Gemini key, or connect a web plan.</div>
              </div>
              <Button size="sm" onClick={() => go({ view: 'customize', tab: 'providers' })}>
                Set up providers
              </Button>
            </div>
          )}
          {composer}
          <div className="grid gap-2 sm:grid-cols-2">
            {SUGGESTIONS.map((s) => (
              <button
                key={s.text}
                onClick={() => {
                  changeMode(s.mode)
                  setDraft(s.text)
                }}
                className="flex items-start gap-2.5 rounded-xl border bg-card/50 p-3 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <s.icon className="mt-0.5 size-4 shrink-0" />
                {s.text}
              </button>
            ))}
          </div>
        </div>
      </div>
    )
  }

  const showLiveUser = live && !messages.some((m) => m.id === live.userMessageId)

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{chat.data?.chat.title ?? ' '}</h2>
        {project.data && (
          <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => go({ view: 'projects', projectId: project.data!.project.id })}>
            <FolderKanban />
            {project.data.project.name}
          </Button>
        )}
      </header>
      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
      >
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6">
          {chat.isLoading && (
            <div className="space-y-4">
              <Skeleton className="ml-auto h-10 w-1/2" />
              <Skeleton className="h-24 w-full" />
            </div>
          )}
          {chat.isError && (
            <div className="flex flex-col items-center gap-3 py-16 text-center text-sm text-muted-foreground">
              This chat could not be loaded. It may have been deleted.
              <Button variant="outline" onClick={() => go({ view: 'chat' })}>
                Start a new chat
              </Button>
            </div>
          )}
          {messages.map((m) => (m.role === 'user' ? <UserMessage key={m.id} text={m.content} /> : <AssistantMessage key={m.id} view={toView(m)} />))}
          {live && (
            <>
              {showLiveUser && <UserMessage text={live.userText} />}
              <AssistantMessage
                view={{
                  content: live.content,
                  providerId: live.providerId,
                  model: live.model,
                  attempts: live.attempts,
                  steps: live.steps,
                  council: live.council,
                  error: live.error,
                  status: live.status,
                  approvals: live.approvals,
                  streaming: true
                }}
              />
            </>
          )}
        </div>
      </div>
      <div className="shrink-0 px-4 pb-4">
        <div className="mx-auto w-full max-w-3xl">
          {composer}
          <p className="mt-2 flex items-center justify-center gap-1 text-center text-[11px] text-muted-foreground">
            {live ? <Loader2 className="size-3 animate-spin" /> : null}
            Free models make mistakes. Check important answers.
          </p>
        </div>
      </div>
    </div>
  )
}
