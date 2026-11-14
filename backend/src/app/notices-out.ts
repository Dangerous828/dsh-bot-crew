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
   * `mail` / `calendar` 是 issue #23 的两个监听源；`morning` 是早报。
   * 分成不同的 kind 而不是都叫 `daily`：人静音「日报」时不该顺手把「有人直接找我」也静掉。
   */
  kind: 'followup' | 'routine' | 'report' | 'daily' | 'morning' | 'mail' | 'calendar' | 'approval'
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
  const lines: string[] = []
  const night: string[] = []
  if (facts.overnight.finished > 0) night.push(`办完 ${facts.overnight.finished} 件`)
  if (facts.overnight.failed > 0) night.push(`失败 ${facts.overnight.failed} 件`)
  if (night.length > 0) lines.push(`昨夜 ${night.join(' · ')}`)
  if (facts.events.length > 0) {
    lines.push(`今日 ${facts.events.map(event => `${event.at} ${event.title}`).join('、')}`)
  }
  if (items.length > 0) {
    const shown = items.slice(0, PENDING_LIMIT).map(item => item.text)
    const rest = items.length - shown.length
    lines.push(`待处理 ${shown.join('；')}${rest > 0 ? ` · 还有 ${rest} 件` : ''}`)
  }
  if (lines.length === 0) return undefined
  return { title: `${facts.day} 早报`, body: lines.join('\n'), kind: 'morning', spoken }
}
