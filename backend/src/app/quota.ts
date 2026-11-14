/**
 * 逐条用量与额度：每条回复标清「哪个模型答的、花了多少」，以及「还剩多少」。
 *
 * 与 `spend.ts` 的分工：
 * - `spend.ts` 按**票**总账（一张票一共花了多少）；
 * - 这一份按**每条回复**（刚才那一下用了谁、多少），再由此算额度。
 *
 * 「额度」这个词在这里有两个来源，**分开报，不混**：
 *
 * 1. **上下文余量**（算得出来）：`contextWindow` 减去这一步**送进模型的提示词大小**。
 *    提示词大小 = `inputTokens` + `cacheReadTokens` + `cacheWriteTokens`，与宿主
 *    `@deepseek-ai/dsh-token-meter` 的 `pressureFrom()` 同一口径。**只减 `inputTokens`
 *    是错的**：带缓存的路由（本部署的 workbuddy / trae-cn 就是）把绝大部分提示词记在
 *    `cacheReadTokens` 里，`inputTokens` 只剩几百，按它算会报出「还剩 49.9 万」这种
 *    比实际宽得多的数字 —— 面板看着舒服，撞墙时才知道。
 * 2. **真实额度**（读得到才有）：provider 自己的订阅窗口与余额。本部署唯一的路由是
 *    magpie 网关，它的 `GET /v1/magpie/quotas` 就写着每个账号每个窗口用了多少、
 *    什么时候重置。读得到就原样报，读不到就写清**为什么读不到**（`state: 'unavailable'`
 *    + `reason`），绝不拿上下文余量冒充余额。
 *
 * **金额（还剩多少钱）这一层这里仍然不算**：单价与套餐由 provider 决定，不在这台机器上。
 * 真实源给了 `balance` 就照抄那个字符串，没给就是没有。
 */

/** 一条回复的账：答卷的是谁、花了多少、上下文还剩多少。 */
export interface ReplySpend {
  /** `provider/model`，事件里没带就写 unknown。 */
  route: string
  /** 未命中缓存的输入。与宿主 `TokenUsage.inputTokens` 同义。 */
  input_tokens: number
  output_tokens: number
  total_tokens: number
  /** 这一步实际送进模型的提示词大小（输入 + 缓存读 + 缓存写）。余量按它算。 */
  prompt_tokens: number
  /** 命中缓存的输入；provider 没报就缺席。 */
  cache_read_tokens?: number
  /** 写进缓存的输入；provider 没报就缺席。 */
  cache_write_tokens?: number
  /** 这一步之后上下文还剩多少。`contextWindow` 不知道时缺席 —— 不猜。 */
  context_left?: number
  context_window?: number
}

/** 额度：只报算得出来的那一种。 */
export interface Quota {
  /** 上下文余量里最少的那一步（最紧的时候）。 */
  tightest_left?: number
  context_window?: number
  /** 用到什么比例；`context_window` 不知道时缺席。 */
  used_ratio?: number
  /** 告急的阈值：留不到一成时提前说。 */
  warn_ratio: number
}

/** 余量低于这个比例就说一声：撞上「上下文满了」才知道，是最贵的一种发现方式。 */
export const CONTEXT_WARN_RATIO = 0.9

/**
 * 一条回复的账。
 *
 * `contextWindow` 从模型目录里读（provider 公布才有）。读不到就不写 `context_left`：
 * 一个编出来的「还剩 128k」会让人放心地继续聊，然后在某一刻突然撞墙。
 */
export function replySpendOf(input: {
  provider?: string
  model?: string
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }
  contextWindow?: number
}): ReplySpend {
  const inputTokens = positive(input.usage.inputTokens)
  const outputTokens = positive(input.usage.outputTokens)
  const cacheRead = optional(input.usage.cacheReadTokens)
  const cacheWrite = optional(input.usage.cacheWriteTokens)
  const total = input.usage.totalTokens === undefined ? inputTokens + outputTokens : positive(input.usage.totalTokens)
  const route = `${input.provider ?? 'unknown'}/${input.model ?? 'unknown'}`
  const window = input.contextWindow && input.contextWindow > 0 ? input.contextWindow : undefined
  // 提示词大小：宿主 `dsh-token-meter` 的 `pressureFrom()` 就是这个式子。输出是这一步新写的，
  // 不占「已用」；缓存读与缓存写是**真的进了模型**的，漏掉它们等于把余量往宽里报。
  const prompt = inputTokens + (cacheRead ?? 0) + (cacheWrite ?? 0)
  const left = window === undefined ? undefined : Math.max(0, window - prompt)
  return {
    route, input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: total, prompt_tokens: prompt,
    ...(cacheRead === undefined ? {} : { cache_read_tokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cache_write_tokens: cacheWrite }),
    ...(left === undefined ? {} : { context_left: left, context_window: window }),
  }
}

