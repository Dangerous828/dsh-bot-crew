/**
 * App 故障上报：域名端接收、有界落盘、查询与导出。
 *
 * 参照汽车音乐 App（ZSpaceCarPlayer crash-reports JSONL）的取证机制（只取机制，不照搬按天 JSONL）：
 * 一份报告由客户端生成 `id`（=reportId）做幂等去重、`build` / `versionCode` 判版本、发生时间 `at`
 * 与服务端 `receivedAt` 分开记，一条故障能在时间线上被完整定位。本仓复用现有 `store` KV（唯一库），
 * 把「按设备一个有界 chunk」当作红线段，**不做 idx 多键索引** —— 每请求只读写这台设备自己的那一段
 * + 一个全局计数键，不扫全库。
 *
 * 职责边界（几条不显然的规则写在这里）：
 *
 * 1. **device 只信入口验过的 principal**，绝不信 body 里自报的 device / sourceIP —— 后者可伪造。
 * 2. **白名单落盘**。token / query / headers / body / text / 聊天正文一律不采；`err` 只收「类别或码」
 *    短词；crash 只收 `errorClass`、栈帧 `stack`（≤8KiB）、`breadcrumbs`（≤50，逐项白名单），
 *    绝不收任意原始 `diagLog` / `exception.message` / body，以免夹带聊天或 token。
 * 3. **幂等**：同一 `id` 再来一次 —— 已存在就纳入 `acceptedIds`（客户端可删本地缓存），但不再重复存。
 * 4. **ACK 只在 durable 存好后才发**：`store.set` 是同步写 sqlite(WAL)，返回即已落库；ACK 在 set 之后。
 * 5. **有界**：每台设备 `perDeviceMaxRows`（默认 5000 行）/ `retainMs`（默认 7 天）/
 *    `perDeviceMaxBytes`（默认 2MiB）；全球 `globalMaxRows`（50000）/ `globalMaxBytes`（24MiB）。
 *    行数之外还要**字节上限** —— 否则 5000×16KiB≈80MB JSON 每次 set 开销过大。淘汰在写路径上做，
 *    按设备自己的段 FIFO，超全球上限再淘汰最旧的设备段。
 */
import type { Key } from '../kv.ts'

/** 采集白名单：这些 key 之外的东西进不了库。`route` 在进库前已去 query。 */
const APP_MAX = 64
const BUILD_MAX = 128
const EVENT_MAX = 64
const SHORT_MAX = 128
const ROUTE_MAX = 512
const EXTRA_KEYS = new Set(['phase', 'networkKind', 'model', 'version', 'routeKind'])
const EXTRA_VALUE_MAX = 200
const STACK_MAX = 8 * 1024
const BREADCRUMB_MAX = 50
const BREADCRUMB_FIELD_MAX = 200

/** 批大小边界（契约冻结值）。 */
export const MAX_BATCH = 50
export const MAX_BODY_BYTES = 64 * 1024
export const MAX_ROW_BYTES = 16 * 1024 // 单条 report envelope 上限（crash 也受限在此）
export const MAX_EVENT_ROW_BYTES = 1024 // 普通 event 单条更小

/** 一条记录在库里存成的形状：只保留白名单字段，缺失就不出现。 */
export interface DiagEvent {
  id: string
  kind: 'event' | 'crash'
  at: string
  event: string
  route: string
  method?: string
  status?: number
  ms?: number
  err?: string
  session?: string
  appVersion?: string
  versionCode?: number
  extra?: Record<string, string>
  // crash 专属
  errorClass?: string
  stack?: string
  breadcrumbs?: Array<Record<string, string>>
}

/** 落盘的一行：记录 + 服务端收到的时刻（与客户端 `at` 分开，同 car 的 received_at）+ 归属设备与服务端补的批级元数据。 */
export interface DiagRow extends DiagEvent {
  receivedAt: string
  /** 服务端从已验 principal 派生的设备号（绝不来自 body）。查询合并多设备时靠它辨来源。 */
  device: string
  /** 批级元数据 `app` / `build`：客户端一般只在批级带 build，落到每行才能定位 APK 版本。 */
  app: string
  build: string
}

