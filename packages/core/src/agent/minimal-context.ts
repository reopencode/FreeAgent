import type { ChatMessage, ToolSpec } from '../types'

const TOOL_DESCRIPTION_MAX = 80
/** Injected by the agent runner between tasks. These are part of the current run, not earlier chat history. */
const TASK_PREFIX = 'Current task ('

/** One instruction line. Personal instructions, project files, memories and plugins are left out. */
export function minimalSystemLine(cwd?: string): string {
  const folder = cwd ? ` You are working in ${cwd}.` : ''
  return `You are an agent.${folder} Call tools to do the work. Do only the current task. Finish with a short summary.`
}

/**
 * The smallest agent transcript that can still call tools: a one-line system prompt, the latest real user
 * message (with its attachments), and everything after it (task lines, tool calls and tool results).
 */
export function minimalAgentMessages(messages: ChatMessage[], cwd?: string): ChatMessage[] {
  let start = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'user' && !m.content.startsWith(TASK_PREFIX)) {
      start = i
      break
    }
  }
  const rest = start < 0 ? [] : messages.slice(start)
  return [{ role: 'system', content: minimalSystemLine(cwd) }, ...rest]
}

/** Keeps tool names and parameters. Long descriptions are the bulk of a tool list, so they are shortened. */
export function compactToolSpecs(tools: ToolSpec[]): ToolSpec[] {
  return tools.map((t) => {
    if (t.description.length <= TOOL_DESCRIPTION_MAX) return t
    return { ...t, description: `${t.description.slice(0, TOOL_DESCRIPTION_MAX - 1)}…` }
  })
}

/**
 * Agent steps for a checked provider send the short transcript and shortened tools.
 * Chat mode, and providers that are not checked, keep the messages and tools they were given.
 */
export function agentRequestForProvider(
  providerId: string,
  selected: readonly string[] | undefined,
  messages: ChatMessage[],
  tools: ToolSpec[] | undefined,
  cwd?: string
): { messages: ChatMessage[]; tools?: ToolSpec[] } {
  if (!tools?.length || !selected?.includes(providerId)) return { messages, tools }
  return { messages: minimalAgentMessages(messages, cwd), tools: compactToolSpecs(tools) }
}
