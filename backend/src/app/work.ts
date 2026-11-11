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

/** 一张票此刻的计划：共几步、完成几步。 */
export interface Plan { total: number; done: number }

/** 待办里算「走完了」的几个写法：DSH 写 `completed`，老事件里也见过 `done` / `checked`。 */
const PLAN_DONE = new Set(['completed', 'done', 'checked'])
/** 上限。待办是给人看的一张单子，不是数据集：超出这个数的只按上限算，免得一个坏事件把界面撑爆。 */
const PLAN_MAX_STEPS = 200

/**
 * 从一条 `todo/write` 事件的 data 里数出「共几步、完成几步」。
 *
 * 认三种写法：`todos` / `items` 是数组，或 data 自己就是数组。每一项是否完成看
 * `status` / `done` / `state`。认不出来就返回 undefined —— 宁可不画进度条，
 * 也不拿一个猜出来的分母当真。
 */
export function planOf(data: unknown): Plan | undefined {
  const list = Array.isArray(data) ? data
    : data && typeof data === 'object'
      ? ((data as { todos?: unknown; items?: unknown }).todos ?? (data as { items?: unknown }).items)
      : undefined
  if (!Array.isArray(list) || list.length === 0) return undefined
  const total = Math.min(list.length, PLAN_MAX_STEPS)
  let done = 0
  for (const item of list.slice(0, total)) {
    if (!item || typeof item !== 'object') continue
    const todo = item as { status?: unknown; done?: unknown; state?: unknown }
    const status = typeof todo.status === 'string' ? todo.status.toLowerCase() : ''
    const state = typeof todo.state === 'string' ? todo.state.toLowerCase() : ''
    if (PLAN_DONE.has(status) || PLAN_DONE.has(state) || todo.done === true) done++
  }
  return { total, done }
}

/**
 * 一张票最新的计划：取它最后一条 `todo/write`。worker 每改一次待办就整份重写，
 * 所以最后一条就是现在的全部，不需要把历史叠起来。
 *
 * 没有这样的事件就返回 undefined。这里不看 assignments：它们记的是「派了几次活」，
 * 不是「计划里有几步」，拿它当分母会画出一根永远不满的假进度条。
 */
export function planFrom(events: readonly { type: string; data?: unknown }[]): Plan | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (!event || event.type !== 'todo/write') continue
    // 最后一条读不懂时不再往前翻：那是 worker 此刻的状态，不是它早些时候的状态。
    return planOf(event.data)
  }
  return undefined
}

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
export function switchModel(settings: Settings, requested: { provider: string; model: string; reasoningEffort?: string; bot_id?: string }): Settings {
  // 指定成员时改的是那位成员的模型；没指定才是全场默认。空 effort 从旧值继承，
  // 这样换模型不会把之前选好的推理档位悄悄丢掉。
  const previous = requested.bot_id
    ? settings.executor.botModels?.[requested.bot_id]
    : settings.executor.model
  const selected = {
    provider: requested.provider, model: requested.model,
    ...requested.reasoningEffort ?? previous?.reasoningEffort ? { reasoningEffort: requested.reasoningEffort ?? previous?.reasoningEffort } : {},
  }
  if (requested.bot_id) {
    return { ...settings, executor: { ...settings.executor,
      botModels: { ...settings.executor.botModels, [requested.bot_id]: selected } } }
  }
  return { ...settings, executor: { ...settings.executor, model: selected } }
}
