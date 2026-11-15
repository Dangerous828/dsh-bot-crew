/**
 * 收件箱与日历的真实只读接入：**一个** Microsoft Graph 端口，同时实现
 * `MailPort`（`inbox.ts`）与 `CalendarPort`（`calendar.ts`）两个接口。
 *
 * 为什么选 Graph 而不是 IMAP + CalDAV 两套：
 *
 * 1. **一个 token 管两样**。`Mail.Read` + `Calendars.Read`（委托或应用权限）用同一个
 *    Bearer 就能读信与读会，不必维护两套凭据、两套授权、两套排障路径。
 * 2. **只读是权限层面的事**，不是「约定不调用写接口」。这份端口只发 GET，路径写死在
 *    `/messages` 与 `/calendarView`；发信（`/sendMail`）、改会（PATCH）、删信（DELETE）
 *    在这份代码里根本不存在一个入口。凭据给最小权限（`Mail.Read` / `Calendars.Read`）时，
 *    就算有人拿这份代码乱改，服务端也会因为没授权而拒绝写。
 * 3. **凭据只存引用**。设置里只放「去哪儿取」（环境变量名 / 0600 凭据文件路径），
 *    token 值在发请求的那一刻现读，**绝不落库、绝不进日志或错误消息** —— 与
 *    `src/memory/auth.ts` 同一个纪律，这一份自带一份等价实现，免得和中枢凭据耦合。
 *
 * 这份文件不认「哪个邮箱是谁的」：调用方在配置里给 `user`（缺省 `me`，即 token 本人的
 * 主邮箱 / 默认日历）。读个人目录、扫通讯录、翻凭据库这些事这里一概没有 —— 它只知道
 * 「拿这个引用读到的 token，按这个窗口 GET 一次」。
 *
 * 官方参考（Microsoft Learn，v1.0）：
 * - List messages：`GET /me/messages`、`GET /users/{id}/messages`
 *   https://learn.microsoft.com/en-us/graph/api/user-list-messages
 * - List calendarView：`GET /me/calendarView?startDateTime=&endDateTime=`、
 *   `GET /users/{id}/calendarView?...`
 *   https://learn.microsoft.com/en-us/graph/api/user-list-calendarview
 * - 权限：`Mail.Read`（读信）/ `Calendars.Read`（读会），委托与应用两型皆可。
 *   https://learn.microsoft.com/en-us/graph/permissions-reference
 */
import { readFileSync, statSync } from 'node:fs'
import type { CalendarEvent, CalendarPort } from './calendar.ts'
import type { MailMessage, MailPort } from './inbox.ts'

/** Graph 的国家云基址。缺省全球；21Vianet / GCC 等改这一个值即可。 */
export const DEFAULT_GRAPH_BASE = 'https://graph.microsoft.com/v1.0'

/**
 * 凭据引用：设置里只放这两项，不放假 token 值。
 *
 * - `tokenEnv`：进程环境变量名（如 `GRAPH_TOKEN`）。
 * - `tokenFile`：凭据文件绝对路径（应为 `0600`）。两者同时给时，文件按 `KEY=VALUE`
 *   环境文件解析 `tokenEnv` 那个键；只给文件时把整份内容当 token。
 *
 * 与 `memory/auth.ts` 的 `HubTokenRef` 形状一致但**独立**：两者指向不同的服务、不同的
 * token，混在一起会让「换中枢凭据」顺手换掉了 Graph 凭据而没人发现。
 */
export interface GraphTokenRef {
  tokenEnv?: string
  tokenFile?: string
}

export type GraphTokenSource = 'env' | 'file' | 'none'

export interface GraphTokenRead {
  /** 读到的 token；读不到就是空串（绝不返回半个值）。 */
  token: string
  source: GraphTokenSource
  /** 如实说明为什么有问题（文件不可读、键缺失、权限过宽、值不像 token）；**不含值**。 */
  problem?: string
}

/** 读进程环境；测试注入。 */
export type GraphEnvRead = (name: string) => string | undefined
/** 读凭据文件；测试注入。返回文本与权限位（`mode & 0o777`）。 */
export type GraphFileRead = (path: string) => { text: string; mode?: number }