/** 一台设备一段有界 chunk。seq 单调递增，给已存记录排稳定顺序（不受 `at` 字符串影响）。 */
interface DeviceSegment {
  rows: Array<DiagRow & { seq: number }>
  next: number
  bytes: number
}

export interface DiagnosticsStore {
  get<V>(name: Key<V>): V | undefined
  set<V>(name: Key<V>, value: V): void
  delete(name: string): void
  keys(prefix: string): string[]
}

export interface DiagnosticsOptions {
  perDeviceMaxRows?: number
  perDeviceMaxBytes?: number
  globalMaxRows?: number
  globalMaxBytes?: number
  retainMs?: number
  rateLimit?: number
  rateWindowMs?: number
  now?: () => number
}

/** KV key：每台设备一段，全球一枚字节计数。 */
const SEG = 'diagnostics:dev:'
const TOTAL_BYTES = 'diagnostics:bytes'
const RATE = 'diagnostics:rate:'

const DEFAULTS = {
  perDeviceMaxRows: 5000,
  perDeviceMaxBytes: 2 * 1024 * 1024,
  globalMaxRows: 50000,
  globalMaxBytes: 24 * 1024 * 1024,
  retainMs: 7 * 24 * 60 * 60 * 1000,
  rateLimit: 30,
  rateWindowMs: 60_000,
}

const segKey = (device: string) => `${SEG}${device}`

