/**
 * 队伍对外的「有事要说」：跟进、常规任务、日报都从这里出去。
 *
 * 与 `push.ts` 的区别：那一个是**投递层**（怎么送到手机上），这一份是**内容层**
 * （该不该说、说什么、什么时候说）。真正的消息生产者在运行时里调这几个函数，
 * 于是「说一句话」这件事只有一种写法，不会三处各写一套。
 */
import type { PushMessage } from './push.ts'

/** 一句话的抬头：谁在说、说的什么性质。手机通知横幅上第一眼看到的就是它。 */
export interface Notice {
  title: string
  body: string
  /**
   * `mail` / `calendar` 是 issue #23 的两个监听源；`morning` 是早报；`internal` 是客户端内部消息的
   * 设备横幅（server→client reply 的通知面，非会话面 replies——聊天里看到那条回复走 replies 表）。
   * 分成不同的 kind 而不是都叫 `daily`：人静音「日报」时不该顺手把「有人直接找我」也静掉。
   */
  kind: 'followup' | 'routine' | 'report' | 'daily' | 'morning' | 'mail' | 'calendar' | 'approval' | 'internal'
}

/** 一条推送要发给谁：设备表里的每一台，但跳过主人明确静音的那些。 */
export interface PushRecipient {
  deviceId: string
  /** 这台设备静音了哪几类；空表示全收。 */
  muted?: readonly Notice['kind'][]
}

/** 这台设备要不要收这一类。 */
export function wants(recipient: PushRecipient, kind: Notice['kind']): boolean {
  return !(recipient.muted ?? []).includes(kind)
}

/**
 * 把一条 notice 铺成每台设备各一条 PushMessage。
 *
 * 逐台生成而不是「一条广播」：每台设备静音的类别可能不同，投递层也要按设备判在线。
 */
export function pushFor(notice: Notice, recipients: readonly PushRecipient[], at = new Date()): PushMessage[] {
  return recipients.filter(recipient => wants(recipient, notice.kind)).map(recipient => ({
    deviceId: recipient.deviceId,
    title: notice.title,
    body: notice.body,
    kind: notice.kind,
    at: at.toISOString(),
  }))
}

/**
 * 大哥的日报。
 *
 * 「日报」这词容易写成一封套话信。这里只写**今天真发生过的数**：
 * 办完几张、卡住几张、派了几次常规任务、主人要做的事还剩几件。
 * 数都是 0 的那一段不写 —— 一行「今天 0 张」不提供任何信息，只会让人以为坏了。
 */
export interface DailyFacts {
  day: string
  finished: number
  failed: number
  waiting: number
  routines: number
  /** 最要紧的一两件事，直接说事，不带编号。 */
  highlights?: readonly string[]
}

/**
 * 日报正文。全是 0 时返回 `undefined` —— 那说明今天什么也没发生，
 * 这时候发一条「今天什么也没发生」是在占人时间。
 */
export function dailyNotice(facts: DailyFacts): Notice | undefined {
  const parts: string[] = []
  if (facts.finished > 0) parts.push(`办完 ${facts.finished} 件`)
  if (facts.failed > 0) parts.push(`失败 ${facts.failed} 件`)
  if (facts.waiting > 0) parts.push(`${facts.waiting} 件等你`)
  if (facts.routines > 0) parts.push(`到点派了 ${facts.routines} 次`)
  if (parts.length === 0 && !(facts.highlights ?? []).length) return undefined
  const lines: string[] = []
  if (parts.length > 0) lines.push(parts.join(' · '))
  for (const highlight of facts.highlights ?? []) lines.push(highlight)
  return { title: `${facts.day} 的日报`, body: lines.join('\n'), kind: 'daily' }
}

/** 日报该在什么时候说：晚上九点。太早当天的活还没完，太晚吵人。 */
export const DAILY_HOUR = 21

/** 今天是不是到了该说日报的时候（本地时间，只看小时）。 */
export function dailyDue(now = new Date()): boolean {
  return now.getHours() >= DAILY_HOUR
}

/**
 * 早报该在什么时候说：早上八点（issue #23 第 3 项）。
 *
 * 两份报告各占一段，互不越界：早报说「昨夜到今早」，日报说「今天一整天」。
 * 早报的上界是 `DAILY_HOUR` —— 过了日报的点就闭嘴，否则同一天晚上两份各说一遍，
 * 而且说的还是同一批东西。
 */
