/**
 * 「常规任务」：一张定时要做的事的小账本。
 *
 * 这一栏以前是明确的空态（后端没有这个概念）。这一份是最小可用的一版：
 * 一条任务 = 标题 + 周期 + 负责的 Bot + 开关 + 上次跑 / 下次跑的时间。
 *
 * 有两点必须说清楚，它们决定了这一栏显示成什么样：
 *
 * 1. **这是账本，不是执行器。** 后端还没有调度器，到点不会有人替你跑。
 *    所以 `next_run` 是**按周期算出来的**一个时间，不是「已经排好的作业」；
 *    过了点就如实标成逾期（`overdue`），不往前推成「下一轮」—— 那是替队伍许一个它做不到的承诺。
 * 2. **没跑过就是没跑过。** `last_run` 只在账本里真记过一次执行时才有；
 *    缺了就不给这个字段，客户端不写「从未」以外的任何日期。
 *
 * 与 outputs.ts 同形：纯函数，不碰网络、不碰磁盘；读不到由调用方记成 `unavailable`。
 */

/** 认得三种周期。将来要支持「每 N 分钟」之类的写法，是新增一个取值，不改 items / state 的形状。 */
export type RoutineCycle = 'hourly' | 'daily' | 'weekly'

/** 一个周期是多少毫秒。只有这三种，不猜别的写法。 */
const CYCLE_MS: Record<RoutineCycle, number> = {
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
}

/** 账本里存的那一条（KV `routines:task:<id>`）。字段都是主人自己写的，不包含任何推断值。 */
export interface RoutineRecord {
  id: string
  title: string
  cycle: RoutineCycle
  /** 负责的 Bot；账本允许不指定（谁有空谁接），所以是可选。 */
  bot_id?: string
  enabled: boolean
  /** 建这条账的时间，算下一次时没有 `last_run` 的参照。 */
  created_at: string
  /** 账本里记过的最近一次执行；没记过就没有 —— 不补假日期。 */
  last_run?: string
}

/** 下发给客户端的一条：账本字段 + 由周期推出来的 `next_run` 与 `overdue`。 */
export interface RoutineItem extends RoutineRecord {
  /** 按周期算出来的下一次；参照 `last_run`（没跑过用 `created_at`），不推进、不滚动。 */
  next_run: string
  /** 算出来的时间已经过了。后端没有调度器，所以这只表示「该跑了，但没人跑」。 */
  overdue: boolean
}

/**
 * `live` 有账可列；`empty` 读得到、一条都没有；`unavailable` 账本读不出来。
 * 三者的区别和产出那一栏一样：把「读不出」写成「没有」，是替队伍编一句话。
 */
export type RoutinesState = 'live' | 'empty' | 'unavailable'

export interface RoutinesView {
  items: RoutineItem[]
  state: RoutinesState
  /** 开着的几条、关掉的几条。空态时是 0 / 0，不是缺字段。 */
  counts: { enabled: number; paused: number }
  /** `state` 不是 `live` 时说清楚为什么。 */
  reason?: string
  /** 这一栏现在能不能真的按点到点跑。后端还没有调度器，所以恒为 `none`。 */
  runner: 'none'
}

const MAX_TITLE_CHARS = 100
const MAX_ITEMS = 100

/** 周期写法的解析：只认这三个词，别的（「每5分钟」「@daily」）不猜。 */
export function parseCycle(value: unknown): RoutineCycle | undefined {
  return value === 'hourly' || value === 'daily' || value === 'weekly' ? value : undefined
}

/** 一个时间戳读得懂就给出毫秒数；读不懂返回 undefined（不能拿它算下一次）。 */
function moment(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value) return undefined
  const at = Date.parse(value)
  return Number.isNaN(at) ? undefined : at
}

/**
 * 一条账本记录变成界面上那一行。
 *
 * `now` 由调用方给（测试里要能固定时间），缺省就是此刻。
 * 记录本身认不出来（没 id、没标题、周期不认识）时返回 undefined —— 跳过这一条，
 * 不拿半个字段去凑一行。
 */
export function routineItemOf(record: unknown, now = Date.now()): RoutineItem | undefined {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return undefined
  const value = record as Record<string, unknown>
  const id = typeof value.id === 'string' ? value.id.trim() : ''
  const title = typeof value.title === 'string' ? value.title.trim() : ''
  const cycle = parseCycle(value.cycle)
  if (!id || !title || !cycle) return undefined
  const created = moment(value.created_at)
  const ran = moment(value.last_run)
  // 参照点：真跑过就用那次，没跑过就用建账时间，都没有才用此刻。
  // 都不是「上次跑」，只是「按周期从哪一刻起算」。
  const anchor = ran ?? created ?? now
  const next = anchor + CYCLE_MS[cycle]
  const botId = typeof value.bot_id === 'string' ? value.bot_id.trim() : ''
  return {
    id,
    title: title.length > MAX_TITLE_CHARS ? title.slice(0, MAX_TITLE_CHARS) : title,
    cycle,
    ...(botId ? { bot_id: botId } : {}),
    enabled: value.enabled !== false,
    created_at: new Date(created ?? now).toISOString(),
    // 读不懂的 last_run 当作没有：写一个 Invalid Date 上去比缺字段更糟。
    ...(ran === undefined ? {} : { last_run: new Date(ran).toISOString() }),
    next_run: new Date(next).toISOString(),
    overdue: next <= now,
  }
}

/** 数一数开着的、关掉的有几条。 */
export function countRoutines(items: readonly RoutineItem[]): { enabled: number; paused: number } {
  return items.reduce((counts, item) => {
    if (item.enabled) counts.enabled += 1
    else counts.paused += 1
    return counts
  }, { enabled: 0, paused: 0 })
}

/**
 * 把账本合成一栏。
 *
 * `load` 读账本里所有记录；读不出来就抛 —— 这里记成 `unavailable`，
 * 绝不改成「还没有常规任务」。一条认不出来的记录只丢那一条，不让整栏报错。
 */
export async function routinesView(load: () => Promise<readonly unknown[]> | readonly unknown[], now = Date.now()): Promise<RoutinesView> {
  let records: readonly unknown[]
  try {
    records = await load()
  } catch {
    // 读不到与「没有」是两件事：账本存在但打不开，只能说读不出来。
    return { items: [], state: 'unavailable', counts: { enabled: 0, paused: 0 }, runner: 'none',
      reason: '常规任务的账本读不出来' }
  }
  const items: RoutineItem[] = []
  for (const record of Array.isArray(records) ? records : []) {
    const item = routineItemOf(record, now)
    if (item) items.push(item)
  }
  // 开着的排在前面；同一档里按「下一次」先后；关掉的排最后，免得挡住还活着的那几条。
  items.sort((left, right) => Number(right.enabled) - Number(left.enabled)
    || left.next_run.localeCompare(right.next_run) || left.id.localeCompare(right.id))
  const kept = items.slice(0, MAX_ITEMS)
  const counts = countRoutines(kept)
  if (kept.length > 0) return { items: kept, state: 'live', counts, runner: 'none' }
  return { items: [], state: 'empty', counts, runner: 'none', reason: '账本里还没有常规任务' }
}