export interface GraphTokenIo {
  env?: GraphEnvRead
  file?: GraphFileRead
}

const readEnv: GraphEnvRead = name => process.env[name]
const readFile: GraphFileRead = path => {
  const stat = statSync(path)
  return { text: readFileSync(path, 'utf8'), mode: stat.mode & 0o777 }
}

const MAX_TOKEN_BYTES = 64 * 1024
const MAX_TOKEN_CHARS = 8192

function clean(value: string): string {
  const trimmed = value.trim()
  const unquoted = /^(['"])(.*)\1$/s.exec(trimmed)
  return (unquoted?.[2] ?? trimmed).trim()
}

/** 从 `KEY=VALUE` 环境文件里取一个键（认 `export`、注释、成对引号；重复取第一条）。 */
export function envFileValue(text: string, key: string): string | undefined {
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match || match[1] !== key) continue
    return clean(match[2] ?? '')
  }
  return undefined
}

/**
 * 现读一次 Graph token。顺序：进程环境 → 凭据文件（与中枢凭据同一套取舍：
 * 环境不碰磁盘优先，文件优先会让人改了环境变量却没生效更难查）。
 *
 * 只回「现在能不能拿到 token、从哪儿来、有没有问题」，**不记录值**，也不把值放进
 * 任何返回的错误说明里。
 */
export function readGraphToken(ref: GraphTokenRef, io: GraphTokenIo = {}): GraphTokenRead {
  const env = io.env ?? readEnv
  const file = io.file ?? readFile
  const name = (ref.tokenEnv ?? '').trim()
  const path = (ref.tokenFile ?? '').trim()
  if (!name && !path) return { token: '', source: 'none' }

  if (name) {
    const value = clean(env(name) ?? '')
    if (value) return finish({ token: value, source: 'env' }, value)
  }
  if (!path) return { token: '', source: 'none', problem: `环境变量 ${name} 未设置或为空` }

  let text: string, mode: number | undefined
  try {
    ({ text, mode } = file(path))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'error'
    return { token: '', source: 'none', problem: `凭据文件读不出来（${path}）：${code}` }
  }
  if (text.length > MAX_TOKEN_BYTES) {
    return { token: '', source: 'none', problem: `凭据文件过大（${path}，>${MAX_TOKEN_BYTES} 字节），不当 token 用` }
  }
  const value = name ? envFileValue(text, name) : clean(text)
  if (value === undefined) return { token: '', source: 'none', problem: `凭据文件里没有 ${name} 这个键（${path}）` }
  if (!value) return { token: '', source: 'none', problem: `凭据文件里 ${name} 是空值（${path}）` }
  const read: GraphTokenRead = { token: value, source: 'file' }
  if (mode !== undefined && (mode & 0o077) !== 0) read.problem = `凭据文件权限过宽（${path}，${mode.toString(8)}）：建议 chmod 600`
  return finish(read, value)
}

function finish(read: GraphTokenRead, value: string): GraphTokenRead {
  if (value.length > MAX_TOKEN_CHARS) return { ...read, token: '', problem: `读到的值过长（${value.length} 字符），不像 token` }
  if (/\s/.test(value)) return { ...read, token: '', problem: '读到的值里含空白/换行，不像 token' }
  return read
}

/** 兜底脱敏：任何要落日志/错误消息的文本，先把 token 值替换掉。 */
export function redactToken(text: string, token: string): string {
  return token ? text.split(token).join('***') : text
}

/**
 * 一次 Graph GET 的运输层。默认是 `fetch`；测试注入一个本地假 server 的 fetch。
 * 调用方（端口）只认「给 URL + token，回 JSON」这一件事。
 */
export type GraphFetch = (url: string, init: { headers: Record<string, string>; redirect?: 'manual'; signal?: AbortSignal }) => Promise<{
  status: number
  ok: boolean
  headers?: { location?: string }
  json(): Promise<unknown>
  text(): Promise<string>
}>

/** Graph 调用失败：`status` 是 HTTP 码（网络不通为 undefined）。被拒（401/403）单独标出。 */
export class GraphError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'GraphError'
  }
}