export const MORNING_HOUR = 8

/** 今天是不是在早报的窗口里（本地时间，只看小时）。 */
export function morningDue(now = new Date()): boolean {
  const hour = now.getHours()
  return hour >= MORNING_HOUR && hour < DAILY_HOUR
}

/**
 * 本地日期 `YYYY-MM-DD`。
 *
 * 不能用 `toISOString().slice(0, 10)`：那是 UTC 日。北京早上八点是前一天 16:00Z，
 * 按 UTC 取日会把早报算到昨天，于是「今天说过没有」这笔账天天错一天。
 */
export function localDay(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** 抬头上的日子：`11 月 14 日`。与日报同一个写法，人扫的位置固定。 */
export function dayLabel(now = new Date()): string {
  return `${now.getMonth() + 1} 月 ${now.getDate()} 日`
}

/** 本地今天零点。 */
export function startOfLocalDay(now = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate())
}

/**
 * 「昨夜」这个说法现在由运行时的水位线（`KV.notices.reported`）定义，不由这里现算。
 *
 * 这里曾经有一个 `overnightStart(now)`：把下界算成「昨天 21:00」。那个公式假设「昨晚日报跑过」，
 * 而进程整夜不在线时它没跑 —— 昨天 21:00–24:00 结束的票于是两份报告都不数（早报没跑、
 * 日报从今天零点起算）。审计建议的 `max(今天零点, 昨晚 21 点)` 只是把这个洞缩小，没补上。
 * 真正的下界只能是**上一次报表真跑到的时刻**，那是个持久化的事实，不是能现算的公式。
 */

