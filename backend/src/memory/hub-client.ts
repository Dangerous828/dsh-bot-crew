/**
 * 中枢记忆的真实 HTTP 客户端：把宿主机侧对 `/memory/search` 与 `/memory/consolidate`
 * 的调用写成一份可测的薄封装（契约见 `backend/docs/08-memory-hub.md`）。
 *
 * 只做三件事：拼 URL、发 JSON（带 `X-Hub-Token`）、把响应校验成调用方要的形状。
 * 「中枢能不能用」不在这里判断 —— 那是 `detect.ts` 的探测；这里只在请求失败时如实抛，
 * 由 `HubMemory` 捕获并降级本机。
 *
 * **鉴权失败单独成一类错误**（`HubAuthError`）：401/403 说明「地址对、token 不对」，
 * 与「网络不通」「形状不对」是三种不同的故障，混成一句 `answered 401` 会让运维
 * 看到「hub reached」却查不出原因。调用方据此把状态标成 rejected 并打明确否定的日志。
 */
import type { MemoryEntry } from './recall.ts'
import type { ConsolidateRange, ConsolidateResult } from './port.ts'

/** 一次检索请求/响应的形状（契约 §二.1）。 */
export interface SearchRequest { query: string; bots?: string[]; limit?: number }

/**
 * 中枢接受的 bot_id 口径：`^[a-z0-9][a-z0-9_-]{0,63}$`（`memory_compat_routes._BOT_ID_RE`）。
 *
 * 宿主机自己的 `BOT_ID`（`crew/directory.ts`）更宽：允许 `_lead`、`-lead` 与超长 id。
 * 那些在宿主机是合法的，发给中枢会**整次请求 422** —— 一次 422 就让整轮召回降级本机，
 * 而且看不出是哪一位 Bot 的问题。所以在发请求前按服务端口径过滤，并把被丢掉的说明白。
 */
export const HUB_BOT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/

/** 过滤出中枢认得的 bot_id；空数组表示「一个都不认得」。 */
export function hubBots(bots: readonly string[]): string[] {
  return bots.filter(bot => HUB_BOT_ID.test(bot))
}
interface SearchResponse { entries?: unknown }

/** 一次巩固请求/响应的形状（契约 §二.2）。 */
interface ConsolidateResponse { facts?: unknown; merged?: unknown; superseded?: unknown }

/** 只保留宿主机认得字段的条目；形状不对的条目丢掉，不让一份坏响应毒化整段注入。 */
export function memoryEntriesOf(value: unknown): MemoryEntry[] {
  if (!Array.isArray(value)) return []
  const entries: MemoryEntry[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    const name = typeof item.name === 'string' ? item.name.trim() : ''
    const body = typeof item.body === 'string' ? item.body : ''
    if (!name || !body) continue
    entries.push({
      name,
      bot_id: typeof item.bot_id === 'string' ? item.bot_id : '',
      description: typeof item.description === 'string' ? item.description : '',
      body,
      type: (['user', 'feedback', 'project', 'reference'] as const).includes(item.type as never)
        ? item.type as MemoryEntry['type'] : 'project',
      status: item.status === 'verified' ? 'verified' : 'candidate',
      importance: typeof item.importance === 'number' ? item.importance : 3,
      toHub: item.toHub !== false,
      dedupe_key: typeof item.dedupe_key === 'string' ? item.dedupe_key : name,
      created: typeof item.created === 'number' ? item.created : 0,
      updated: typeof item.updated === 'number' ? item.updated : 0,
      state: item.state === 'forgotten' || item.state === 'superseded' ? item.state : 'active',
    })
  }
  return entries
}

/** 三个计数只认非负整数；缺一个就整份作废，返回 `undefined` 让上层降级。 */
export function consolidateResultOf(value: unknown): ConsolidateResult | undefined {
  if (!value || typeof value !== 'object') return undefined
  const body = value as ConsolidateResponse
  const count = (n: unknown): number | undefined =>
    typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : undefined
  const facts = count(body.facts), merged = count(body.merged), superseded = count(body.superseded)
  if (facts === undefined || merged === undefined || superseded === undefined) return undefined
  return { facts, merged, superseded }
}

/** 中枢拒绝了凭据（401/403）。与「连不上」「形状不对」分开，调用方要能单独说清。 */
export class HubAuthError extends Error {
  readonly status: number
  constructor(path: string, status: number, detail?: string) {
    super(`hub ${path} rejected the credential (${status})${detail ? `: ${detail}` : ''}`)
    this.name = 'HubAuthError'
    this.status = status
  }
}

/** 一条错误是不是鉴权被拒；`HubMemory` 用它决定是「降级」还是「说清是凭据问题」。 */
export const isHubAuthError = (error: unknown): error is HubAuthError => error instanceof HubAuthError

