/**
 * 「常规任务」的调度器：到点把事情真的派出去。
 *
 * 这一份补上 `routines.ts` 头注释里那句「这是账本，不是执行器」。现在它是执行器了，
 * 但只承担三件最小的事，多一件都不做：
 *
 * 1. **到点派单**：一条开着的任务过了 `next_run`，就把它当成主人此刻说的话派给负责的那位。
 *    走的是和手机发消息同一条路（`Engine.receive`），不是另一套派单器 ——
 *    另一套派单器意味着第二本账，两本账迟早对不上。
 * 2. **逾期只提醒**：队伍暂停、或者这条任务没指定 Bot 且队伍没人，就只记一次「逾期」，
 *    不动 `last_run`。不让「没跑成」看起来像「跑过了」。
 * 3. **结果写回账本**：派出去的那一刻记 `last_run`，这是「真跑过」的唯一证据；
 *    跑成什么样由派出去的那张票说，账本不替它转述。
 *
 * 不在这一份里做的：重试、并发上限、优先级。一张票没做完又来一次，是主人自己该看见的事。
 */

/** 调度器每轮看一次账本的间隔。一分钟够细，也不至于把 SQLite 读成热点。 */
export const TICK_MS = 60_000

/** 派单需要的每一条账。只给调度器看它用得上的字段。 */
export interface DueTask {
  id: string
  title: string
  cycle: 'hourly' | 'daily' | 'weekly'
  bot_id?: string
  enabled: boolean
  created_at: string
  last_run?: string
  /** 由 `routines.ts` 按周期算出来的下一次。 */
  next_run: string
  overdue: boolean
}

/** 一次 tick 的结果：派了哪几条、提醒了哪几条、为什么一条都没派。 */
export interface TickOutcome {
  /** 真的派出去的任务 id。 */
  dispatched: string[]
  /** 逾期但没派的（暂停 / 没有可派的 Bot），带一句原因。 */
  held: { id: string; reason: 'paused' | 'no_bot' | 'no_recipient' }[]
}

/**
 * 这一轮该派哪几条。
 *
 * 只认「开着 + 已到点」。顺序按 `next_run` 早的先派：逾期最久的先办，
 * 而不是按账本里的先后 —— 那顺序是主人写的，不是时间。
 */
export function dueOf(tasks: readonly DueTask[], now = Date.now()): DueTask[] {
  return tasks
    .filter(task => task.enabled && Date.parse(task.next_run) <= now)
    .sort((left, right) => left.next_run.localeCompare(right.next_run))
}

/**
 * 一条任务派出去时，交给队伍的那句话。
 *
 * 写成「主人定下的常规任务」，而不是假装是主人此刻在说话：队伍据 `human` 判准入，
 * 但读的人（和将来的审计）要能一眼看出这是到点自动派出来的。周期与上次跑一并写进去，
 * worker 据此知道「这是每天一次的那件」，而不是一次性的请求。
 */
export function routineMessage(task: Pick<DueTask, 'title' | 'cycle' | 'last_run'>, now = new Date()): string {
  const cycle = task.cycle === 'hourly' ? '每小时' : task.cycle === 'daily' ? '每天' : '每周'
  const since = task.last_run ? `上次跑是 ${task.last_run}` : '这是第一次跑'
  return `【常规任务】${task.title}\n\n周期：${cycle}。${since}。这次是 ${now.toISOString()} 到点自动派给你的。\n`
    + '按这条任务本来的要求做；做完照常汇报，结果会挂在这次派单的票上，账本里的「上次跑」已经记上了。'
}

/**
 * 派出去之后账本上要改的：`last_run` 记此刻，`next_run` 顺着周期往前推一格。
 *
 * 推到**真正比此刻晚**的第一格，而不是 `now + 周期`：停机两天之后再开机，daily 的任务
 * 该是「今天这一轮」，不该一口气补两天。补跑不是这一版的事，硬补只会让主人被同一件事刷屏。
 */
export function advance(task: Pick<DueTask, 'cycle' | 'created_at' | 'last_run'>, now = Date.now()):
  { last_run: string; next_run: string } {
  const step = task.cycle === 'hourly' ? 3_600_000 : task.cycle === 'daily' ? 86_400_000 : 7 * 86_400_000
  const anchor = Date.parse(task.last_run ?? task.created_at)
  let next = (Number.isNaN(anchor) ? now : anchor) + step
  if (Number.isNaN(next) || next <= now) {
    // 一共都没跑过、或者周期比停机时间短：从此刻起算，保证下一格在未来。
    const from = Number.isNaN(anchor) ? now : anchor
    const steps = Math.max(1, Math.ceil((now - from) / step))
    next = from + steps * step
    if (next <= now) next = now + step
  }
  return { last_run: new Date(now).toISOString(), next_run: new Date(next).toISOString() }
}
