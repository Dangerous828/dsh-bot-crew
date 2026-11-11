/**
 * 「产出」：队伍交出来的文件。
 *
 * 产出不是一张新表，也不该新造一份状态。worker 干的是文件活，它把哪个文件写了、改了几次，
 * 宿主手里本来就有 —— 就是那张工单 worker 会话的事件流（`tool/call` 里的 write / edit）。
 * 这里只做「取文件写入、按路径合一、按时间倒排、限长」，不碰网络、不碰磁盘，和 screen.ts 同形。
 *
 * 没有的事一件也不补：
 * - 会话读不出来（工单结束、会话被回收）就是 `unavailable`，不是「没有产出」；
 * - 一张票读得出来、里面确实没有文件写入，才是 `empty`；
 * - 「截图」只按扩展名认成「图片」—— 文件名里没说它是截图，这里也不替它说。
 */

/** 产出物的两种类别。将来若要接别的东西（补丁、快照），是新的 kind，不影响 items 与 state 的形状。 */
export type OutputKind = 'file' | 'image'

/** 一条产出：一个被 worker 写过的文件。同一路径只列一条，`writes` 是它被写了几次。 */
export interface OutputItem {
  /** 稳定标识：工单号 + 路径。客户端据此去重，不要自己拼。 */
  id: string
  ticket_id: string
  ticket_title: string
  bot_id?: string
  kind: OutputKind
  /** 相对工作目录的路径（事件里给什么就是什么，这里不猜绝对路径）。 */
  path: string
  /** 这张工单的工作目录，有才给。 */
  cwd?: string
  /** 给人看的一行字：路径的末段。 */
  title: string
  /** 这个文件被写过几次。 */
  writes: number
  /** 最后一次写入的时间；说不清时是空串，排在最后。 */
  at: string
}

/**
 * `live` 有东西可列；`empty` 读得到、确实没有；`unavailable` 一张都读不出来。
 * 三者的区别是这一份契约的重点：把「读不出」写成「没有」，等于替队伍说了一句假话。
 */
export type OutputsState = 'live' | 'empty' | 'unavailable'

export interface OutputsView {
  items: OutputItem[]
  state: OutputsState
  /** 按 kind 的条数。空态时是 { file: 0, image: 0 }，不是缺字段 —— 结果条据此说那句话。 */
  counts: Record<OutputKind, number>
  /** `state` 不是 `live` 时说清楚为什么。 */
  reason?: string
  /** 只带 `?ticket=` 查单张票时才出现。 */
  ticket_id?: string
}

/** 一张票里够不够格当「产出」的那点信息；其余细节由会话事件给。 */
export interface OutputsTicket { id: string; title: string; bot_id?: string; cwd?: string }

/** 会话事件里我们只读这几个字段，形状与 screen.ts 的 ScreenEvent 一致。 */
export interface OutputEvent { type: string; time?: string; data?: unknown }

/** 认得的写入类工具。别的工具（bash、read）不产出文件，不在这一栏里装。 */
const WRITE_TOOLS = new Set(['write', 'edit'])
/** 参数里可能写路径的几个名字。认得几个就认几个，认不出就跳过这一条，不猜。 */
const PATH_KEYS = ['file_path', 'path', 'filePath', 'filename']
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|heic)$/i
const MAX_PATH_CHARS = 200
const MAX_ITEMS_PER_TICKET = 40
const MAX_ITEMS = 60

/** 参数有两种形状：已解析的对象，或一整段 JSON 字符串（真实事件里两种都出现过）。 */
function argumentsOf(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value !== 'string') return {}
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch { return {} }
}

/** 一条事件写的是哪个文件；认不出就是空串。 */
function writtenPath(event: OutputEvent): string {
  const data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : {}
  const name = typeof data.name === 'string' ? data.name : ''
  if (!WRITE_TOOLS.has(name)) return ''
  const args = argumentsOf(data.arguments)
  for (const key of PATH_KEYS) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) {
      const trimmed = value.trim()
      return trimmed.length > MAX_PATH_CHARS ? trimmed.slice(0, MAX_PATH_CHARS) : trimmed
    }
  }
  return ''
}