/** 调中枢要用的最小能力：一个基址、一个可注入的 fetch（测试换成假实现）、一个现读的 token。 */
export interface HubHttpOptions {
  /**
   * 中枢基址，如 `http://hub.local:18080/v1`；尾部斜杠会被去掉。
   *
   * 可以传函数：配置热生效时地址会变，客户端不该把旧地址钉死在字段里 ——
   * 否则「探测打新中枢、检索还打旧中枢」，两份读数谁也说不清哪个是真的。
   */
  base: string | (() => string)
  /**
   * 单次请求上限；公网故障最常见的是「连上了但不回」。
   *
   * 同样可以传函数：改超时必须当场生效，不能等客户端重建。
   */
  timeoutMs?: number | (() => number)
  /**
   * 每次请求现读 token（空串 = 不带 header）。
   *
   * 传函数而不是值：token 从环境/凭据文件来，改完引用后不必重启；而且值只在请求
   * 那一刻出现在内存里，不挂在对象上、不进日志。
   */
  token?: () => string
  /** 注入 fetch，默认全局 fetch。 */
  fetchImpl?: typeof fetch
  /** 鉴权被拒时回调（状态位与日志由调用方管）。 */
  onAuthRejected?: (status: number, detail?: string) => void
  /** 请求成功时回调（用来清掉「被拒」状态）。 */
  onAccepted?: () => void
}

const DEFAULT_TIMEOUT_MS = 3_000

/** 去尾斜杠：基址可能来自设置，也可能来自现读函数。 */
const trimSlash = (base: string): string => base.replace(/\/+$/, '')

/** 中枢 HTTP 客户端。两个方法各自每次请求独立超时，失败一律抛。 */
export class HubHttp {
  readonly #base: () => string
  readonly #timeoutMs: () => number
  readonly #fetch: typeof fetch
  readonly #token: () => string
  readonly #onAuthRejected?: (status: number, detail?: string) => void
  readonly #onAccepted?: () => void
  constructor(options: HubHttpOptions) {
    const base = options.base
    this.#base = typeof base === 'function' ? () => trimSlash(base()) : () => trimSlash(base)
    const timeout = options.timeoutMs
    this.#timeoutMs = typeof timeout === 'function' ? timeout : () => timeout ?? DEFAULT_TIMEOUT_MS
    this.#fetch = options.fetchImpl ?? fetch
    this.#token = options.token ?? (() => '')
    this.#onAuthRejected = options.onAuthRejected
    this.#onAccepted = options.onAccepted
  }

  /** 基址（已去尾斜杠）。探测与日志用它，避免两处各算一遍。 */
  get url(): string { return this.#base() }

  private async post(path: string, body: unknown): Promise<unknown> {
    const token = this.#token()
    const response = await this.#fetch(this.#base() + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...token ? { 'x-hub-token': token } : {} },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.#timeoutMs()),
    })
    if (response.status === 401 || response.status === 403) {
      // 只读状态码与响应体里的 detail；响应体不含凭据，但截断以免把整页 HTML 塞进日志。
      const detail = await response.text().then(text => text.slice(0, 200)).catch(() => '')
      this.#onAuthRejected?.(response.status, detail || undefined)
      throw new HubAuthError(path, response.status, detail || undefined)
    }
    if (!response.ok) throw new Error(`hub ${path} answered ${response.status}`)
    this.#onAccepted?.()
    return await response.json()
  }

  /** 向量检索（契约 §二.1）：返回条目数组；响应形状不对就是空数组，由调用方决定降级。 */
  async search(request: SearchRequest): Promise<MemoryEntry[]> {
    const body = await this.post('/memory/search', request)
    return memoryEntriesOf((body as SearchResponse | null)?.entries)
  }

  /**
   * 睡眠期巩固（契约 §二.2）。
   *
   * **不传 `apply`**：中枢侧默认 dry-run（只统计可合并对，不写），因为客户端超时只有 3s，
   * 不该拿它驱动批量软删。所以返回值必须把「只出了计划」与「真的执行过」分开 ——
   * 只回三个计数会让上层把 dry-run 的 `merged:0` 当成「合并了 0 条」。
   */
  async consolidate(range: ConsolidateRange): Promise<ConsolidateResult | undefined> {
    const body = await this.post('/memory/consolidate', range)
    const result = consolidateResultOf(body)
    if (!result) return undefined
    // 把中枢自报的执行模式一并带回去：`dryRun` 时 `merged` 是计划数，不是执行数。
    return { ...result, ...consolidateMode(body) }
  }
}

/**
 * 巩固响应里「这次到底写没写」的如实判读。
 *
 * 中枢兼容面默认 `apply=false` → `dryRun:true`、`merged:0`、只回 `candidateMerges`。
 * 这与「真的合并了 0 条」是两件事：前者是**只出了计划**，后者是**执行过**。
 * 只报响应里**真写了**的字段：没有 `dryRun` 就不编一个 false 出来。
 */
export function consolidateMode(value: unknown): { dryRun?: boolean; candidates?: number } | undefined {
  if (!value || typeof value !== 'object') return undefined
  const body = value as { dryRun?: unknown; candidateMerges?: unknown }
  const dryRun = typeof body.dryRun === 'boolean' ? body.dryRun : undefined
  const candidates = typeof body.candidateMerges === 'number' && Number.isSafeInteger(body.candidateMerges) && body.candidateMerges >= 0
    ? body.candidateMerges : undefined
  if (dryRun === undefined && candidates === undefined) return undefined
  return { ...dryRun === undefined ? {} : { dryRun }, ...candidates === undefined ? {} : { candidates } }
}
