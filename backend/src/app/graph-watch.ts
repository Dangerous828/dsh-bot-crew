/**
 * 收件箱 / 日历监听的运行时接线（issue #23 第 1、2 项）。
 *
 * 这两条监听**不是** `src/sources` 插件，而是运行时拍里的一条（和早报 / 日报同一个调度器）。
 * 原因有三，写在最前面免得后来人问「为什么不像 github/mobile 那样做成 Source」：
 *
 * 1. **分层约束**：`src/sources` 不许 import `src/app`（`docs/007-architecture.md`「What may
 *    import what」）。收件箱 / 日历的判定在 `src/app/inbox.ts`、`src/app/calendar.ts`，
 *    做个 Source 插件就得 import 它们，直接破规矩。把它们搬去 `src/core` 是一次大挪动，
 *    不该塞进「接一个只读端口」这件小事里。
 * 2. **投递面**：这两条要的是**设备通知**（`pushNotice`），不是往某个会话回消息（那才是
 *    Source 的 `notify`→Outbox 干的）。`pushNotice` 是运行时的私有方法，Source 够不着。
 * 3. **最小**：运行时本来就有每分钟一拍的调度器、有推送、有 KV。复用它，只加一个方法 +
 *    一个 tick 调用，比新开一个 Source 插件（要 `cordis.patch.yml`、`package.json` 导出、
 *    `tsdown` 入口、`SourceContext` 加 `push`）小得多，也不动 Source 体系。
 *
 * 这里只做「一轮 = 拉 → 判 → 推 → 落账 → 给出 health 一句话」。拉取用 `MicrosoftGraphPort`
 * （真 HTTP、只读、同一 token 支持 mail+calendar），凭据是 env/file 引用、值现读不落库。
 * 推送用注入的 `push(notice)`（运行时传 `pushNotice`），这样这一层完全可单测 ——
 * 不用真账号、不用真设备，也能验证「判定→推送→去重→游标」整条链路。
 *
 * 配置从**环境变量引用**读，不进 settings：`GRAPH_TOKEN` / `GRAPH_TOKEN_FILE` 决定 token，
 * `DSH_MAIL_USER` / `DSH_CALENDAR_USER` 决定读哪个邮箱/日历（缺省 `me`），
 * `DSH_MAIL_OFF` / `DSH_CALENDAR_OFF=1` 可单独关掉一条。这样接真实账号只需配环境变量，
 * 不新增 settings 块、不动面板表单 —— 那是「大范围新 settings 设计」，得先报 lead 定。
 */
import type { CalendarEvent, CalendarPort } from './calendar.ts'
import { scanCalendar, CALENDAR_UNAVAILABLE, type CalendarScan } from './calendar.ts'
import { scanInbox, type MailPort, type InboxScan } from './inbox.ts'
import { GraphError, MicrosoftGraphPort, isGraphAuthError, type GraphFetch, type GraphTokenRef } from './graph.ts'
import type { Notice } from './notices-out.ts'
import { KV, type Key } from '../kv.ts'

/** 监听容器的存储面：只用到这几个 KV 键的读与写。测试给内存实现，运行时给 `store`。 */
export interface GraphWatchStore {
  get<V>(key: Key<V>): V | undefined
  set<V>(key: Key<V>, value: V | undefined): void
}

/**
 * 一条监听的 health：`off`（没配凭据/被关掉）、`ready`（读过一轮）、`error`（读失败）。
 * `detail` 是给人看的一句话，与「今天真没信 / 真没会」分开说。
 */
export interface GraphWatchHealth { state: 'off' | 'ready' | 'error'; detail: string; at?: string }

/** 一条监听的配置：凭据引用 + 读哪个账号。都从环境变量来，不进 settings。 */
export interface GraphWatchConfig {
  token: GraphTokenRef
  user: string
}