/** 401/403 说明「地址对、token 不对/权限不够」，与网络不通是两回事，调用方据此分别报。 */
export function isGraphAuthError(error: unknown): boolean {
  return error instanceof GraphError && (error.status === 401 || error.status === 403)
}

export interface GraphPortOptions {
  /** 凭据引用（值现读，不在这里存）。 */
  token: GraphTokenRef
  /** `me`（token 本人）或具体 UPN / 用户 id。缺省 `me`。 */
  user?: string
  /** 基址，缺省 `DEFAULT_GRAPH_BASE`。 */
  base?: string
  /** 运输层，缺省全局 `fetch`。 */
  fetch?: GraphFetch
  /** 凭据读取的 IO 注入（测试用假环境/假文件）。 */
  io?: GraphTokenIo
  /** 单页条数上限（Graph `$top`，1..1000）；缺省 50，够一轮新信/近两天日程用。 */
  pageSize?: number
}

/**
 * 一次 Graph 拉取后「下一页」与「这一页」的结构。
 *
 * 分页没做完不吞：`fetch` 只取一页（`$top` 上限内），多余的靠调用方下一次 poll 的窗口重叠
 * 自然补上 —— 收件箱的判定与去重是幂等的，晚一轮看到同一封信也不会提醒两次（`mailDedupKey`）。
 * 日程的窗口由 `from`/`to` 定，一次 calendarView 就覆盖整个窗口，不分页。
 */
interface GraphPage {
  value?: unknown
  '@odata.nextLink'?: unknown
}

/** Graph 里 `emailAddress` 的公共形状。 */
interface GraphEmail { name?: unknown; address?: unknown }

/** 把 `{ name, address }` 拼成 `名字 <地址>`；只有地址就只给地址。 */
function addressOf(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return ''
  const email = (raw as { emailAddress?: GraphEmail }).emailAddress
  if (!email || typeof email !== 'object') return ''
  const address = typeof email.address === 'string' ? email.address.trim() : ''
  const name = typeof email.name === 'string' ? email.name.trim() : ''
  if (!address && !name) return ''
  return name && address ? `${name} <${address}>` : address || name
}

/** 收件人数组（to + cc）里的地址列表；`directTo` 另算（to 单独一遍）。 */
function addresses(list: unknown): string[] {
  if (!Array.isArray(list)) return []
  return list.map(item => {
    const email = (item as { emailAddress?: GraphEmail }).emailAddress
    return typeof email?.address === 'string' ? email.address.trim().toLowerCase() : ''
  }).filter(Boolean)
}

/**
 * Graph 的一封信 → `MailMessage`（`inbox.ts` 判定用的形状）。
 *
 * 判定要的字段里，Graph 给不了的（`replied`）留空：判定层对「没有这个字段」的处理是
 * 「不确定就不按已回处理」—— 宁可多提醒一条，也不要把没回的信当回过了。
 * `precedence` / `autoSubmitted` 这类 header 默认不在 `$top` 响应里（要 `$select`
 * 明文列 internetMessageHeaders，代价是把每封的 header 全拉回来），所以第一版**不拉 header**：
 * 邮件列表（`List-Id`）、自动回复这些噪声改由 `from` 的本地部分（`no-reply@`）与
 * `categories`（Promotions/Social/Forums）在判定层挡 —— 这两条已覆盖绝大多数噪声。
 */
export function mailOf(raw: unknown): MailMessage | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const item = raw as Record<string, unknown>
  const id = typeof item.internetMessageId === 'string' ? item.internetMessageId
    : typeof item.id === 'string' ? item.id : ''
  if (!id) return undefined
  const from = addressOf(item.from)
  const subject = typeof item.subject === 'string' ? item.subject : ''
  const receivedAt = typeof item.receivedDateTime === 'string' ? item.receivedDateTime : ''
  if (!receivedAt) return undefined
  const to = addresses(item.toRecipients)
  const cc = addresses(item.ccRecipients)
  const all = [...to, ...cc]
  const labels = Array.isArray(item.categories) ? item.categories.filter((c): c is string => typeof c === 'string') : undefined
  return {
    messageId: id,
    from,
    subject,
    receivedAt,
    to: all,
    // 「我是否在 To 里」由 Graph 的 toRecipients 直接给：有 to 就是直接收件人。
    directTo: to.length > 0,
    unread: item.isRead === false ? true : item.isRead === true ? false : undefined,
    ...labels && labels.length > 0 ? { labels } : {},
  }
}

