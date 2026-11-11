/**
 * 记忆这一栏：手机和桌面共用的形状。
 *
 * 和 `outputs` / `routines` 同一套三态：`live` 有记忆；`empty` 读得到、确实没有；
 * `unavailable` 读不出来。把「读不出」写成「没有」，是替队伍编一句话。
 *
 * 这一栏是主人能看、能改、能忘的地方。「忘掉」不删行 —— 翻成 `forgotten`，
 * 因为删掉就再也答不出「它曾经这么以为了」。
 */
import type { MemoryEntry } from '../../memory/recall.ts'

/** 一条记忆在界面上的一行。正文完整给出，因为主人要看的是它到底记住了什么。 */
export interface MemoryItem {
  name: string
  bot_id: string
  description: string
  body: string
  type: MemoryEntry['type']
  importance: number
  state: MemoryEntry['state']
  /** 秒级时间戳，界面自己按本地时区显示。 */
  created: number
  updated: number
  /** 谁写的：`person:<id>` / `ticket:<id>` / `host`。 */
  origin?: string
  /** 从哪张票、哪一轮来的，便于回查。 */
  source?: MemoryEntry['source']
  /** 这条会不会上行到中枢 Hub；本地提炼的一律 false。 */
  to_hub: boolean
}

export type MemoryState = 'live' | 'empty' | 'unavailable'

export interface MemoryView {
  items: MemoryItem[]
  state: MemoryState
  counts: { active: number; forgotten: number; superseded: number }
  reason?: string
}

/** 默认给多少条：一屏能翻完，又不至于把几百条一次塞给手机。 */
export const MEMORY_PAGE = 100

/**
 * 把账本合成一栏。
 *
 * `load` 读全部条目；读不出来就抛 —— 这里记成 `unavailable`，
 * 绝不改成「还没有记忆」。一条认不出来的只丢那一条，不让整栏报错。
 */
export async function memoryView(load: (() => Promise<readonly unknown[]>) | (() => readonly unknown[]) | readonly unknown[],
  options: { bot?: string; limit?: number } = {}): Promise<MemoryView> {
  let records: readonly unknown[]
  try {
    // 三种都收：`load` 允许同步、异步，也允许直接给一份数组（测试与「先读到再合成」都省一层壳）。
    records = typeof load === 'function' ? await load() : await load
  } catch {
    return { items: [], state: 'unavailable', counts: { active: 0, forgotten: 0, superseded: 0 }, reason: '记忆账本读不出来' }
  }
  const items: MemoryItem[] = []
  const counts = { active: 0, forgotten: 0, superseded: 0 }
  for (const record of Array.isArray(records) ? records : []) {
    const item = memoryItemOf(record)
    if (!item) continue
    // 数的是整本账，不是这一页：翻页时数字跳来跳去比不显示更糟。
    if (item.state === 'active') counts.active += 1
    else if (item.state === 'forgotten') counts.forgotten += 1
    else counts.superseded += 1
    if (options.bot && item.bot_id !== options.bot) continue
    items.push(item)
  }
  // 还在用的排前面，同一档按最近改动。
  items.sort((left, right) => Number(right.state === 'active') - Number(left.state === 'active')
    || right.updated - left.updated || left.name.localeCompare(right.name))
  const kept = items.slice(0, options.limit ?? MEMORY_PAGE)
  if (kept.length > 0) return { items: kept, state: 'live', counts }
  return { items: [], state: 'empty', counts, reason: options.bot ? '这位还没有记下什么' : '账本里还没有记忆' }
}

/** 一行认不出来（没名字、没正文）就跳过，不拿半个字段凑一行。 */
export function memoryItemOf(record: unknown): MemoryItem | undefined {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return undefined
  const value = record as Record<string, unknown>
  const name = typeof value.name === 'string' ? value.name.trim() : ''
  const body = typeof value.body === 'string' ? value.body : ''
  if (!name || !body.trim()) return undefined
  const state = value.state === 'forgotten' || value.state === 'superseded' ? value.state : 'active'
  const type = value.type === 'user' || value.type === 'feedback' || value.type === 'reference' ? value.type : 'project'
  const at = (input: unknown): number => typeof input === 'number' && Number.isFinite(input) && input > 0 ? input : 0
  const source = value.source && typeof value.source === 'object' && !Array.isArray(value.source)
    ? value.source as MemoryEntry['source'] : undefined
  return {
    name,
    bot_id: typeof value.bot_id === 'string' ? value.bot_id : '',
    description: typeof value.description === 'string' ? value.description : '',
    body,
    type,
    importance: typeof value.importance === 'number' ? value.importance : 4,
    state,
    created: at(value.created),
    updated: at(value.updated),
    ...(typeof value.origin === 'string' && value.origin ? { origin: value.origin } : {}),
    ...(source ? { source } : {}),
    to_hub: value.toHub === true,
  }
}