export interface GraphWatchDeps {
  /** 推一条设备通知；返回有没有设备可送。运行时就传 `pushNotice` 包一层。 */
  push: (notice: Notice) => boolean | void
  /** KV：`KV.mail.since` / `.seen`、`KV.calendar.known` / `.told`。 */
  store: GraphWatchStore
  /** 端口工厂：给定配置构造 Graph 端口。测试注入一个返回假端口的实现。 */
  port: (config: GraphWatchConfig) => MicrosoftGraphPort
  /** 时间源，测试注入。 */
  now?: () => Date
}

/** 从环境变量读 mail / calendar 的两条配置；没配凭据的那条返回 undefined（＝跳过）。 */
export function configsFromEnv(env: NodeJS.ProcessEnv = process.env): { mail?: GraphWatchConfig; calendar?: GraphWatchConfig } {
  const token: GraphTokenRef = { tokenEnv: (env.GRAPH_TOKEN ? 'GRAPH_TOKEN' : ''), tokenFile: (env.GRAPH_TOKEN_FILE ?? '').trim() }
  // 只认「真的配了引用」的环境变量：GRAPH_TOKEN 存在（非空）或 GRAPH_TOKEN_FILE 非空。
  const hasToken = !!env.GRAPH_TOKEN?.trim() || !!token.tokenFile
  if (!hasToken) return {}
  const mailUser = (env.DSH_MAIL_USER ?? 'me').trim() || 'me'
  const calUser = (env.DSH_CALENDAR_USER ?? 'me').trim() || 'me'
  return {
    ...env.DSH_MAIL_OFF === '1' ? {} : { mail: { token, user: mailUser } },
    ...env.DSH_CALENDAR_OFF === '1' ? {} : { calendar: { token, user: calUser } },
  }
}

/** 一轮收件箱的结果，供 health 一句话。 */
export interface MailRound { health: GraphWatchHealth; scan?: InboxScan }
/** 一轮日历的结果。 */
export interface CalendarRound { health: GraphWatchHealth; scan?: CalendarScan }

/** 收件箱回看窗口：每次从「上次游标 - 这个」开始拉，重叠靠去重挡，晚到的信不漏。 */
export const MAIL_LOOKBACK_MS = 10 * 60_000

/**
 * 跑一轮收件箱：拉 → 判 → 推 → 落账。
 *
 * 顺序是「先推后记账」：`ctx.push` 之后才写 `seen` / `since`。如果推的那一步抛了，
 * 账本不前进，下一轮会重试同一批 —— 宁可重复一次，也不要把「以为推过了」记进库。
 */
export async function runMailRound(deps: GraphWatchDeps, config: GraphWatchConfig | undefined, signal?: AbortSignal): Promise<MailRound> {
  if (!config) return { health: { state: 'off', detail: '没配 Graph 凭据（GRAPH_TOKEN / GRAPH_TOKEN_FILE）' } }
  const now = (deps.now ?? (() => new Date()))()
  const since = deps.store.get<string>(KV.mail.since) ?? new Date(now.getTime() - MAIL_LOOKBACK_MS).toISOString()
  const seen = deps.store.get<string[]>(KV.mail.seen) ?? []
  let port: MicrosoftGraphPort
  try {
    port = deps.port(config)
  } catch (error) {
    return { health: { state: 'error', detail: `建 Graph 端口失败：${String(error)}` } }
  }
  let scan: InboxScan
  try {
    scan = await scanInbox(port.mail as MailPort, { since, seen, now })
  } catch (error) {
    return { health: mailError(error) }
  }
  if (signal?.aborted) return { health: { state: 'off', detail: '本轮被取消' } }
  try {
    for (const notice of scan.notices) deps.push(notice)
  } catch (error) {
    // 推送失败不记账：下一轮重试，不把「以为推过了」写进 seen。
    return { health: { state: 'error', detail: `推送失败：${String(error)}`, at: now.toISOString() } }
  }
  deps.store.set(KV.mail.seen, scan.seen)
  deps.store.set(KV.mail.since, scan.cursor)
  return { scan, health: { state: 'ready', at: now.toISOString(),
    detail: `本轮提醒 ${scan.notices.length} 条${scan.stale.length > 0 ? `，过窗 ${scan.stale.length} 封（留给早晨报告）` : ''}` } }
}

