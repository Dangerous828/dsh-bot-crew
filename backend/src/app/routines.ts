/**
 * 「常规任务」：一张定时要做的事的小账本。
 *
 * 这一栏以前是明确的空态（后端没有这个概念）。这一份是最小可用的一版：
 * 一条任务 = 标题 + 周期 + 负责的 Bot + 开关 + 上次跑 / 下次跑的时间。
 *
 * 有两点必须说清楚，它们决定了这一栏显示成什么样：
 *
 * 1. **这一份只算账，不跑。** 到点真派单的是 `routine-runner.ts` 与运行时里那台调度器；
 *    这里负责的是「下一次是什么时候」，它按周期算出来，不是拍下来的排程时间。
 *    过了点就如实标成逾期（`overdue`），不往前推成「下一轮」—— 没真跑过就不该装作跑过。
 *    `runner` 字段说的是**这台后端现在有没有调度器**：有就是 `live`，没有才是 `none`。
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

/** 账本里存的那一条（KV 的 `routines` 族，前缀在 `kv.ts` 里）。字段都是主人自己写的，不包含任何推断值。 */
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
  /**
   * 这一栏现在能不能按点真跑。
   * - `live`：调度器在跑，到点会真的派单；
   * - `none`：这台后端没有调度器（宿主没接，或老版本），界面只该把它当账本看。
   */
  runner: 'live' | 'none'
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

/** 一条新任务的 id：`rt-` 加一段十六进制。客户端自造的 id 一律不认，防止覆写别的键。 */
export function newRoutineId(): string {
  // 不引 node:crypto 到纯函数模块里：这里只要够长的随机串，collision 概率可忽略。
  return `rt-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`
}

/** 写侧能改的字段：标题、周期、负责的 Bot、开关。id 与 last_run 不由客户端写。 */
export interface RoutineDraft {
  title: string
  /** 写侧传进来的原始周期串：build/edit 内部用 parseCycle 才认，非法即拒（严格只认三个词）。 */
  cycle: string
  bot_id?: string
  enabled?: boolean
}

/** 一次写入的结果：`ok` 加落库的那条，或一句人话的原因。 */
export type RoutineWrite =
  | { ok: true; record: RoutineRecord }
  | { ok: false; reason: string }

/**
 * 新建一条：校验标题、周期、Bot（位掩码），造出完整记录。
 *
 * 只做校验与造记录，不碰存储 —— 落 KV 由运行时那层做（与 `routinesView` 读侧对称）。
 * id 由调用方给（`id`），这样运行时能用同一套 `newRoutineId` 生成，测试也能固定。
 */
export function buildRoutine(draft: Partial<RoutineDraft>, id: string, now = Date.now()): RoutineWrite {
  const title = typeof draft.title === 'string' ? draft.title.trim() : ''
  if (!title) return { ok: false, reason: 'title is required' }
  if (title.length > MAX_TITLE_CHARS) return { ok: false, reason: `title is at most ${MAX_TITLE_CHARS} characters` }
  const cycle = parseCycle(draft.cycle)
  if (!cycle) return { ok: false, reason: 'cycle must be hourly, daily or weekly' }
  const botId = typeof draft.bot_id === 'string' ? draft.bot_id.trim() : ''
  if (botId && !/^[a-z0-9_-]+$/.test(botId)) return { ok: false, reason: 'bot_id must be lowercase letters, digits, _ or -' }
  const record: RoutineRecord = {
    id,
    title,
    cycle,
    ...(botId ? { bot_id: botId } : {}),
    enabled: draft.enabled !== false,
    created_at: new Date(now).toISOString(),
  }
  return { ok: true, record }
}

/**
 * 改一条：在既有记录上覆盖允许改的字段。`created_at` 与 `last_run` 保留 —— 改标题不该把
 * 「上次跑过」这件事抹掉，也不该把周期从此刻重新起算。
 */
export function editRoutine(current: RoutineRecord, draft: Partial<RoutineDraft>): RoutineWrite {
  const title = draft.title === undefined ? current.title : (typeof draft.title === 'string' ? draft.title.trim() : '')
  if (!title) return { ok: false, reason: 'title must not be empty' }
  if (title.length > MAX_TITLE_CHARS) return { ok: false, reason: `title is at most ${MAX_TITLE_CHARS} characters` }
  const cycle = draft.cycle === undefined ? current.cycle : parseCycle(draft.cycle)
  if (!cycle) return { ok: false, reason: 'cycle must be hourly, daily or weekly' }
  const botId = draft.bot_id === undefined ? (current.bot_id ?? '') : (typeof draft.bot_id === 'string' ? draft.bot_id.trim() : '')
  if (botId && !/^[a-z0-9_-]+$/.test(botId)) return { ok: false, reason: 'bot_id must be lowercase letters, digits, _ or -' }
  const enabled = draft.enabled === undefined ? current.enabled : draft.enabled !== false
  const { bot_id: _drop, ...rest } = current
  const record: RoutineRecord = {
    ...rest,
    title,
    cycle,
    ...(botId ? { bot_id: botId } : {}),
    enabled,
  }
  return { ok: true, record }
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
export async function routinesView(load: (() => Promise<readonly unknown[]>) | (() => readonly unknown[]) | readonly unknown[],
  now = Date.now(), runner: RoutinesView['runner'] = 'none'): Promise<RoutinesView> {
  let records: readonly unknown[]
  try {
    // 与记忆同一套调用约定：同步、异步、直接给数组都收。
    records = typeof load === 'function' ? await load() : await load
  } catch {
    // 读不到与「没有」是两件事：账本存在但打不开，只能说读不出来。
    return { items: [], state: 'unavailable', counts: { enabled: 0, paused: 0 }, runner,
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
  if (kept.length > 0) return { items: kept, state: 'live', counts, runner }
  return { items: [], state: 'empty', counts, runner, reason: '账本里还没有常规任务' }
}
