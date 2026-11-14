/**
 * 日历的「要不要提醒」判定（issue #23 第 2 项）。
 *
 * 与 `inbox.ts` 同一个路子：纯判定，没有 IO，不认 OAuth、不认识 Google / iCloud / CalDAV。
 * 真实日历接进来时只需要有人实现 `CalendarPort.fetch()`（一次拉取一段窗口内的日程），
 * 「临期 / 变更 / 取消」的判断与去重都在这里。
 *
 * 日历与收件箱有一个本质差别：**日历的状态是「有人改了它」**，不是「来了一条新消息」。
 * 所以判定不能只看当前这一份快照，必须与上一轮记住的指纹比 —— 没有指纹就没有「变更」，
 * 也分不清「这场会取消了」和「我从没见过的会」。`scanCalendar` 因此要收 `known` 与 `told` 两本账。
 *
 * 另一条：同一场会一轮只说一句。取消 > 变更 > 临期，取最高的一条。
 * 三句叠起来人只会把通知划掉不看，等于三句都没说。
 */
import type { Notice } from './notices-out.ts'

/** 判定用的日程形状。字段按各家日历 API 的公共子集挑。 */
export interface CalendarEvent {
  id: string
  title: string
  /** 开始 / 结束时间，ISO 字符串。全天事件的结束时间是「次日零点」。 */
  startsAt: string
  endsAt: string
  /** 参与人邮箱。用来在正文里说「和谁开」，不参与过滤 —— 见下面的说明。 */
  attendees?: readonly string[]
  /** 全天事件：没有「马上开始」这一说。 */
  allDay?: boolean
  cancelled?: boolean
}

/**
 * 提前多久算「临近」。issue 举的例子就是十五分钟：够人放下手上的事走到会议室，
 * 又不至于早上就把一天的会全弹一遍。
 */
export const SOON_MS = 15 * 60_000

/** 提醒的类别。`null` 表示这一轮不说。 */
export type CalendarWhen = 'soon' | 'changed' | 'cancelled'

export interface CalendarVerdict {
  notify: boolean
  when: CalendarWhen | null
  reason: 'soon' | 'ongoing' | 'changed' | 'cancelled' | 'all-day' | 'past' | 'later' | 'unseen-cancel' | 'told'
  /** 这一类的去重键。`soon` / `cancelled` 是常量，`changed` 带新指纹 —— 再改一次是新事。 */
  key?: string
}

/** 一次观测：当前这份日程 + 上一轮记住的指纹 + 已经说过的类别。 */
export interface CalendarSighting {
  event: CalendarEvent
  /** 上一轮这场会的指纹；没有就是「这一轮第一次见到」。 */
  previousSignature?: string
  /** 这场会已经提醒过的类别键。 */
  told?: readonly string[]
}

/**
 * 日程指纹：只取「变了要告诉我」的那几样。
 *
 * 标题也算进去：改时间是改，改题目也是改 —— 人都已经按旧题目准备了。
 * 参与人不算：加一个旁听的不影响我要不要去。全天标记不算：那是全天事件自己的事，
 * 由 `all-day` 那条规则单独挡掉，不该冒充「变更」。
 */
export function eventSignature(event: Pick<CalendarEvent, 'title' | 'startsAt' | 'endsAt' | 'cancelled'>): string {
  return [event.title.trim(), event.startsAt, event.endsAt, event.cancelled ? 'cancelled' : 'live'].join('|')
}

/** 提醒正文里说「和谁」：人多了就只点一个名字，别把一串邮箱铺到通知横幅上。 */
function who(event: CalendarEvent): string {
  const names = (event.attendees ?? []).filter(Boolean)
  if (names.length === 0) return ''
  const local = (address: string) => address.replace(/<[^>]*>/, '').split('@')[0] ?? address
  return names.length === 1 ? `和 ${local(names[0] ?? '')}` : `和 ${local(names[0] ?? '')} 等 ${names.length} 人`
}

/** 时刻的短写法：`09:15`。跨天时补上日期，免得「明天九点」被读成「今天九点」。 */
function clock(iso: string, now: Date): string {
  const at = new Date(iso)
  const sameDay = at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate()
  const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  return sameDay ? time : `${at.getMonth() + 1} 月 ${at.getDate()} 日 ${time}`
}

/**
 * 一场会该不该提醒。
 *
 * 判定顺序：**全天 → 已结束 → 取消 → 变更 → 临期**。
 * 前两条是「这件事本身不该打扰人」，中间两条是「状态变了」，最后一条才是「时间到了」。
 */