/** 跑一轮日历：拉 → 判（临期/变更/取消）→ 推 → 落两本账。 */
export async function runCalendarRound(deps: GraphWatchDeps, config: GraphWatchConfig | undefined, signal?: AbortSignal): Promise<CalendarRound> {
  if (!config) return { health: { state: 'off', detail: CALENDAR_UNAVAILABLE } }
  const now = (deps.now ?? (() => new Date()))()
  const known = deps.store.get<Record<string, string>>(KV.calendar.known) ?? {}
  const told = deps.store.get<Record<string, string[]>>(KV.calendar.told) ?? {}
  let port: MicrosoftGraphPort
  try {
    port = deps.port(config)
  } catch (error) {
    return { health: { state: 'error', detail: `建 Graph 端口失败：${String(error)}` } }
  }
  let scan: CalendarScan
  try {
    scan = await scanCalendar(port.calendar as CalendarPort, { now, known, told })
  } catch (error) {
    return { health: calendarError(error) }
  }
  if (signal?.aborted) return { health: { state: 'off', detail: '本轮被取消' } }
  try {
    for (const notice of scan.notices) deps.push(notice)
  } catch (error) {
    return { health: { state: 'error', detail: `推送失败：${String(error)}`, at: now.toISOString() } }
  }
  deps.store.set(KV.calendar.known, scan.known)
  deps.store.set(KV.calendar.told, scan.told)
  return { scan, health: { state: 'ready', at: now.toISOString(), detail: `本轮提醒 ${scan.notices.length} 条` } }
}

/** 收件箱读失败：被拒（401/403）与网络失败分开说，各自给出该动哪儿。 */
function mailError(error: unknown): GraphWatchHealth {
  if (isGraphAuthError(error)) {
    return { state: 'error', detail: `Graph 拒绝凭据（${(error as GraphError).status}）：检查 GRAPH_TOKEN 的 token 与 Mail.Read 权限` }
  }
  return { state: 'error', detail: `读收件箱失败：${String(error)}` }
}

/** 日历读失败。 */
function calendarError(error: unknown): GraphWatchHealth {
  if (isGraphAuthError(error)) {
    return { state: 'error', detail: `Graph 拒绝凭据（${(error as GraphError).status}）：检查 GRAPH_TOKEN 的 token 与 Calendars.Read 权限` }
  }
  return { state: 'error', detail: `读日历失败：${String(error)}` }
}

/**
 * 早报的「今日日程」：读今天剩余的日程，供 `runMorning` 的那一栏。
 *
 * 单独成一个函数而不是塞进 `runCalendarRound`：早报要的是「今天有什么会」的全景，
 * 实时提醒要的是「临期/变更」，两者的窗口与用途都不同。读不到返回 `undefined`，
 * 由早报正文说「今日日程读不到（原因）」—— 不冒充「今天没会」。
 */
export async function todayEvents(deps: GraphWatchDeps, config: GraphWatchConfig | undefined,
  dayStart: Date, dayEnd: Date, signal?: AbortSignal): Promise<{ events: CalendarEvent[]; note?: string } | undefined> {
  if (!config) return undefined
  let port: MicrosoftGraphPort
  try { port = deps.port(config) } catch { return undefined }
  try {
    const events = await port.fetchEvents(dayStart.toISOString(), dayEnd.toISOString(), signal)
    // 已结束 / 全天排序：全天在前，其余按开始时间。
    const sorted = [...events].sort((a, b) => (a.allDay === b.allDay ? a.startsAt.localeCompare(b.startsAt) : a.allDay ? -1 : 1))
    return { events: sorted as CalendarEvent[] }
  } catch {
    return undefined
  }
}

