import type { ChatMode } from '@core/api-types'
import { Bot, MessageCircle, Users } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

const MODES: { id: ChatMode; label: string; icon: typeof Bot; hint: string }[] = [
  { id: 'chat', label: 'Chat', icon: MessageCircle, hint: 'Plain conversation with one provider' },
  { id: 'agent', label: 'Agent', icon: Bot, hint: 'Uses tools: files, shell, web, browser, OpenCode/Kiro/Kilo/Claude Code and MCP servers' },
  { id: 'council', label: 'Council', icon: Users, hint: 'Asks several providers at once and merges the best answer' }
]

export function ModeToggle({ value, onChange }: { value: ChatMode; onChange: (m: ChatMode) => void }): React.JSX.Element {
  return (
    <div className="flex items-center rounded-lg bg-muted p-0.5" role="radiogroup" aria-label="Mode">
      {MODES.map((m) => (
        <Tooltip key={m.id}>
          <TooltipTrigger asChild>
            <button
              role="radio"
              aria-checked={value === m.id}
              onClick={() => onChange(m.id)}
              className={cn(
                'flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-muted-foreground transition-colors',
                value === m.id && 'bg-background text-foreground shadow-sm'
              )}
            >
              <m.icon className="size-3.5" />
              <span className={cn(value === m.id ? 'inline' : 'hidden sm:inline')}>{m.label}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent>{m.hint}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  )
}