/** 一个时刻的本地钟点 `09:05`。日程正文用它，不写 UTC 时刻。 */
export function clockOf(iso: string): string {
  const at = new Date(iso)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`
}

/**
 * 报告里那段统计该怎么称呼：`今日` / `自 11 月 12 日 08:00 起` / `上次汇报以来`。
 *
 * **不能一律写「昨夜」**。窗口下界是持久化的水位线（`KV.notices.reported`），进程停机几天后
 * 第一次报表会把那几天的活一起统计进来；这时候说「昨夜办完 12 件」是在报一个假的时间范围 ——
 * 数是真的，但人按「昨夜」去理解就错了。
 *
 * 三种情形：
 * - 窗口从今天之内起算（首次启动从今天零点）→ `今日`；
 * - 窗口起于更早 → 如实写出那一刻 `自 M 月 D 日 HH:mm 起`；
 * - 没有水位线可用 → `上次汇报以来`（不知道就别说具体时刻）。
 *
 * @param windowStart - 窗口下界的 ISO 时刻；缺省表示没有水位线。
 * @param day - 这份报告抬头上的日子（`dayLabel` 的产物），用来判断窗口是否落在同一天。
 */
export function windowLabel(windowStart: string | undefined, day: string): string {
  if (windowStart === undefined) return '上次汇报以来'
  const start = new Date(windowStart)
  if (Number.isNaN(start.getTime())) return '上次汇报以来'
  return dayLabel(start) === day ? '今日' : `自 ${dayLabel(start)} ${clockOf(windowStart)} 起`
}

/** 一件「等着人处理」的事。`key` 是跨两份报告的去重键。 */
export interface PendingItem {
  key: string
  text: string
}

/** 今日日程的一条。`at` 是给人看的时刻（`09:30` 或 `全天`），不在这一层算时区。 */
export interface MorningEvent {
  at: string
  title: string
  allDay?: boolean
}

/**
 * 早报的三段口径（issue #23 第 3 项要求开工前定清）：
 *
 * 1. **昨夜动态**：昨天日报之后到今早之间办完 / 失败的件数。日报说的是「今天一整天」，
 *    早报说的是「你睡着时发生了什么」—— 同一件事不会两份都说。
 * 2. **今日日程**：今天要开的会，按时间排。日程只在早报里出现，实时提醒那条路说的是
 *    「快到了 / 改了 / 取消了」，两者不是同一句话。
 * 3. **待处理**：等人回答的、等账号的、需要人点一下的。这一段的每一条都带 `key`，
 *    与日报共用一本当天账（`onceToday`）—— 同一条信息当天只出现一次。
 */
export interface MorningFacts {
  day: string
  overnight: { finished: number; failed: number }
  events: readonly MorningEvent[]
  pending: readonly PendingItem[]
  /**
   * 这段统计的窗口下界（ISO 时刻）。**不传就写「上次汇报以来」**，传了就按它算
   * `今日` / `自 M 月 D 日 HH:mm 起`（见 `windowLabel`）—— 不能一律说「昨夜」：
   * 停机几天后第一次报表会把那几天的活一起算进来，那时说「昨夜」是在报假的时间范围。
   */
  windowStart?: string
  /**
   * 日历这一栏读不出来时的一句原因。**与「今天没有会」是两件事**：`events: []` 且没有这句
   * 才是「今天真没会」；有这句时正文如实说读不到（设计系统 §六，宁可空着也不造假）。
   */
  calendarNote?: string
  /** 今天已经说过的键（两份报告共用的那本账）。 */
  spoken?: readonly string[]
}

/**
 * 当天只说一次的账本：给一批候选，剔掉今天已经说过的，返回留下来的与新账本。
 *
 * 为什么放在这一层而不是各报告各记一本：晨报与日报的候选集**本来就有交集**
 * （同一张等人的票会同时出现在两边的「待处理」里）。各记一本的结果是同一条信息
 * 一天出现两次 —— 这正是 issue 里「与日报不重复轰炸」要挡的那件事。
 */
export function onceToday(items: readonly PendingItem[], spoken: readonly string[]): { items: PendingItem[]; spoken: string[] } {
  const said = new Set(spoken)
  const kept: PendingItem[] = []
  for (const item of items) {
    // 同一批里重复的键也只留第一条：候选集来自多个来源，撞键是常事。
    if (said.has(item.key)) continue
    said.add(item.key)
    kept.push(item)
  }
  return { items: kept, spoken: [...said] }
}

/** 待处理一段最多列几条。再多就是一面墙，人只会整条划掉。 */
const PENDING_LIMIT = 5

/**
 * 早报正文。三段全空时返回 `undefined` —— 与日报同一条规矩：
 * 一条「今天没什么事」只是在占人时间。
 */
export function morningNotice(facts: MorningFacts): (Notice & { spoken: string[] }) | undefined {
  const { items, spoken } = onceToday(facts.pending, facts.spoken ?? [])
  const night: string[] = []
  if (facts.overnight.finished > 0) night.push(`办完 ${facts.overnight.finished} 件`)
  if (facts.overnight.failed > 0) night.push(`失败 ${facts.overnight.failed} 件`)
  const pendingLine = items.length > 0
    ? `待处理 ${items.slice(0, PENDING_LIMIT).map(item => item.text).join('；')}${
      items.length > PENDING_LIMIT ? ` · 还有 ${items.length - PENDING_LIMIT} 件` : ''}`
    : undefined
  // 「日历读不到」这件事**本身不值得推一条**：每天早上一句「还没接入日历」是纯噪音，
  // 人两天就会把早报静音。它只在早报本来就要说点别的时，作为那一栏的实话出现 ——
  // 空着与读不到是两件事，但那说的是别冒充「今天没会」，不是要单独播报一次读不到。
  if (night.length === 0 && facts.events.length === 0 && pendingLine === undefined) return undefined
  const today = facts.events.length > 0
    ? `今日 ${facts.events.map(event => `${event.at} ${event.title}`).join('、')}`
    : facts.calendarNote !== undefined ? `今日日程读不到（${facts.calendarNote}）` : undefined
  // 抬头按真实窗口起算，不一律写「昨夜」：停机几天后第一次报表会把那几天的活一起算进来，
  // 那时「昨夜办完 12 件」数是真的、时间范围是假的。
  const lines = [night.length > 0 ? `${windowLabel(facts.windowStart, facts.day)} ${night.join(' · ')}` : undefined,
    today, pendingLine].filter((line): line is string => line !== undefined)
  return { title: `${facts.day} 早报`, body: lines.join('\n'), kind: 'morning', spoken }
}
