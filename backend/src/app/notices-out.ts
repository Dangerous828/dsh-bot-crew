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
  kind: 'followup' | 'routine' | 'report' | 'daily' | 'approval'
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