const positive = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
/** 缺席与 0 要分开：`0` 是「这次没走缓存」，缺席是「provider 没说」。 */
const optional = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined

/**
 * 额度告急没有。只对**算得出来的**那一种作答。
 *
 * `undefined` 的意思是「不知道」，与 `false`（「还够」）分开 —— 混在一起会让人以为
 * 系统在替他看着，而实际上它根本没看见。
 */
export function quotaOf(replies: readonly ReplySpend[], warnRatio = CONTEXT_WARN_RATIO): Quota {
  const known = replies.filter(reply => reply.context_window !== undefined && reply.context_left !== undefined)
  if (known.length === 0) return { warn_ratio: warnRatio }
  // 最紧的那一步决定告急：余量一直在掉，平均值会把它藏起来。
  const tightest = known.reduce((lowest, reply) => reply.context_left! < lowest.context_left! ? reply : lowest)
  const window = tightest.context_window!
  const left = tightest.context_left!
  return { tightest_left: left, context_window: window, used_ratio: 1 - left / window, warn_ratio: warnRatio }
}

/** 额度告急该说一句吗。`undefined`（不知道）时不说 —— 不知道的事不要拿来吓人。 */
export function quotaWarning(quota: Quota): string | undefined {
  if (quota.used_ratio === undefined || quota.context_window === undefined || quota.tightest_left === undefined) return undefined
  if (quota.used_ratio < quota.warn_ratio) return undefined
  return `上下文用到 ${Math.round(quota.used_ratio * 100)}%，只剩 ${compact(quota.tightest_left)} / ${compact(quota.context_window)}。`
    + '长会话可以考虑另起一个，记忆不会丢 —— 它已经在账本里了。'
}

/**
 * 真实额度源里的一条：某个账号的某个额度窗口，或某个 key 的余额。
 *
 * 字段全部**照抄源**，不做二次计算：`display` 是源自己写的「1198.56 / 2000」，
 * 拿来和面板对账时它就是判据。
 */
export interface QuotaWindow {
  /** 源里的 provider 键（如 `workbuddy`），不是 DSH 的路由名。 */
  provider: string
  /** 账号；源已经打过码的照抄。 */
  account?: string
  plan?: string
  /** 窗口名：`5 hours` / `7 days` / `Credits`。余额类为 `balance`。 */
  window: string
  /** 用了百分之多少（源给的 0..100）。 */
  used?: number
  remaining?: number
  resets_at?: string
  /** 源自己写的一句话：「1198.56 / 2000」「not enabled」。 */
  display?: string
  /** 余额类：`$-3.51`。字符串照抄，源保留精度。 */
  balance?: string
  unit?: string
  /** 源自己说读不到时的那句话（如「登录已过期」）—— 原样带出来，不改成「未知」。 */
  note?: string
}

/** 一次真实额度的读取结果。读不到时 `windows` 是空的，`reason` 说清为什么。 */
export interface QuotaSourceReading {
  state: 'read' | 'unavailable'
  /** 读的时刻。 */
  at?: string
  /** 读的是哪个地址 —— 对账时先看这一格。 */
  url?: string
  windows: QuotaWindow[]
  reason?: string
  /** 源给的条目超过上限被截断了。说出来，不静默少一截。 */
  truncated?: true
}

/**
 * 默认的真实额度源：本机的 magpie 网关。
 *
 * 本部署 `llm-pi-ai` 的唯一 provider 就是 magpie（`127.0.0.1:3425`），所以它的额度面
 * 就是这支队伍真正的额度面。换一台机器、换一个网关时用 `CREW_QUOTA_SOURCE` 覆盖；
 * 覆盖成空串就是不读。
 */
export const QUOTA_SOURCE_DEFAULT = 'http://127.0.0.1:3425/v1/magpie/quotas'

/** 读哪个地址：`CREW_QUOTA_SOURCE` 优先，空串表示这一台机器不接真实源。 */
export function quotaSourceUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.CREW_QUOTA_SOURCE
  if (raw !== undefined) return raw.trim() || undefined
  return QUOTA_SOURCE_DEFAULT
}

/**
 * 一次最多带回这么多条。
 *
 * 这不是「显示前几条」的限额（那由 `quotaSourceLine` 的 `limit` 管），而是防一条畸形源
 * 把响应撑爆的保险。本机真实源有 33 个条目、上百个窗口，所以这个数要留够 —— 被截断时
 * `truncated` 会说出来，绝不静默少一截。
 */
const SOURCE_LIMIT = 1_000

/**
 * 把 magpie `GET /v1/magpie/quotas` 的响应读成窗口列表。
 *
 * 形状是 magpie 的（`{data: [{provider, name, plan, user, windows: [{name, used, remaining,
 * resetsAt, display, unit}], balance, error}]}`）。别的源要接，写它自己的 parser ——
 * 硬套这个形状只会把「读不到」伪装成「没有额度」。
 *
 * 坏一条不拖垮整批：这一条读不懂就跳过它，其余照报。
 */
