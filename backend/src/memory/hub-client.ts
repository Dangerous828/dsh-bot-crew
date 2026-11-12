/**
 * 中枢记忆的真实 HTTP 客户端：把宿主机侧对 `/memory/search` 与 `/memory/consolidate`
 * 的调用写成一份可测的薄封装（契约见 `backend/docs/08-memory-hub.md`）。
 *
 * 只做三件事：拼 URL、发 JSON、把响应校验成调用方要的形状。
 * 「中枢能不能用」不在这里判断 —— 那是 `detect.ts` 的探测；这里只在请求失败时如实抛，
 * 由 `HubMemory` 捕获并降级本机。
 */
import type { MemoryEntry } from './recall.ts'
import type { ConsolidateRange, ConsolidateResult } from './port.ts'

/** 一次检索请求/响应的形状（契约 §二.1）。 */
export interface SearchRequest { query: string; bots?: string[]; limit?: number }
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

/** 调中枢要用的最小能力：一个基址和一个可注入的 fetch（测试换成假实现）。 */
export interface HubHttpOptions {
  /** 中枢基址，如 `http://hub.local:8642`；尾部斜杠会被去掉。 */
  base: string
  /** 单次请求上限；公网故障最常见的是「连上了但不回」。 */
  timeoutMs?: number
  /** 注入 fetch，默认全局 fetch。 */
  fetchImpl?: typeof fetch
}

const DEFAULT_TIMEOUT_MS = 3_000

/** 中枢 HTTP 客户端。两个方法各自每次请求独立超时，失败一律抛。 */
export class HubHttp {
  private readonly base: string
  private readonly timeoutMs: number
  readonly #fetch: typeof fetch
  constructor(options: HubHttpOptions) {
    this.base = options.base.replace(/\/+$/, '')
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.#fetch = options.fetchImpl ?? fetch
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const response = await this.#fetch(this.base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (!response.ok) throw new Error(`hub ${path} answered ${response.status}`)
    return await response.json()
  }

  /** 向量检索（契约 §二.1）：返回条目数组；响应形状不对就是空数组，由调用方决定降级。 */
  async search(request: SearchRequest): Promise<MemoryEntry[]> {
    const body = await this.post('/memory/search', request)
    return memoryEntriesOf((body as SearchResponse | null)?.entries)
  }

  /** 睡眠期巩固（契约 §二.2）：返回计数；形状不对返回 undefined，由调用方降级本机。 */
  async consolidate(range: ConsolidateRange): Promise<ConsolidateResult | undefined> {
    const body = await this.post('/memory/consolidate', range)
    return consolidateResultOf(body)
  }
}
