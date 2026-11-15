import { id } from '../util'

export interface ApprovalRequest {
  id: string
  chatId?: string
  toolCallId: string
  name: string
  args: string
  summary: string
  createdAt: number
}

/** Holds tool calls that wait for the user to approve or deny them in the UI. */
export class Approvals {
  private pending = new Map<string, { req: ApprovalRequest; resolve: (ok: boolean) => void; timer: NodeJS.Timeout }>()

  request(input: Omit<ApprovalRequest, 'id' | 'createdAt'>, signal?: AbortSignal, timeoutMs = 10 * 60_000): { req: ApprovalRequest; decision: Promise<boolean> } {
    const req: ApprovalRequest = { ...input, id: id('apr_'), createdAt: Date.now() }
    const decision = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => this.resolve(req.id, false), timeoutMs)
      this.pending.set(req.id, { req, resolve, timer })
      signal?.addEventListener('abort', () => this.resolve(req.id, false), { once: true })
    })
    return { req, decision }
  }

  resolve(approvalId: string, approved: boolean): boolean {
    const p = this.pending.get(approvalId)
    if (!p) return false
    clearTimeout(p.timer)
    this.pending.delete(approvalId)
    p.resolve(approved)
    return true
  }

  list(): ApprovalRequest[] {
    return [...this.pending.values()].map((p) => p.req)
  }
}