export function judgeEvent(sighting: CalendarSighting, now = new Date()): CalendarVerdict {
  const { event, previousSignature, told = [] } = sighting
  const start = Date.parse(event.startsAt)
  const end = Date.parse(event.endsAt)
  const said = (key: string) => told.includes(key)

  // 全天事件没有「马上开始」这一说：提醒只会在早上八点准时烦人。
  if (event.allDay) return { notify: false, when: null, reason: 'all-day' }
  // 已经过去的会不必再说，哪怕它刚刚被改过。
  if (end <= now.getTime()) return { notify: false, when: null, reason: 'past' }

  if (event.cancelled) {
    // 取消是唯一一条「不知道也要说」的例外吗？不是 —— 我从没把这场会排进计划，
    // 告诉我也无从改计划，只是噪声。所以只说我认识的那几场。
    if (previousSignature === undefined) return { notify: false, when: null, reason: 'unseen-cancel' }
    if (said('cancelled')) return { notify: false, when: null, reason: 'told' }
    return { notify: true, when: 'cancelled', reason: 'cancelled', key: 'cancelled' }
  }

  const signature = eventSignature(event)
  if (previousSignature !== undefined && previousSignature !== signature) {
    // 「改了」与「又改了」是两件事：键带新指纹，第二次改动照样会说。
    const key = `changed:${signature}`
    if (said(key)) return { notify: false, when: null, reason: 'told' }
    return { notify: true, when: 'changed', reason: 'changed', key }
  }

  if (start - now.getTime() <= SOON_MS) {
    if (said('soon')) return { notify: false, when: null, reason: 'told' }
    // 已经开始但还没结束：迟到十分钟比「还有十五分钟」更值得说一句。
    return { notify: true, when: 'soon', reason: start <= now.getTime() ? 'ongoing' : 'soon', key: 'soon' }
  }
  return { notify: false, when: null, reason: 'later' }
}

/** 真实日历的接入点。实现它的人只需要一次「拉取窗口内的日程」——CalDAV、Google Calendar API、某个 MCP 都行。 */
export interface CalendarPort {
  fetch(from: string, to: string, signal?: AbortSignal): Promise<readonly CalendarEvent[]>
}

export interface CalendarState {
  now: Date
  /** 上一轮每场会的指纹，键是日程 id。 */
  known: Readonly<Record<string, string>>
  /** 每场会已经说过的类别键。 */
  told: Readonly<Record<string, readonly string[]>>
  /** 拉取窗口的长度：够覆盖今天与明天早上，又不至于把一整年的会都拉回来。 */
  horizonMs?: number
}

export interface CalendarScan {
  notices: Notice[]
  known: Record<string, string>
  told: Record<string, string[]>
}

/** 默认拉取窗口：未来两天。晨报要「今日日程」，实时提醒只需要眼前这一段。 */
const HORIZON_MS = 2 * 24 * 3600_000

/** 一条提醒的标题与正文。变更时把「从几点改到几点」说清，否则人还得自己点进去比对。 */
function eventNotice(sighting: CalendarSighting, verdict: CalendarVerdict, now: Date): Notice {
  const { event, previousSignature } = sighting
  const when = clock(event.startsAt, now)
  const people = who(event)
  const tail = people ? ` · ${people}` : ''
  if (verdict.when === 'cancelled') {
    // 标题在通知横幅上会被截断，所以正文再说一次「已取消」——这句话不能被截掉。
    return { title: `取消了：${event.title}`, body: `已取消 · 原定 ${when}${tail}`, kind: 'calendar' }
  }
  if (verdict.when === 'changed') {
    // 旧指纹里的开始时间是第二段，够说清「原来几点」；取不到就只说新时间。
    const was = previousSignature?.split('|')[1]
    const moved = was && was !== event.startsAt ? `（原 ${clock(was, now)}）` : ''
    return { title: `改了：${event.title}`, body: `${when}${moved}${tail}`, kind: 'calendar' }
  }
  return {
    title: verdict.reason === 'ongoing' ? `已经开始了：${event.title}` : `快到了：${event.title}`,
    body: `${when}${tail}`,
    kind: 'calendar',
  }
}

/**
 * 扫一遍日历窗口。判定、去重、指纹三件事在这里收口。
 *
 * `known` / `told` 只增不减是错的：会开完就该从账本里消失，否则一本账会跟着日历无限长。
 * 所以返回的账本只保留这一轮仍看得见的日程 —— 消失的会自然被清掉，重开同一 id 也算新会。
 */
export async function scanCalendar(port: CalendarPort, state: CalendarState): Promise<CalendarScan> {
  const { now } = state
  const horizon = state.horizonMs ?? HORIZON_MS
  const events = await port.fetch(now.toISOString(), new Date(now.getTime() + horizon).toISOString())
  const notices: Notice[] = []
  const known: Record<string, string> = {}
  const told: Record<string, string[]> = {}
  for (const event of events) {
    const previousSignature = state.known[event.id]
    const said = [...(state.told[event.id] ?? [])]
    const verdict = judgeEvent({ event, ...previousSignature === undefined ? {} : { previousSignature }, told: said }, now)
    known[event.id] = eventSignature(event)
    if (verdict.notify && verdict.key) {
      said.push(verdict.key)
      notices.push(eventNotice({ event, ...previousSignature === undefined ? {} : { previousSignature } }, verdict, now))
    }
    // 空账不进表：一场没说过话的会不该在账本里占一行，否则账本长度跟着日历涨。
    if (said.length > 0) told[event.id] = said
  }
  return { notices, known, told }
}
