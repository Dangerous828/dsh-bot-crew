/**
 * What a phone asks beyond the timeline: how one ticket was worked, which agents ran under it, and what model
 * the crew is on. These read the store and the live session tree; they are not gateway traffic.
 */
import type { Settings } from '../policy.ts'
import type { Ticket } from '../core/index.ts'
import { ticketStage } from '../core/index.ts'
import { workerSessionId } from '../executor/dsh.ts'

/** The live session registry the tree is walked from: DSH's `ctx.agents`, which reads by id and lists every id. */
export interface AgentRegistry {
  get(sessionId: string): { session: { header: { parentSession?: string }; id?: string } } | undefined
  list?(): string[]
}

export interface WorkStep { at: string; kind: 'said' | 'did' | 'checked'; text: string }
export interface WorkView { ticket_id: string; title: string; stage: string; bot_id?: string; steps: WorkStep[] }

/** One agent under a ticket. A subagent of a subagent is a child again, so the shape carries any depth. */
export interface AgentNode { id: string; label: string; state: string; children: AgentNode[] }

/**
 * How a ticket was worked. The store keeps the ticket; the transcript itself lives with the worker session, so this
 * reports the stages the ticket passed and the Bot that owns it. Steps the worker wrote are appended when the store
 * has them, and the list is ordered by time either way.
 */
/**
 * The ticket's assignments as steps. The store keeps a state and a summary per assignment, not a turn-by-turn log.
 * A summary is written when the assignment reports, so the time that orders it is the end, not the start: two
 * overlapping assignments would otherwise list their conclusions backwards.
 */
export function stepsOf(ticket: Pick<Ticket, 'assignments'>): WorkStep[] {
  const assignments = Array.isArray(ticket.assignments) ? ticket.assignments : []
  return assignments.flatMap(assignment => {
    const summary = assignment.report?.summary?.trim()
    // 报告自带时间，那才是「结论什么时候得出」。退回结束时间，再退回开始时间。
    const at = assignment.report?.at ?? assignment.endedAt ?? assignment.startedAt
    // An assignment with no summary said nothing worth showing; a step with empty text is noise.
    if (!summary || !at) return []
    return [{ at, kind: assignment.state === 'ended' ? 'did' : 'said', text: summary } as WorkStep]
  })
}

export function workOf(ticket: Ticket | undefined): WorkView | undefined {
  if (!ticket) return undefined
  const channel = ticket.channels.find(entry => entry.source === 'team' || entry.source === 'mobile')
  const botId = (channel as { bot_id?: unknown } | undefined)?.bot_id
  // A ticket that ended reports its outcome. A live one asks the stage machine, which reads the assignments; a ticket
  // stored before that machine can answer still gets its title and owner rather than a failed request.
  let stage = 'unknown'
  try { stage = ticket.ended?.outcome ?? ticketStage(ticket).stage } catch { stage = 'unknown' }
  return {
    ticket_id: ticket.id,
    title: ticket.title,
    stage,
    ...typeof botId === 'string' && botId ? { bot_id: botId } : {},
    steps: stepsOf(ticket).sort((left, right) => left.at.localeCompare(right.at)),
  }
}

/**
 * The agents that ran under a ticket, as a tree. The worker session is the root; every session whose parent chain
 * reaches it is a descendant. The walk stops at `maxDepth` so a cycle in the headers cannot hang the request.
 */
export function agentTree(agents: AgentRegistry, ticketId: string, maxDepth = 8, known: string[] = []): AgentNode[] {
  const root = workerSessionId(ticketId)
  if (!agents.get(root)) return []
  const children = new Map<string, string[]>()
  const attach = (parent: string, id: string): void => {
    const list = children.get(parent) ?? []
    if (!list.includes(id)) children.set(parent, [...list, id])
  }
  // Only sessions the runtime still knows about can be walked; a disposed agent has no header to read.
  for (const id of known.length > 0 ? known : liveSessionIds(agents)) {
    if (id === root) continue
    // Follow the parent chain up. The session is attached under the parent that reached the tree FIRST, so a
    // grandchild hangs under its own parent instead of being flattened onto the worker.
    let parent = agents.get(id)?.session.header.parentSession
    for (let depth = 0; parent !== undefined && depth < maxDepth; depth++) {
      if (parent === root || children.has(parent) || under(parent, root, agents, maxDepth)) { attach(parent, id); break }
      parent = agents.get(parent)?.session.header.parentSession
    }
  }
  const build = (id: string, depth: number): AgentNode => ({
    id,
    label: agents.get(id)?.session.header.parentSession ? '子代理' : '工单',
    state: 'working',
    children: depth >= maxDepth ? [] : (children.get(id) ?? []).map(child => build(child, depth + 1)),
  })
  return [build(root, 0)]
}

/** True when `id` reaches `root` through its parent chain, which is what puts it in the tree. */
function under(id: string, root: string, agents: AgentRegistry, maxDepth: number): boolean {
  let parent = agents.get(id)?.session.header.parentSession
  for (let depth = 0; parent !== undefined && depth < maxDepth; depth++) {
    if (parent === root) return true
    parent = agents.get(parent)?.session.header.parentSession
  }
  return false
}

/**
 * Which session ids the runtime still has. `ctx.agents` only answers by id, so the ids come from the callers that
 * recorded them; a registry that also lists is used directly.
 */
function liveSessionIds(agents: AgentRegistry): string[] {
  const listed = (agents as { list?: () => string[] }).list
  return typeof listed === 'function' ? listed() : []
}

/**
 * Changes the model the crew's workers run on. `provider` is required because a model name alone names nothing the
 * runtime can reach; `reasoningEffort` is kept from the current setting unless the caller names a new one.
 */
export function switchModel(settings: Settings, requested: { provider: string; model: string; reasoningEffort?: string }): Settings {
  const previous = settings.executor.model
  return { ...settings, executor: { ...settings.executor, model: {
    provider: requested.provider, model: requested.model,
    ...requested.reasoningEffort ?? previous?.reasoningEffort ? { reasoningEffort: requested.reasoningEffort ?? previous?.reasoningEffort } : {},
  } } }
}