/**
 * Graph 的一场会 → `CalendarEvent`（`calendar.ts` 判定用的形状）。
 *
 * 时刻统一转成 ISO：Graph 的 `start.dateTime` 不带时区后缀时会按 `start.timeZone` 解释，
 * 这里用 `Date.parse` + `toISOString` 归一到 UTC 瞬时 —— 判定层只比较瞬时先后，不关心
 * 原时区。全日事件把结束时间当作「次日零点」正是判定层预期的形状。
 */
export function eventOf(raw: unknown): CalendarEvent | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const item = raw as Record<string, unknown>
  const id = typeof item.id === 'string' ? item.id : ''
  const start = dateTimeOf(item.start)
  const end = dateTimeOf(item.end)
  if (!id || !start || !end) return undefined
  const attendees = Array.isArray(item.attendees)
    ? item.attendees.map(a => {
      const email = (a as { emailAddress?: GraphEmail })?.emailAddress
      return typeof email?.address === 'string' ? email.address.trim().toLowerCase() : ''
    }).filter(Boolean)
    : undefined
  const cancelled = item.isCancelled === true
  return {
    id,
    title: typeof item.subject === 'string' ? item.subject : '',
    startsAt: start,
    endsAt: end,
    ...attendees && attendees.length > 0 ? { attendees } : {},
    ...item.isAllDay === true ? { allDay: true } : {},
    ...cancelled ? { cancelled: true } : {},
  }
}

/** `{ dateTime, timeZone }` → ISO 瞬时；缺 dateTime 返回 undefined。无时区后缀按给定时区解释。 */
function dateTimeOf(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const dateTime = (raw as { dateTime?: unknown }).dateTime
  if (typeof dateTime !== 'string' || !dateTime) return undefined
  const timeZone = (raw as { timeZone?: unknown }).timeZone
  // Graph 常回 `2026-11-14T09:00:00.0000000`（无 Z、无偏移）。这种值的末尾 micosecond
  // 位数不固定，先截到毫秒；没有偏移就补 `Z` 按 UTC 解释（Graph 对 calendarView 默认回 UTC）。
  const normalized = normalizeGraphDateTime(dateTime, typeof timeZone === 'string' ? timeZone : undefined)
  return normalized
}

/**
 * 把 Graph 的 dateTime 字符串收成 `Date.parse` 认得的形状。
 *
 * Graph 会回 `2026-11-14T09:00:00.0000000`（7 位小数、无时区）：`Date.parse` 对这种
 * 末尾多位的写法在部分运行时返回 NaN。这里截到 3 位小数，缺偏移就补 `Z`。
 */
export function normalizeGraphDateTime(dateTime: string, _timeZone?: string): string | undefined {
  const trimmed = dateTime.trim()
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})?$/.exec(trimmed)
  if (!match) {
    const parsed = Date.parse(trimmed)
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined
  }
  const base = match[1] ?? ''
  const frac = (match[2] ?? '').padEnd(3, '0').slice(0, 3)
  const offset = match[3] ?? 'Z'
  const iso = `${base}.${frac}${offset}`
  const parsed = Date.parse(iso)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined
}

/**
 * Microsoft Graph 只读端口：同时是 `MailPort` 与 `CalendarPort`。
 *
 * 两件事：`fetch()` 读信（`MailPort`），`fetch()` 读会（`CalendarPort`）—— 名字撞了，
 * 所以这里用两个方法：`fetchMail` 与 `fetchEvents`，再各自适配成两个接口要求的
 * `fetch` 签名（用 `mail` / `calendar` 两个只读视图暴露给 `scanInbox` / `scanCalendar`）。
 */