/** 一批解析结果：通过白名单的条目 + 被拒条目（客户端据此不 ACK、自行修正）。 */
export interface BatchOutcome {
  accepted: DiagEvent[]
  rejected: Array<{ id?: string; reason: string }>
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const byteLen = (v: unknown): number => Buffer.byteLength(JSON.stringify(v ?? null))

/** 去 query：只留 pathname。`/x?a=1#h` → `/x`；不带斜杠的当坏值。 */
export function stripQuery(route: unknown): string | undefined {
  if (typeof route !== 'string') return undefined
  const trimmed = route.trim()
  if (!trimmed.startsWith('/')) return undefined
  const cut = trimmed.split(/[?#]/, 1)[0]!
  return cut.length > ROUTE_MAX ? cut.slice(0, ROUTE_MAX) : cut
}

/**
 * route 净化：先**有界解码一层**（防编码进路径的 `%3Ftoken%3D…`），再判「解出来是不是把 query 塞进了路径」
 * 与敏感形态。规则：
 *  - 一次 `decodeURIComponent` 失败（非法百分号序列 / 解坏）→ 明确拒（`route_bad_encoding`），不无限解、不保留原值。
 *  - 解码后仍含 `?`/`#`（原本 query 被编码）→ 视为「拿 query 冒充路径」→ 拒（`route_sensitive`），不「解了再重新引入 query」。
 *  - 解码后命中敏感形态（含 sk_live_ 长密钥、Bearer、password=）→ 拒（`route_sensitive`）。
 *  - 否则用**解码后的明文路径**（不含 query/hash、去敏感）作为落盘值。
 */
function sanitizeRoute(raw: unknown): { route: string } | { reason: string } {
  if (typeof raw !== 'string') return { reason: 'route_required' }
  const trimmed = raw.trim()
  if (!trimmed.startsWith('/')) return { reason: 'route_required' }
  let decoded: string
  try { decoded = decodeURIComponent(trimmed) } catch { return { reason: 'route_bad_encoding' } }
  // 一次有界 decode 后若**仍残留任何 %HH**，说明是多层编码（语义未定，如 %253F → 解一层变 %3F）：
  // 不循环无限解、也不保留这层歧义编码，直接拒（route_bad_encoding）。日志路由不需要这种歧义形态。
  if (/%[0-9A-Fa-f]{2}/.test(decoded)) return { reason: 'route_bad_encoding' }
  // 解码后若冒出了 query/hash 分隔符，说明原本把 query 编码进了路径 —— 直接拒，不 strip 后假装干净。
  if (/[?#]/.test(decoded)) return { reason: 'route_sensitive' }
  if (hasSensitive(decoded)) return { reason: 'route_sensitive' }
  // 去掉控制字符；长度封顶。
  const clean = decoded.replace(/[\u0000-\u001f]/g, '')
  if (!clean.startsWith('/')) return { reason: 'route_required' }
  return { route: clean.length > ROUTE_MAX ? clean.slice(0, ROUTE_MAX) : clean }
}

/** 只收「类别或码」短词：不允许空格/换行/引号等，长度封顶。message 带凭据的典型特征是空格与标点。 */
function shortToken(value: unknown, max = SHORT_MAX): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  if (!/^[A-Za-z0-9._/-]{1,128}$/.test(trimmed)) return undefined
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

/**
 * 敏感模式：即使进了白名单字段（extra 值、route），也要把「像凭据/查询/密码」的片段剥掉或整条拒收。
 * 覆盖：`?token=`/`&password=` 类 query、`Bearer …`、`password:`/`token=` 键值、私钥头、长 base64/hex，
 * 以及**下划线前缀的密钥段**（如 `sk_live_<16+>`：前面是 `_` 时 `\b` 不成立，需单独兜）。
 */
const SECRET_TOKEN = /(?:sk|pk|rk|ak|tok|key|secret|api)[_-][A-Za-z0-9_-]{16,}/i
const SENSITIVE = new RegExp([
  '(?:[?&](?:token|access_token|api_key|apikey|password|passwd|pwd|secret|auth|session|sig|signature|key)=)',
  '(?:bearer\\s+[A-Za-z0-9._-]{8,})',
  '["\\\']?(?:password|passwd|pwd|secret|token|api_?key)["\\\']?\\s*[:=]\\s*\\S',
  '-----BEGIN [A-Z ]+-----',
  '\\b[A-Za-z0-9+/]{32,}={0,2}\\b',
  SECRET_TOKEN.source,
].join('|'), 'i')
const hasSensitive = (value: string): boolean => SENSITIVE.test(value)

/** `extra` 只放行登记过的键，值当短串；命中敏感模式的值整条丢弃（绝不 half-store）。 */
function sanitizeExtra(value: unknown): Record<string, string> | undefined {
  if (!isObject(value)) return undefined
  const out: Record<string, string> = {}
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = rawKey.trim()
    if (!EXTRA_KEYS.has(key)) continue
    let text: string | undefined
    if (typeof rawValue === 'number' && Number.isFinite(rawValue)) text = String(rawValue)
    else if (typeof rawValue === 'string') text = rawValue.trim()
    if (!text) continue
    // extra 值里出现 token/query/密码形态 → 整条丢弃该值，不放行半截。
    if (hasSensitive(text)) continue
    out[key] = text.length > EXTRA_VALUE_MAX ? text.slice(0, EXTRA_VALUE_MAX) : text
  }
  return Object.keys(out).length ? out : undefined
}

/** breadcrumbs 逐项过同字段白名单：只留 at/event/route/method/status/ms/err，全部短词。 */
function sanitizeBreadcrumbs(value: unknown): Array<Record<string, string>> | undefined {
  if (!Array.isArray(value)) return undefined
  const items: Array<Record<string, string>> = []
  for (const raw of value.slice(0, BREADCRUMB_MAX)) {
    if (!isObject(raw)) continue
    const crumb: Record<string, string> = {}
    const at = typeof raw.at === 'string' && !Number.isNaN(Date.parse(raw.at)) ? new Date(raw.at).toISOString() : undefined
    if (at) crumb.at = at
    const event = shortToken(raw.event, EVENT_MAX)
    if (event) crumb.event = event
    // breadcrumb 的 route 也走同一条净化：不可净化就**不带这条 route**（该 crumb 其余字段仍可留）。
    const routeV = sanitizeRoute(raw.route)
    if ('route' in routeV) crumb.route = routeV.route
    const method = shortToken(raw.method, 16)
    if (method) crumb.method = method.toUpperCase()
    if (typeof raw.status === 'number' && Number.isInteger(raw.status)) crumb.status = String(raw.status)
    if (typeof raw.ms === 'number' && Number.isFinite(raw.ms) && raw.ms >= 0) crumb.ms = String(Math.min(Math.round(raw.ms), 86_400_000))
    const err = shortToken(raw.err, SHORT_MAX)
    if (err) crumb.err = err
    if (Object.keys(crumb).length) items.push(crumb)
  }
  return items.length ? items : undefined
}

/**
 * 栈只保留**结构帧**：每行必须像一条调用帧（文件名+行号 / NativeMethod / at …(File:line)），
 * 不认识的行（异常 message、带 token 的 URL、自由文本、聊天原文）整条丢弃。绝不原样存 message。
 *
 * 认得的形状（去空白后）：
 *  - JVM/Android：`at pkg.Class.method(File.java:123)` / `Caused by: …` 只留 `…(File:line)` 段之前的调用帧
 *  - 通用：`File.kt:123` / `file.js:10:5`（`name(path:line:col)`）
 *  - iOS/原生：`Class.method` 或 `symbol+0x1f`（无空格自由文本才收）
 * 其余一律不留。最后封顶 8KiB。
 */
function sanitizeStack(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const frames: string[] = []
  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim()
    if (!line) continue
    // 带 token/查询/密码/私钥/长 base64 的整行丢掉（哪怕它长得像帧）。
    if (hasSensitive(line)) continue
    // `at a.b.C.method(File.java:123)` → 只留括号前的限定名 + 括号里的位置；message 段（冒号后自由文本）不收。
    const at = /^at\s+([\w$.<>]+)\(([\w.$-]+:\d+)\)$/.exec(line)
    if (at) { frames.push(`at ${at[1]}(${at[2]})`); continue }
    // `name(path:line:col)` 通用（JS/TS/Kotlin/…)：括号里必须是 file:line 形状。
    const named = /^([\w$.<>]+)?\(?([\w$./-]+\.[A-Za-z0-9]+:\d+(?::\d+)?)\)?$/.exec(line)
    if (named) { frames.push(`${named[1] ? named[1] + '(' : ''}${named[2]})`); continue }
    // 纯 `File.ext:line` 单帧。
    if (/^[\w$./-]+\.[A-Za-z0-9]+:\d+(?::\d+)?$/.test(line)) { frames.push(line); continue }
    // 原生符号 `symbol+0x1f`（无空格的符号名）。
    if (/^[\w$.<>+/-]+(?:\+0x[0-9a-f]+)?$/i.test(line) && !/\s/.test(line)) { frames.push(line); continue }
    // 不认识的行（异常 message / URL / 自由文本 / 聊天）整条丢。
  }
  if (!frames.length) return undefined
  let text = frames.slice(0, 200).join('\n')
  return text.length > STACK_MAX ? text.slice(0, STACK_MAX) : text
}

/** 把一条原始记录过白名单。返回 `{ event }` 或 `{ reason }`（不通过时说明原因）。 */
export function sanitizeEvent(raw: unknown): { event: DiagEvent } | { reason: string } {
  if (!isObject(raw)) return { reason: 'not_an_object' }
  const id = shortToken(raw.id, 128)
  if (!id) return { reason: 'id_required' }
  if (typeof raw.at !== 'string' || Number.isNaN(Date.parse(raw.at))) return { reason: 'bad_at' }
  const event = shortToken(raw.event, EVENT_MAX)
  if (!event) return { reason: 'event_required' }
  // 有界解码 + 编码 query 检测 + 敏感形态 → 不可净化的整条拒收；否则落盘的是解码后的干净路径。
  const routeVerdict = sanitizeRoute(raw.route)
  if ('reason' in routeVerdict) return { reason: routeVerdict.reason }
  const route = routeVerdict.route
  const kindRaw = typeof raw.kind === 'string' ? raw.kind.trim().toLowerCase() : 'event'
  // 只有两种 kind。event 单条 ≤1KiB、crash 单条 ≤16KiB（由 parseBatch 先按 kind 判大小）。
  const kind: 'event' | 'crash' = kindRaw === 'crash' ? 'crash' : kindRaw === 'event' ? 'event' : 'event'
  const out: DiagEvent = { id, kind, at: new Date(raw.at).toISOString(), event, route }
  const method = shortToken(raw.method, 16)
  if (method) out.method = method.toUpperCase()
  if (typeof raw.status === 'number' && Number.isInteger(raw.status) && raw.status >= 0 && raw.status <= 999) out.status = raw.status
  if (typeof raw.ms === 'number' && Number.isFinite(raw.ms) && raw.ms >= 0) out.ms = Math.min(Math.round(raw.ms), 86_400_000)
  const err = shortToken(raw.err, SHORT_MAX)
  if (err) out.err = err
  const session = shortToken(raw.session, 64)
  if (session) out.session = session
  const appVersion = shortToken(raw.appVersion ?? raw.version, BUILD_MAX)
  if (appVersion) out.appVersion = appVersion
  if (typeof raw.versionCode === 'number' && Number.isInteger(raw.versionCode) && raw.versionCode >= 0) out.versionCode = raw.versionCode
  const extra = sanitizeExtra(raw.extra)
  if (extra) out.extra = extra
  if (kind === 'crash') {
    const errorClass = shortToken(raw.errorClass, SHORT_MAX)
    if (errorClass) out.errorClass = errorClass
    const stack = sanitizeStack(raw.stack)
    if (stack) out.stack = stack
    const breadcrumbs = sanitizeBreadcrumbs(raw.breadcrumbs)
    if (breadcrumbs) out.breadcrumbs = breadcrumbs
  }
  return { event: out }
}

/** 解析整批 body。形状 / 条数不合就整体 4xx。单条大小按 kind 判（event≤1KiB / crash≤16KiB）。 */
export function parseBatch(
  body: unknown,
): { ok: true; app: string; build: string; outcome: BatchOutcome } | { ok: false; error: string; rejected?: BatchOutcome['rejected'] } {
  if (!isObject(body)) return { ok: false, error: 'Invalid JSON' }
  // report 必须是 JSON 对象，不接受被双重字符串化（body 是 string / 元素是 string 一律拒）。
  if (typeof body === 'string') return { ok: false, error: 'body must be a JSON object, not a string' }
  const app = typeof body.app === 'string' ? body.app.trim().slice(0, APP_MAX) : ''
  const build = typeof body.build === 'string' ? body.build.trim().slice(0, BUILD_MAX) : ''
  if (!app) return { ok: false, error: 'app is required' }
  const batch = body.batch
  if (!Array.isArray(batch)) return { ok: false, error: 'batch must be an array' }
  // 空批无意义：契约明确定义为 400（不是有效空 ACK），客户端不该发空批。
  if (batch.length === 0) return { ok: false, error: 'batch must not be empty' }
  if (batch.length > MAX_BATCH) return { ok: false, error: 'batch too large' }
  const accepted: DiagEvent[] = []
  const rejected: BatchOutcome['rejected'] = []
  for (const item of batch) {
    const id = isObject(item) && typeof item.id === 'string' ? item.id : undefined
    if (typeof item === 'string') { rejected.push({ id, reason: 'record_is_string' }); continue }
    const size = byteLen(item)
    if (size > MAX_ROW_BYTES) { rejected.push({ id, reason: 'row_too_large' }); continue }
    const verdict = sanitizeEvent(item)
    if (!('event' in verdict)) { rejected.push({ id, reason: verdict.reason }); continue }
    // 普通 event 单条 1KiB 上限（crash 才放宽到 16KiB）。
    if (verdict.event.kind === 'event' && byteLen(verdict.event) > MAX_EVENT_ROW_BYTES) {
      rejected.push({ id, reason: 'event_too_large' }); continue
    }
    accepted.push(verdict.event)
  }
  // 整批全坏 → 4xx（客户端应显式修正，不静默 200）。
  if (batch.length > 0 && accepted.length === 0) {
    return { ok: false, error: 'all records rejected', rejected }
  }
  return { ok: true, app, build, outcome: { accepted, rejected } }
}

/** 上报结果：`acceptedIds` = 新存 + 幂等命中；`rejectedIds` + `reasonCodes` 不被 ACK。 */
export interface ReportResult {
  ok: true
  acceptedIds: string[]
  rejectedIds: string[]
  reasonCodes: string[]
}

/** 一台设备上报盒的入口：速率、收批（幂等+有界+durable）、只读查询与导出。不持连接、不转发网关。 */
export class Diagnostics {
  private readonly opts: typeof DEFAULTS & { now: () => number }

  constructor(private readonly store: DiagnosticsStore, options: DiagnosticsOptions = {}) {
    this.opts = { ...DEFAULTS, now: options.now ?? Date.now, ...defined(options) }
  }

  private segment(device: string): DeviceSegment {
    const value = this.store.get<DeviceSegment>(segKey(device) as Key<DeviceSegment>)
    if (!value || !Array.isArray(value.rows) || typeof value.next !== 'number') return { rows: [], next: 1, bytes: 0 }
    const bytes = typeof value.bytes === 'number' ? value.bytes : value.rows.reduce((sum, row) => sum + byteLen(row), 0)
    return { rows: value.rows, next: value.next, bytes }
  }

  private save(device: string, segment: DeviceSegment): void {
    this.store.set(segKey(device) as Key<DeviceSegment>, segment)
  }

  /** 速率判定：每设备每窗口的批次数。超了返回 false，调用方回 429 + Retry-After。 */
  rateAllowed(device: string): { allowed: boolean; retryAfterSec: number } {
    const now = this.opts.now()
    const key = `${RATE}${device}` as Key<{ windowStart: number; count: number }>
    const state = this.store.get<{ windowStart: number; count: number }>(key)
    if (!state || now - state.windowStart >= this.opts.rateWindowMs) {
      this.store.set(key, { windowStart: now, count: 1 })
      return { allowed: true, retryAfterSec: 0 }
    }
    if (state.count >= this.opts.rateLimit) {
      const retryAfterSec = Math.max(1, Math.ceil((state.windowStart + this.opts.rateWindowMs - now) / 1000))
      return { allowed: false, retryAfterSec }
    }
    this.store.set(key, { windowStart: state.windowStart, count: state.count + 1 })
    return { allowed: true, retryAfterSec: 0 }
  }

  /** 收一批（已被授权、已过速率关）。app/build 是批级元数据，落到每一行。ACK 只在 set 之后返回（durable）。 */
  report(device: string, app: string, build: string, outcome: BatchOutcome): ReportResult {
    const now = this.opts.now()
    const receivedAt = new Date(now).toISOString()
    const segment = this.segment(device)
    const seen = new Set(segment.rows.map(row => row.id))
    const acceptedIds: string[] = []
    for (const event of outcome.accepted) {
      if (seen.has(event.id)) { acceptedIds.push(event.id); continue } // 幂等：ACK 但不重存
      const row: DiagRow & { seq: number } = { ...event, receivedAt, device, app, build, seq: segment.next++ }
      segment.rows.push(row)
      segment.bytes += byteLen(row)
      seen.add(event.id)
      acceptedIds.push(event.id)
    }
    const rejectedIds = outcome.rejected.map(r => r.id).filter((id): id is string => !!id)
    const reasonCodes = Array.from(new Set(outcome.rejected.map(r => r.reason)))
    // 有界：先对写入这台做保留期/行数/字节裁剪并落盘（ACK 依赖它 durable）。
    this.trimDevice(segment, now)
    this.save(device, segment) // ← durable 落盘；下面的 ACK 在它之后
    // 同时淘汰**其它沉默设备**里已过期的行与超限（不只是被写的那台），并把全球计数算准。
    this.pruneOthers(device, now)
    this.enforceGlobal(device)
    return { ok: true, acceptedIds, rejectedIds, reasonCodes }
  }

  /** 对所有设备（含沉默的）按保留期/行数/字节做一次裁剪，把收到的时点推进到 now。 */
  private pruneOthers(writeDevice: string, now: number): void {
    for (const key of this.store.keys(SEG)) {
      const device = key.slice(SEG.length)
      const seg = this.segment(device)
      const before = seg.rows.length
      this.trimDevice(seg, now)
      if (device !== writeDevice || seg.rows.length !== before) this.save(device, seg)
    }
  }

  private trimDevice(segment: DeviceSegment, now: number): void {
    const cutoff = now - this.opts.retainMs
    let drop = 0
    while (drop < segment.rows.length && Date.parse(segment.rows[drop]!.receivedAt) < cutoff) drop++
    while (segment.rows.length - drop > this.opts.perDeviceMaxRows) drop++
    let bytes = drop ? segment.bytes - segment.rows.slice(0, drop).reduce((s, r) => s + byteLen(r), 0) : segment.bytes
    while (drop < segment.rows.length && bytes > this.opts.perDeviceMaxBytes) {
      bytes -= byteLen(segment.rows[drop]!); drop++
    }
    if (drop) { segment.rows = segment.rows.slice(drop); segment.bytes = Math.max(0, bytes) }
  }

  /** 全球上限（行数或字节）：超限时按「哪台最旧」削其它设备的头部，写设备最后才动。 */
  private enforceGlobal(writeDevice: string): void {
    const devices = this.store.keys(SEG).map(key => key.slice(SEG.length))
    const segs = new Map<string, DeviceSegment>()
    let rows = 0, bytes = 0
    for (const device of devices) {
      const seg = this.segment(device)
      segs.set(device, seg)
      rows += seg.rows.length
      bytes += seg.bytes
    }
    this.store.set(TOTAL_BYTES as Key<number>, bytes)
    if (rows <= this.opts.globalMaxRows && bytes <= this.opts.globalMaxBytes) return
    const order = [...devices].sort((a, b) => {
      const oldest = (d: string) => segs.get(d)!.rows[0]?.receivedAt ?? '9999'
      return oldest(a).localeCompare(oldest(b))
    })
    for (const device of order) {
      if (rows <= this.opts.globalMaxRows && bytes <= this.opts.globalMaxBytes) break
      if (device === writeDevice && order.length > 1) continue
      const seg = segs.get(device)!
      let drop = 0, droppedBytes = 0
      while (drop < seg.rows.length && (rows > this.opts.globalMaxRows || bytes > this.opts.globalMaxBytes)) {
        const removedBytes = byteLen(seg.rows[drop]!)
        rows--; bytes -= removedBytes; droppedBytes += removedBytes; drop++
      }
      if (drop) { seg.rows = seg.rows.slice(drop); seg.bytes = Math.max(0, seg.bytes - droppedBytes); this.save(device, seg) }
    }
    // 记回真实的全球字节数：不靠逐段累加猜，直接用上面维护的 `bytes`（已随每台被剔行同步扣减），
    // 这样多设备累计不会偏高。行数/字节与各段实际内容一致。
    this.store.set(TOTAL_BYTES as Key<number>, bytes)
  }

  /** 只读查询。`device` 给了就只看那台（消息面用），不给看所有（管理面用）。 */
  list(filter: { device?: string; session?: string; since?: string; errorsOnly?: boolean; limit?: number }): {
    rows: DiagRow[]
    devices: string[]
  } {
    const now = this.opts.now()
    // 读时也按保留期过滤：即使某台设备自上次写之后一直沉默、没被写路径 prune 到，
    // GET/导出 也绝不返回已过期的报告。每个返回行都带 server 派生的 device/app/build。
    const cutoff = now - this.opts.retainMs
    const devices = filter.device ? [filter.device] : this.store.keys(SEG).map(key => key.slice(SEG.length))
    const sinceMs = filter.since && !Number.isNaN(Date.parse(filter.since)) ? Date.parse(filter.since) : undefined
    const limit = Math.max(1, Math.min(filter.limit ?? 200, 2000))
    const rows: DiagRow[] = []
    for (const device of devices) {
      for (const { seq: _seq, ...row } of this.segment(device).rows) {
        if (Date.parse(row.receivedAt) < cutoff) continue // 过期：不返回（也未被写路径淘汰时在此兜底）
        if (sinceMs !== undefined && Date.parse(row.receivedAt) < sinceMs) continue
        if (filter.session && row.session !== filter.session) continue
        if (filter.errorsOnly && !isErrorRow(row)) continue
        rows.push(row)
      }
    }
    rows.sort((a, b) => (b.receivedAt.localeCompare(a.receivedAt)) || (b.at.localeCompare(a.at)))
    return { rows: rows.slice(0, limit), devices }
  }

  /** 导出：与 list 同口径，NDJSON 一行一条；白名单后即脱敏。 */
  exportNdjson(filter: Parameters<Diagnostics['list']>[0]): string {
    return this.list(filter).rows.map(row => JSON.stringify(row)).join('\n') + '\n'
  }
}

/** 一条算不算「错误」：非 2xx 的 status，或带 err，或崩溃类 event。给 `errorsOnly` 用。 */
function isErrorRow(row: DiagRow): boolean {
  if (row.kind === 'crash') return true
  if (typeof row.status === 'number' && row.status >= 400) return true
  if (row.err) return true
  return /crash|exception|fail|error|anr/i.test(row.event)
}

function defined<T extends object>(value: T): Partial<T> {
  const out: Partial<T> = {}
  for (const [key, v] of Object.entries(value)) if (v !== undefined) (out as Record<string, unknown>)[key] = v
  return out
}
