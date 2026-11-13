/**
 * 群组只读投影（契约 §3 / GLOSSARY「群组只读投影」）。
 *
 * 「把多个 bot/会话按群组展示」不是一张新账：会话名单、花名册、工单本来就都在。
 * 这里只做一件事 —— 把它们按「会话归属为主」摆成几组，供桌面与手机只读地画出来。
 *
 * 只读的三条边界，一行都不越：
 * - 零新增 Ticket 账：`ticket_count` 只数，不写；输出里没有工单对象，只有个数。
 * - 零新增持久化状态：纯函数，不碰 Store、不碰 KV、不碰磁盘、不落缓存。
 * - 不改路由语义：不注册新 operation，不改变任何一条请求往哪儿派。
 *
 * 三态诚实（GLOSSARY「群组三态」，与产出 / 常规任务 / 记忆同口径）：
 * - `live`：读得到，且确实有归组数据；
 * - `empty`：三个源都读到了、确实一条都没有；
 * - `unavailable`：某个源读不到。**读不到绝不当空** —— 源整份缺席（null/undefined）
 *   时不能用 `?? []` 兜成「没有」，那等于替队伍说了一句假话。
 */

/** `live` 有归组数据；`empty` 读得到、确实没有；`unavailable` 读不到。 */
export type GroupsState = 'live' | 'empty' | 'unavailable'

/** 无归属的成员落这个组。它也是缺省会话的名字（`sessionIds()` 恒把它排在首位）。 */
export const MAIN_GROUP = 'main'

/** 一份会话。字符串形态是老名单（`sessionIds()` 给的就是它）；对象形态可声明所属群组。 */
export interface GroupSession {
  id: string
  /** 所属群组；没给就自成一组（组 id 即会话 id）。 */
  group?: string
  /** 给人看的组名；没给就用组 id，不编一个中文名。 */
  title?: string
}

/** 一位 Bot。按 `session_id` 找到那个会话所在的组；查不到就落 `main`。 */
export interface GroupBot {
  id: string
  name?: string
  /** 归属会话（与后端 `crewRoster` / `ticketBot` 的字段名对齐）。 */
  session_id?: string
  /** 显式群组归属，只在会话归属查不到、且该组确实存在时才生效。 */
  group?: string
}

/** 一张工单。只读地数进去，不产生第二份 Ticket 账。 */
export interface GroupTicket {
  id: string
  /** 归属会话；`conversation` 与 `channels[].address.conversation` 是同一件事的老形态。 */
  session_id?: string
  conversation?: string
  channels?: readonly { address?: Record<string, string> }[]
  /** 显式群组归属，同样只在会话归属查不到、且该组确实存在时才生效。 */
  group?: string
}

/** 一个群组的只读投影。sessions / bots 存 id，桌面端自己按 id 查名字。 */
export interface Group {
  id: string
  title: string
  sessions: string[]
  bots: string[]
  /** 只数不写：这一组落了几张工单。 */
  ticket_count: number
}

/** 整份投影。`groups` 就是契约 §3 要的 `groups[]`；`reason` 只在非 `live` 时出现。 */
export interface GroupsView {
  groups: Group[]
  state: GroupsState
  reason?: string
}

/**
 * 三个源。`null` / `undefined` 表示「读不到」，`[]` 表示「读得到、确实没有」——
 * 这两者必须能分开，否则三态里最要紧的那一格就消失了。
 */
export interface GroupsInput {
  sessions?: readonly (string | GroupSession)[] | null
  bots?: readonly GroupBot[] | null
  tickets?: readonly GroupTicket[] | null
  /** 上游整份读不到时给一句实话（例如 Store 抛错）。给了就判 unavailable，绝不落到空态。 */
  unavailableReason?: string
}

/** 自定义守卫保留 readonly 元素类型；内置的 `Array.isArray` 会把类型放宽成 any[]。 */
function readable<T>(value: readonly T[] | null | undefined): value is readonly T[] {
  return Array.isArray(value)
}