export class MicrosoftGraphPort {
  private readonly base: string
  private readonly user: string
  private readonly transport: GraphFetch
  private readonly pageSize: number
  constructor(private readonly options: GraphPortOptions) {
    const base = (options.base ?? '').trim()
    const chosen = base ? base.replace(/\/+$/, '') : DEFAULT_GRAPH_BASE
    // token 只允许送去**官方 Graph** 或**回环测试服务器**：一个配置里的 base 不该能把
    // Bearer token 送去任意域名。官方 origin 必 https；测试基址只能是 localhost/127.0.0.1/::1。
    if (chosen !== DEFAULT_GRAPH_BASE && !isLoopback(chosen)) {
      throw new GraphError(`拒绝非官方 Graph 基址（只允许 ${DEFAULT_GRAPH_BASE} 或回环测试服务器）：${redactLocation(chosen)}`)
    }
    this.base = chosen
    this.user = (options.user ?? 'me').trim() || 'me'
    this.transport = options.fetch ?? defaultFetch()
    const size = options.pageSize ?? 50
    this.pageSize = Math.min(1000, Math.max(1, Math.trunc(size)))
  }

  /** `MailPort` 视图：把 `fetchMail` 包成 `fetch(since)`。 */
  get mail(): MailPort {
    return { fetch: (since, signal) => this.fetchMail(since, signal) }
  }

  /** `CalendarPort` 视图：把 `fetchEvents` 包成 `fetch(from, to)`。 */
  get calendar(): CalendarPort {
    return { fetch: (from, to, signal) => this.fetchEvents(from, to, signal) }
  }

  /** 读 `since` 之后收到的信（按收信时间升序）。判定的窗口与去重交给 `scanInbox`，这里只拉取。 */
  async fetchMail(since: string, signal?: AbortSignal): Promise<readonly MailMessage[]> {
    const sinceIso = toIsoOrThrow(since, 'since')
    // $filter 用 receivedDateTime；Graph 要求 orderby 的字段也在 filter 里（这里只有 receivedDateTime）。
    const query = new URLSearchParams({
      '$filter': `receivedDateTime ge ${sinceIso}`,
      '$orderby': 'receivedDateTime asc',
      '$select': 'id,internetMessageId,subject,from,toRecipients,ccRecipients,receivedDateTime,isRead,categories,conversationId',
      '$top': String(this.pageSize),
    })
    const url = `${this.base}/${this.userPath()}/messages?${query.toString()}`
    const page = await this.get(url, signal)
    const items = Array.isArray(page.value) ? page.value : []
    const mails: MailMessage[] = []
    for (const item of items) {
      const mail = mailOf(item)
      if (mail) mails.push(mail)
    }
    return mails
  }

  /** 读 `[from, to)` 窗口内的日程（含重复/例外实例，`calendarView` 会自动展开）。 */
  async fetchEvents(from: string, to: string, signal?: AbortSignal): Promise<readonly CalendarEvent[]> {
    const fromIso = toIsoOrThrow(from, 'from')
    const toIso = toIsoOrThrow(to, 'to')
    const query = new URLSearchParams({
      startDateTime: fromIso,
      endDateTime: toIso,
      '$select': 'id,subject,start,end,isAllDay,isCancelled,attendees',
      '$top': String(this.pageSize),
    })
    const url = `${this.base}/${this.userPath()}/calendarView?${query.toString()}`
    const page = await this.get(url, signal)
    const items = Array.isArray(page.value) ? page.value : []
    const events: CalendarEvent[] = []
    for (const item of items) {
      const event = eventOf(item)
      if (event) events.push(event)
    }
    return events
  }

  /** `me` 还是 `users/{id}`：`me` 是 token 本人；其它按 `users/{id}` 走。 */
  private userPath(): string {
    if (this.user === 'me') return 'me'
    return `users/${encodeURIComponent(this.user)}`
  }

