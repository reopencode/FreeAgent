import { cn } from '@/lib/utils'

export function Logo({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 32 32" className={cn('size-6', className)} aria-hidden>
      <rect width="32" height="32" rx="8" className="fill-primary" />
      <path d="M9 23V9h11M9 16h8" stroke="white" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <circle cx="23" cy="21" r="2.6" fill="white" />
    </svg>
  )
}