/** 文件名的末段：一眼看出交出来的是什么，不让一长串目录把一行占满。 */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.at(-1) ?? path
}

/**
 * 一张票的产出。纯函数：给事件就给结果，没事件就是空，绝不用别的东西顶上。
 * 时间缺省时保留上一条已知时间；都没有就不排在最前（没有时间的产出说不出是哪一次）。
 */
export function outputsOf(ticket: OutputsTicket, events: readonly OutputEvent[]): OutputItem[] {
  const byPath = new Map<string, OutputItem>()
  for (const event of events) {
    const path = writtenPath(event)
    if (!path) continue
    const at = typeof event.time === 'string' && event.time ? event.time : ''
    const seen = byPath.get(path)
    if (seen) {
      seen.writes += 1
      if (at) seen.at = at
      continue
    }
    byPath.set(path, {
      id: `${ticket.id}|${path}`,
      ticket_id: ticket.id,
      ticket_title: ticket.title,
      ...(ticket.bot_id ? { bot_id: ticket.bot_id } : {}),
      kind: IMAGE.test(path) ? 'image' : 'file',
      path,
      ...(ticket.cwd ? { cwd: ticket.cwd } : {}),
      title: baseName(path),
      writes: 1,
      at,
    })
  }
  return [...byPath.values()]
    // 没有时间的排最后：它确实发生过，只是说不清什么时候。
    .sort((left, right) => (right.at || '').localeCompare(left.at || ''))
    .slice(0, MAX_ITEMS_PER_TICKET)
}

/** 数一数各类有几条。结果条上那句「两张图片」就是从这里来的。 */
export function countOutputs(items: readonly OutputItem[]): Record<OutputKind, number> {
  return items.reduce<Record<OutputKind, number>>((counts, item) => {
    counts[item.kind] += 1
    return counts
  }, { file: 0, image: 0 })
}

/**
 * 把若干张票的产出合成一栏。
 *
 * `read` 读一张票的会话事件；读不出来就抛，由这里记成「这张读不出来」——
 * 一张票读不出来不该让整栏报错，但也不能因此就说「没有产出」。
 */
export async function outputsView(
  tickets: readonly OutputsTicket[],
  read: (ticketId: string) => Promise<readonly OutputEvent[]>, limit = MAX_ITEMS,
): Promise<OutputsView> {
  const reads = await Promise.allSettled(tickets.map(ticket => read(ticket.id)))
  const items: OutputItem[] = []
  let unreadable = 0
  for (const [index, result] of reads.entries()) {
    const ticket = tickets[index]
    if (!ticket) continue
    if (result.status === 'rejected') { unreadable += 1; continue }
    items.push(...outputsOf(ticket, result.value))
  }
  items.sort((left, right) => (right.at || '').localeCompare(left.at || ''))
  const kept = items.slice(0, Math.max(1, limit))
  const counts = countOutputs(kept)
  if (kept.length > 0) return { items: kept, state: 'live', counts }
  // 读得出来的都读了，确实没有文件改动。
  if (unreadable === 0) {
    return { items: [], state: 'empty', counts,
      reason: tickets.length === 0 ? '队伍还没有工单，也就还没有产出' : '这些工单里还没有文件改动' }
  }
  // 全都读不出来，那是「读不到」，不是「没有」。
  if (unreadable === tickets.length) {
    return { items: [], state: 'unavailable', counts,
      reason: tickets.length === 1 ? '这张工单的执行记录读不出来了' : '这些工单的执行记录都读不出来了' }
  }
  // 一部分读得出来、里面没有产出，另一部分读不出来的：如实说清是哪一半空着。
  return { items: [], state: 'empty', counts,
    reason: `读得出来的工单里没有文件改动，另有 ${unreadable} 张的执行记录读不出来` }
}