  /** 发一次 GET：带 Bearer、校验响应、把坏形状抛成 `GraphError`。token 现读。 */
  private async get(url: string, signal?: AbortSignal): Promise<GraphPage> {
    const token = this.token()
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json' }
    // `redirect: 'manual'`：不让底层 fetch 自动跟随 3xx —— 一旦 Graph 把请求 302 到
    // 别的 origin，自动跟随就会把 Bearer token 也带过去。这里自己判，跨 origin 直接拒。
    let response: Awaited<ReturnType<GraphFetch>>
    try {
      response = await this.transport(url, { headers, redirect: 'manual', ...signal ? { signal } : {} })
    } catch (error) {
      if (signal?.aborted) throw error
      // 网络层失败：不回显 token（它不在 url 里，但错误消息可能带 header，兜底脱敏）。
      throw new GraphError(redactToken(`Graph 请求失败：${String(error)}`, token))
    }
    // 3xx：只允许同 origin 的重定向（Graph 偶发把 /me 规整到 /users/... 同域），
    // 跨 origin 一律拒，绝不把 token 送去别处。这里也不自动跟随，交给调用方下一次轮询。
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers?.location ?? ''
      if (!sameOrigin(url, location)) {
        throw new GraphError(`Graph 返回 ${response.status} 重定向到非同一 origin，拒绝跟随（${redactLocation(location)}）`, response.status)
      }
      throw new GraphError(`Graph 返回同域重定向 ${response.status}，未跟随（下一轮重新请求）`, response.status)
    }
    if (!response.ok) {
      let text = ''
      try { text = await response.text() } catch { /* 保留状态码即可 */ }
      // 401/403 单独成一类：地址对、token 不对/权限不够。
      throw new GraphError(redactToken(`Graph 回答了 ${response.status}${text ? `：${text.slice(0, 300)}` : ''}`, token), response.status)
    }
    let body: unknown
    try {
      body = await response.json()
    } catch (error) {
      throw new GraphError(redactToken(`Graph 响应不是 JSON：${String(error)}`, token), response.status)
    }
    if (!body || typeof body !== 'object') throw new GraphError('Graph 响应不是对象', response.status)
    return body as GraphPage
  }

  /** 现读 token；读不到就抛（`GraphError`，无 status），由调用方标 health。 */
  private token(): string {
    const read = readGraphToken(this.options.token, this.options.io)
    if (!read.token) {
      throw new GraphError(`Graph 凭据读不到${read.problem ? `：${read.problem}` : '（tokenEnv / tokenFile 都为空）'}`)
    }
    return read.token
  }
}

function toIsoOrThrow(value: string, name: string): string {
  const at = Date.parse(value)
  if (!Number.isFinite(at)) throw new GraphError(`时间参数 ${name} 不是合法时刻：${value}`)
  return new Date(at).toISOString()
}

/** 默认运输层：全局 `fetch`。放在函数里取，避免模块加载期就去抓一个可能不存在的全局。 */
function defaultFetch(): GraphFetch {
  return async (url, init) => {
    const response = await fetch(url, { ...init, redirect: 'manual' })
    return {
      status: response.status,
      ok: response.ok,
      headers: { location: response.headers.get('location') ?? undefined },
      json: () => response.json() as Promise<unknown>,
      text: () => response.text(),
    }
  }
}

/** 两个 URL 是否同 origin（协议 + 主机 + 端口）。相对 Location 视为同 origin。 */
export function sameOrigin(base: string, location: string): boolean {
  if (!location) return true
  try {
    const from = new URL(base)
    const to = new URL(location, base)
    return from.protocol === to.protocol && from.host === to.host
  } catch {
    return false
  }
}

/** 重定向目标的脱敏写法：只留 host + path，去掉任何 query（可能含一次性码）。 */
export function redactLocation(location: string): string {
  if (!location) return '（无 Location）'
  try { const u = new URL(location); return `${u.protocol}//${u.host}${u.pathname}` }
  catch { return '（无法解析的 Location）' }
}

/** 是不是回环测试服务器（localhost / 127.0.0.0/8 / ::1）。token 只允许送去官方 Graph 或这里。 */
export function isLoopback(base: string): boolean {
  try {
    const u = new URL(base)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
    const host = u.hostname.toLowerCase()
    return host === 'localhost' || host === '::1' || host === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  } catch { return false }
}
