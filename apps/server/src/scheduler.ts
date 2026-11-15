import { Cron } from 'croner'
import { applyTextDelta, type AgentEvent, type Automation, type AutomationRun, type Core } from '@freeagent/core'

const LOG_LIMIT = 300

/** Runs automations on their cron schedules and on demand. */
export class Scheduler {
  private jobs = new Map<string, Cron>()
  private running = new Map<string, AbortController>()

  constructor(private readonly core: Core) {}

  start(): void {
    for (const a of this.core.store.listAutomations()) this.schedule(a)
  }

  stop(): void {
    for (const j of this.jobs.values()) j.stop()
    this.jobs.clear()
    for (const c of this.running.values()) c.abort()
  }

  static validate(schedule: string | null | undefined): string | null {
    if (!schedule) return null
    try {
      new Cron(schedule, { paused: true }).stop()
      return null
    } catch (err) {
      return err instanceof Error ? err.message : 'Invalid schedule'
    }
  }

  schedule(a: Automation): void {
    this.jobs.get(a.id)?.stop()
    this.jobs.delete(a.id)
    if (!a.enabled || !a.schedule) return
    try {
      const job = new Cron(a.schedule, { protect: true }, () => {
        void this.run(a.id).catch(() => undefined)
      })
      this.jobs.set(a.id, job)
    } catch {
      // invalid schedules are rejected at the API layer
    }
  }

  unschedule(automationId: string): void {
    this.jobs.get(automationId)?.stop()
    this.jobs.delete(automationId)
  }

  nextRun(automationId: string): number | null {
    return this.jobs.get(automationId)?.nextRun()?.getTime() ?? null
  }

  isRunning(automationId: string): boolean {
    return this.running.has(automationId)
  }

  cancel(automationId: string): boolean {
    const c = this.running.get(automationId)
    c?.abort()
    return !!c
  }

  /** Starts a run and resolves when it finishes. */
  async run(automationId: string): Promise<AutomationRun> {
    const a = this.core.store.getAutomation(automationId)
    if (!a) throw new Error('Automation not found')
    if (this.running.has(a.id)) throw new Error('This automation is already running')
    const run = this.core.store.startRun(a.id)
    const controller = new AbortController()
    this.running.set(a.id, controller)
    const log: AgentEvent[] = []
    let text = ''
    try {
      const result = await this.core.chats.runOnce({
        prompt: a.prompt,
        projectId: a.projectId,
        mode: a.mode,
        target: a.target,
        signal: controller.signal,
        emit: (ev) => {
          if (ev.type === 'text') {
            text = applyTextDelta(text, ev)
            return
          }
          if (log.length < LOG_LIMIT) log.push(ev)
        }
      })
      this.core.store.finishRun(run.id, { status: 'success', output: result.text || text, log })
    } catch (err) {
      const message = controller.signal.aborted ? 'Cancelled' : err instanceof Error ? err.message : String(err)
      this.core.store.finishRun(run.id, { status: 'error', output: text, log, error: message })
    } finally {
      this.running.delete(a.id)
    }
    return this.core.store.getRun(run.id)!
  }
}