export function parseQuotaSource(value: unknown): QuotaWindow[] {
  const list = (value as { data?: unknown } | null | undefined)?.data
  if (!Array.isArray(list)) return []
  const out: QuotaWindow[] = []
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const item = entry as { provider?: unknown; user?: unknown; plan?: unknown; windows?: unknown; balance?: unknown; error?: unknown }
    const provider = typeof item.provider === 'string' ? item.provider.trim() : ''
    if (!provider) continue
    const base = {
      provider,
      ...(typeof item.user === 'string' && item.user.trim() ? { account: item.user.trim() } : {}),
      ...(typeof item.plan === 'string' && item.plan.trim() ? { plan: item.plan.trim() } : {}),
    }
    const windows = Array.isArray(item.windows) ? item.windows : []
    let added = 0
    for (const raw of windows) {
      if (out.length >= SOURCE_LIMIT) break
      if (!raw || typeof raw !== 'object') continue
      const window = raw as { name?: unknown; used?: unknown; remaining?: unknown; resetsAt?: unknown; display?: unknown;
        unit?: unknown; amount?: unknown; limit?: unknown }
      const name = typeof window.name === 'string' && window.name.trim() ? window.name.trim() : 'window'
      const display = typeof window.display === 'string' && window.display ? window.display
        : typeof window.amount === 'number' && typeof window.limit === 'number' ? `${window.amount} / ${window.limit}` : undefined
      out.push({
        ...base, window: name,
        ...(typeof window.used === 'number' ? { used: window.used } : {}),
        ...(typeof window.remaining === 'number' ? { remaining: window.remaining } : {}),
        ...(typeof window.resetsAt === 'string' && window.resetsAt ? { resets_at: window.resetsAt } : {}),
        ...(display === undefined ? {} : { display }),
        ...(typeof window.unit === 'string' && window.unit ? { unit: window.unit } : {}),
      })
      added += 1
    }
    // 余额类（没有窗口）与「源自己说读不到」都各占一条：它们同样是对账时要看的东西。
    if (added === 0 && typeof item.balance === 'string') {
      out.push({ ...base, window: 'balance', balance: item.balance })
    } else if (added === 0 && typeof item.error === 'string' && item.error) {
      out.push({ ...base, window: 'unreadable', note: item.error })
    }
  }
  return out.slice(0, SOURCE_LIMIT)
}

/**
 * 读一次真实额度源。
 *
 * 读不到**不是**错误：返回 `state: 'unavailable'` 与一句原因，让界面说「读不到真实源」。
 * 把失败翻成空数组、或者退回上下文余量去顶账，都是让人拿一个假数字做决定。
 */
export async function readQuotaSource(url: string | undefined, options: {
  fetch?: typeof fetch
  timeoutMs?: number
  now?: () => string
} = {}): Promise<QuotaSourceReading> {
  if (!url) return { state: 'unavailable', windows: [], reason: '这台机器没有配置真实额度源（CREW_QUOTA_SOURCE）' }
  const doFetch = options.fetch ?? globalThis.fetch
  const now = options.now ?? (() => new Date().toISOString())
  if (typeof doFetch !== 'function') return { state: 'unavailable', url, windows: [], reason: '这个运行时没有 fetch，读不了真实额度源' }
  try {
    const response = await doFetch(url, {
      method: 'GET', headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(options.timeoutMs ?? 4_000), redirect: 'error',
    })
    if (!response.ok) return { state: 'unavailable', url, windows: [], reason: `真实额度源回了 HTTP ${response.status}` }
    const windows = parseQuotaSource(await response.json())
    if (windows.length === 0) return { state: 'unavailable', url, windows: [], reason: '真实额度源回了空列表' }
    return { state: 'read', url, at: now(), windows, ...(windows.length >= SOURCE_LIMIT ? { truncated: true as const } : {}) }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { state: 'unavailable', url, windows: [], reason: `读真实额度源失败：${reason}` }
  }
}

/**
 * 带缓存的一次读取。
 *
 * 为什么要缓存：magpie 首次查询会去各 provider 现拉一遍窗口，实测第一发 **3.3 秒**、
 * 之后 0.12 秒。手机每开一张票都会问一次逐条用量，直接透传等于让界面等一次现拉。
 * 所以：`ttlMs` 内复用上次结果；同时只跑一发（并发的第二个请求等同一个 promise），
 * 失败也缓存一小会儿，免得源挂掉时每次刷新都白等一轮超时。
 *
 * 缓存**不改变结论**：读到就是读到，读不到就是读不到；过期的读数会被重新读一次覆盖。
 */