function unavailableView(reason: string): GroupsView {
  return { groups: [], state: 'unavailable', reason }
}

function sessionIdOf(session: string | GroupSession): string {
  return typeof session === 'string' ? session : session.id
}

/** 工单的会话归属：新字段优先，其次是老字段，最后是 channel.address.conversation。 */
function ticketSessionOf(ticket: GroupTicket): string {
  if (ticket.session_id) return ticket.session_id
  if (ticket.conversation) return ticket.conversation
  for (const channel of ticket.channels ?? []) {
    const where = channel?.address?.conversation
    if (where) return where
  }
  return ''
}

function trimmed(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 从已有 sessions / bots / tickets 派生群组投影。纯函数：不改输入、不读 Store、
 * 不写任何状态。组集合只由会话名单 + `main` 兜底决定，绝不凭空造一个组。
 */
export function groupsOf(input: GroupsInput): GroupsView {
  if (input.unavailableReason) return unavailableView(input.unavailableReason)

  const { sessions, bots, tickets } = input
  // 读不到 ≠ 空：任一源整份缺席就是 unavailable，绝不 `?? []` 兜成「没有群组」。
  if (!readable(sessions) || !readable(bots) || !readable(tickets)) {
    return unavailableView('会话名单、花名册或工单读不到，群组投影暂不可用')
  }
  if (sessions.length === 0 && bots.length === 0 && tickets.length === 0) {
    return { groups: [], state: 'empty', reason: '读得到会话、花名册与工单，确实还没有可分组的数据' }
  }

  // `main` 恒在首位：它是缺省会话，也是所有无归属成员的落点。
  const groups = new Map<string, Group>()
  groups.set(MAIN_GROUP, { id: MAIN_GROUP, title: MAIN_GROUP, sessions: [], bots: [], ticket_count: 0 })
  /** 会话 id → 它所在的组。bot / ticket 按归属会话查这张表。 */
  const sessionGroup = new Map<string, string>()

  const ensure = (id: string): Group => {
    const existing = groups.get(id)
    if (existing) return existing
    const created: Group = { id, title: id, sessions: [], bots: [], ticket_count: 0 }
    groups.set(id, created)
    return created
  }

  // 1) 会话归属为主：一个对象可以声明 group，多个会话因此落进同一组；没声明就自成一组。
  for (const session of sessions) {
    const id = sessionIdOf(session)
    if (!id) continue // 坏行跳过，不拿空 id 编一个组
    const declared = typeof session === 'string' ? '' : trimmed(session.group)
    const groupId = declared || id
    const group = ensure(groupId)
    const title = typeof session === 'string' ? '' : trimmed(session.title)
    if (title && group.title === group.id) group.title = title
    if (!group.sessions.includes(id)) group.sessions.push(id)
    sessionGroup.set(id, groupId)
  }

  /** 归属会话优先；显式 group 只在它已是已知组时生效；都查不到就落 main。 */
  const resolve = (sessionId: string, claimed: string | undefined): string => {
    const fromSession = sessionGroup.get(sessionId)
    if (fromSession && groups.has(fromSession)) return fromSession
    const declared = trimmed(claimed)
    if (declared && groups.has(declared)) return declared
    return MAIN_GROUP
  }

  // 2) bot 按归属会话归组；指向名单外会话、或压根没归属的，落 main。
  const seenBots = new Set<string>()
  for (const bot of bots) {
    if (!bot?.id || seenBots.has(bot.id)) continue
    seenBots.add(bot.id)
    ensure(resolve(bot.session_id ?? '', bot.group)).bots.push(bot.id)
  }

  // 3) 工单只数不写：按同一套归属加一次 ticket_count，重复的票号只算一张。
  const seenTickets = new Set<string>()
  for (const ticket of tickets) {
    if (!ticket?.id || seenTickets.has(ticket.id)) continue
    seenTickets.add(ticket.id)
    ensure(resolve(ticketSessionOf(ticket), ticket.group)).ticket_count += 1
  }

  return { groups: [...groups.values()], state: 'live' }
}
