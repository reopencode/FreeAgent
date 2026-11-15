import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ShieldAlert } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { useNav } from '@/lib/nav'
import { keys, useApprovals } from '@/lib/queries'

/** Tool calls waiting on the user that are not shown inline, e.g. from automations or another chat. */
export function ApprovalBanner(): React.JSX.Element | null {
  const { route } = useNav()
  const approvals = useApprovals()
  const qc = useQueryClient()
  const decide = useMutation({
    mutationFn: ({ id, approved }: { id: string; approved: boolean }) => api.post(`/api/approvals/${id}`, { approved }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.approvals }),
    onError: (e) => toast.error(e.message)
  })
  const currentChat = route.view === 'chat' ? route.chatId : undefined
  const elsewhere = (approvals.data ?? []).filter((a) => !a.chatId || a.chatId !== currentChat)
  if (!elsewhere.length) return null
  const a = elsewhere[0]
  return (
    <div className="flex flex-wrap items-center gap-3 border-b bg-amber-500/10 px-4 py-2 text-sm">
      <ShieldAlert className="size-4 shrink-0 text-amber-600" />
      <div className="min-w-0 flex-1">
        <span className="font-medium">{a.chatId ? 'Another chat' : 'An automation'} wants to run {a.name}:</span>{' '}
        <code className="rounded bg-background/60 px-1 font-mono text-xs break-all">{a.summary}</code>
        {elsewhere.length > 1 && <span className="ml-2 text-muted-foreground">+{elsewhere.length - 1} more</span>}
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={() => decide.mutate({ id: a.id, approved: false })}>
          Deny
        </Button>
        <Button size="sm" onClick={() => decide.mutate({ id: a.id, approved: true })}>
          Approve
        </Button>
      </div>
    </div>
  )
}