export class QuotaSourceReader {
  private cached: { reading: QuotaSourceReading; at: number } | undefined
  private inflight: Promise<QuotaSourceReading> | undefined
  private readonly ttlMs: number
  private readonly failureTtlMs: number

  constructor(private readonly url: () => string | undefined, private readonly options: {
    fetch?: typeof fetch
    timeoutMs?: number
    ttlMs?: number
    failureTtlMs?: number
    /** 取当前毫秒时刻；缓存寿命用它算。与读源时的 `now`（取时间字符串）分开，别混。 */
    clock?: () => number
  } = {}) {
    this.ttlMs = options.ttlMs ?? 60_000
    this.failureTtlMs = options.failureTtlMs ?? 10_000
  }

  /** 读一次（可能命中缓存）。永不抛：读不到用 `state: 'unavailable'` 回答。 */
  async read(): Promise<QuotaSourceReading> {
    const now = this.options.clock ?? Date.now
    const fresh = this.cached
    const ttl = fresh?.reading.state === 'read' ? this.ttlMs : this.failureTtlMs
    if (fresh && now() - fresh.at < ttl) return fresh.reading
    if (this.inflight) return this.inflight
    const started = this.inflight = readQuotaSource(this.url(), this.options)
      .then(reading => { this.cached = { reading, at: now() }; return reading })
      .finally(() => { this.inflight = undefined })
    return started
  }
}

/**
 * 路由名 → 真实源里的 provider 键。
 *
 * 本部署的模型路由是 `网关/provider/model`（如 `magpie/workbuddy/deepseek-v4.1-flash`），
 * 真实 provider 是**第二段**，网关只是入口。段数不够（`magpie/k3`）就没有可对的名字 ——
 * 返回 `undefined`，不拿模型名去猜一个 provider。
 */
function sourceProviderOf(route: string): string | undefined {
  const segments = route.split('/').filter(segment => segment.length > 0)
  return segments.length >= 3 ? segments[1] : undefined
}

/**
 * 真实额度的一句话：每个 provider 挑最紧的那个窗口。
 *
 * 读不到就说读不到，并带上原因 —— 「额度：读不到」比一个编出来的百分比有用。
 *
 * 给了 `route` 时，这条路由自己的 provider 排在最前面并标上 `（本票）`：一张票最该看的
 * 是它自己那条路由还剩多少，其余 provider 是背景。
 */
export function quotaSourceLine(reading: QuotaSourceReading, options: { route?: string; limit?: number } = {}): string {
  if (reading.state !== 'read') return `额度：读不到真实源（${reading.reason ?? '没有原因'}）`
  const limit = options.limit ?? 4
  const own = options.route ? sourceProviderOf(options.route) : undefined
  const tightest = new Map<string, QuotaWindow>()
  for (const window of reading.windows) {
    if (window.remaining === undefined) continue
    const seen = tightest.get(window.provider)
    if (!seen || (seen.remaining ?? 101) > window.remaining) tightest.set(window.provider, window)
  }
  const parts = [...tightest.values()]
    .sort((left, right) => left.provider === own ? -1 : right.provider === own ? 1
      : (left.remaining ?? 0) - (right.remaining ?? 0))
    .slice(0, limit)
    .map(window => `${window.provider} 剩 ${Math.round(window.remaining ?? 0)}%`
      + `${window.display ? `（${window.display}）` : ''}${window.account ? ` ${window.account}` : ''}`
      + `${window.provider === own ? '（本票）' : ''}`)
  const balances = reading.windows.filter(window => window.balance !== undefined)
    .slice(0, limit).map(window => `${window.provider} 余额 ${window.balance}`)
  const unreadable = reading.windows.filter(window => window.note !== undefined)
    .slice(0, limit).map(window => `${window.provider}：${window.note}`)
  const said = [...parts, ...balances, ...unreadable]
  return said.length === 0 ? '额度：真实源没有可报的窗口' : `额度：${said.join(' · ')}`
}

/** 12000 → 12k，1500000 → 1.5M。与桌面端 `compactTokens` 同一套写法。 */
export function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

/**
 * 一条回复底下那行小字：`magpie/k3 · 进 1.2k 出 300 · 余 120k`。
 *
 * `进` 写的是**提示词大小**（含缓存），不是未命中缓存的那几百 —— 那才是这一步真正
 * 送进模型的量，也才和 `余` 对得上。
 * 缺的项直接不写，不留占位符：一个空的「余 —」比不写更让人以为坏了。
 */
export function replyLine(spend: ReplySpend): string {
  const parts = [spend.route, `进 ${compact(spend.prompt_tokens)} 出 ${compact(spend.output_tokens)}`]
  if (spend.context_left !== undefined) parts.push(`余 ${compact(spend.context_left)}`)
  return parts.join(' · ')
}
