/**
 * 记忆中枢的探测与降级：决定这一轮记忆走中枢版还是本机版。
 *
 * 判定规则：
 * - 配置里 hub 地址为空 → 从来没有中枢，用本机版，不探测（省一次网络）。
 * - 配了地址 → 探测 `GET <hub>/health`（短超时、**不带 token**，探针就该免鉴权）；通就进中枢版。
 * - 探测结果带 TTL 缓存：不用每次召回都打一次网络；过期的下一次调用现探。
 * - **探测通 ≠ 中枢可用**：`/health` 免鉴权，401 只会出现在真正调 `/memory/*` 的时候。
 *   所以「鉴权被拒」是一个独立状态（`HubAuth`），调用侧一旦拿到 401 就把 hub 标成 rejected，
 *   日志明确说「hub 未启用」，不再同时留着 `hub reached` 那种误导性的成功字样。
 * - 中枢「能用」是一个软状态：探测通不代表每次检索都成功，调用侧失败仍降级本机（见 hub.ts）。
 *
 * 这里不做任何记忆读写，只回答「现在有没有中枢、能不能用」，并据此构造 `MemoryPort`。
 */
import { HubAuth, type HubAuthOptions, type HubAuthSnapshot, type HubTokenRef } from './auth.ts'
import { HubMemory } from './hub.ts'
import { HubHttp, hubBots } from './hub-client.ts'
import { LocalMemory, type LocalMemoryHost } from './local.ts'
import type { MemoryPort } from './port.ts'

export interface DetectOptions {
  /** 中枢基址（含 `/v1`）；空串表示没有中枢。 */
  hub: string
  /** 探测超时（毫秒）。 */
  timeoutMs: number
  /** 探测结果缓存多久（毫秒）；默认 30 秒。 */
  ttlMs?: number
  /** 凭据引用（环境变量名 / 凭据文件路径），空表示不带 header。 */
  token?: HubTokenRef
  /** 凭据读取的注入点（测试用）。 */
  tokenIo?: Omit<HubAuthOptions, 'log' | 'label'>
  /** 鉴权状态变化（面板/health 面据此刷新，不必等下一次召回）。 */
  onAuthChange?: (snapshot: HubAuthSnapshot) => void
  /**
   * 可达性变化（健康面要能说「中枢不可达」，不能只在鉴权变化时刷新）。
   *
   * 三态：`up` / `down` / `unknown`。`unknown` 只出现在「配置刚换、还没探完」——
   * 那时诚实的答案是「正在探测」，而不是沿用上一个中枢的读数（那是状态分裂）。
   */
  onReachChange?: (reach: ReachState) => void
  /** 探测函数，默认 fetch `<hub>/health`；测试可注入。返回是否可达。 */
  probe?: (url: string, timeoutMs: number) => Promise<boolean>
  /** 日志。 */
  log?: (line: string) => void
}

/** 探测结论：还没探过 / 通了 / 不通。 */
export type ReachState = 'up' | 'down' | 'unknown'

/** 默认探测：GET <hub>/health，2xx 即可达；任何异常都当不可达。**不带 token**。 */
async function defaultProbe(url: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { method: 'GET', signal: controller.signal })
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 中枢可达性探测器：带 TTL 缓存。`reachable()` 是同步的（读缓存初值，未探过即视为不可达）；
 * `refresh()` 现探并刷新缓存。
 *
 * 鉴权状态与可达性是**两个**维度：`reachable()` 回答「网络通不通」，
 * `authState()` 回答「token 有没有、中枢认不认」。`usable()` 是两者的合取。
 */
export class HubProbe {
  private last: boolean
  private at: number
  private readonly auth: HubAuth
  /** 当前生效的配置（`retarget` 换的就是这一份，不是构造期捕获的那一份）。 */
  private config: { hub: string; timeoutMs: number }
  /**
   * 配置代数：每换一次配置 +1。迟到的探测结果带着旧代数回来，一律丢弃 ——
   * 否则换中枢后，旧中枢那次超时会把新配置的健康面写成「不可达」，看起来像新中枢坏了。
   */
  private generation = 0
  /**
   * 正在跑的那次探测。
   *
   * 为什么要有它：TTL 过期后如果每个调用方各自 fire-and-forget 探一次，一次召回就可能
   * 并发打 N 个 `/health`，中枢一慢就变成自我加压。单飞（single-flight）让同一时刻
   * 只有一个探测在跑，其余调用方共用它的结果。
   */
  private inflight?: Promise<boolean>
  constructor(private readonly options: DetectOptions) {
    // 构造期只取初值；之后 hub / timeout / 凭据引用都由 `retarget` 换，`options` 里的
    // 那一份**不再是真相**（ttl / probe / log 这些与配置无关的仍留在 options）。
    this.config = { hub: options.hub, timeoutMs: options.timeoutMs }
    this.last = false
    this.at = 0
    this.auth = new HubAuth(options.token ?? {}, { ...options.tokenIo, log: options.log, label: options.hub,
      ...options.onAuthChange ? { onChange: options.onAuthChange } : {} })
  }

  /**
   * 换一套配置（hub 地址 / 超时 / 凭据引用），并立刻按新配置重探一次。
   *
   * 为什么整套一起换：地址、超时、凭据是**同一份配置**的三个字段。只改其中一个对象
   * （比如只把 `HubHttp.base` 换掉、`HubProbe` 还认旧地址）会让状态分裂 ——
   * 探测打旧中枢、检索打新中枢、health 又是第三份读数，事后谁也说不清哪个是真的。
   *
   * 旧的一次探测还在飞时也不取消它（fetch 已经发出去了），但它的结果会因为代数过期被丢弃，
   * 且不会清掉新配置刚起的单飞句柄。
   */
  retarget(next: { hub: string; timeoutMs: number; token: HubTokenRef }, now = Date.now()): void {
    this.config = { hub: next.hub, timeoutMs: next.timeoutMs }
    this.generation += 1
    // 保存配置是明确的「现在就生效」：缓存结论一律作废，哪怕地址和超时没变
    // （凭据引用变了同样要重探，否则新 token 得等到下一个 TTL 才被试到）。
    this.last = false
    this.at = 0
    this.inflight = undefined
    // 先把「旧结论作废」发出去，再动凭据：否则 `auth.retarget` 里那次 refresh 的
    // 状态回调会带着上一个中枢的可达性一起播出去（一瞬的错读数也不该有）。
    this.options.onReachChange?.(this.config.hub ? 'unknown' : 'up')
    this.auth.retarget(next.token, next.hub)
    // 不在保存路径上等网络：探测有它自己的超时上界，等在这里只会让「保存设置」卡住。
    // 真正的结论由 `ensureSettled()` 在**下一次记忆操作**时兑现（那次本来就该知道答案）。
    void this.refresh(now).catch(() => false)
  }

  /** 网络层有没有中枢（读缓存；从没探过 = 没有）。 */
  reachable(): boolean {
    if (!this.config.hub) return false
    return this.last
  }

  /** 中枢现在能不能真用：网络可达且凭据没被拒。 */
  usable(): boolean {
    return this.reachable() && this.auth.usable()
  }

  /** 中枢基址（去尾斜杠）；没配就是空串。给 HTTP 客户端拼路径用。 */
  base(): string {
    return this.config.hub.replace(/\/+$/, '')
  }

  /** 单次探测/请求的超时（毫秒），与探测用同一个上限。 */
  timeoutMs(): number {
    return this.config.timeoutMs
  }

  /** 当前配置里的 hub（未去尾斜杠，给日志与健康面用）。 */
  hub(): string { return this.config.hub }

  /** 鉴权状态（不含凭据值）：面板/doctor/日志都读这一份。 */
  authState(): HubAuthSnapshot { return this.auth.snapshot() }

  /** 请求要用的 token（空串 = 不带 header）。 */
  token(): string { return this.auth.token() }

  /** 中枢拒绝了凭据：之后 `usable()` 为 false，日志明确否定。 */
  rejectAuth(status: number, detail?: string): void { this.auth.reject(status, detail) }

  /** 一次请求成功：清掉「被拒」。 */
  acceptAuth(): void { this.auth.accept() }

  /** TTL 还没到（或从没探过但刚探过）—— 只读缓存，不打网络。 */
  private fresh(now: number): boolean {
    const ttl = this.options.ttlMs ?? 30_000
    return Boolean(this.at) && now - this.at < ttl
  }

  /**
   * 现探一次并更新缓存，返回是否可达。hub 为空时直接返回 false 不探测。
   *
   * 单飞：同一时刻只有一个探测在跑，并发调用共用同一个 Promise。TTL 内直接回缓存。
   */
  async refresh(now = Date.now()): Promise<boolean> {
    if (!this.config.hub) { this.last = false; this.at = now; return false }
    // 已有探测在跑：先等它，再判断这次调用是否还需要新的一次。
    // 直接 return inflight 会让「调用方明确要求按 now 重探」拿到上一轮的结果 ——
    // 换对了 token 却仍被判 rejected，就得等下一次 TTL，恢复被推迟一整个周期。
    if (this.inflight) {
      await this.inflight.catch(() => false)
      if (this.fresh(now)) return this.last
    }
    if (this.fresh(now)) return this.last
    const generation = this.generation
    const run = this.probeOnce(now, generation)
    this.inflight = run
    try { return await run } finally { if (this.inflight === run) this.inflight = undefined }
  }

  /**
   * 等**已经在飞**的那次探测落定（没有就立刻返回）。
   *
   * 为什么需要它：配置刚保存完的那一次召回，如果直接按 `reachable()=false` 降级本机，
   * 用户看到的仍是「改完没生效」—— 正是要修的那个症状。
   *
   * 为什么只等已有的、不新起一次：`at === 0` 只出现在「刚启动」与「刚保存完配置」，
   * 而这两种情况下探测**本来就已经发出去了**（构造器与 `retarget` 各自起了一次单飞）。
   * 等同一个 Promise 不额外打网络；没有在飞的探测就立刻返回，稳态召回永不被网络拖住。
   *
   * 为什么还要再压一个上限：探测自己的上界是 `timeoutMs`（默认 8s），而召回在 worker
   * 上工路径上。中枢被黑洞（丢包不拒连）时，刚启动的第一次召回不该陪着等 8 秒 ——
   * 那会把「hub 慢」变成「开工慢」。超过这个预算就按当前结论走（通常是降级本机），
   * 探测仍在后台跑完并更新 health，一次调用受影响，不是永久状态。
   */
  async ensureSettled(): Promise<void> {
    if (!this.inflight) return
    const budget = 1_000
    let timer: ReturnType<typeof setTimeout> | undefined
    const capped = new Promise<void>(resolve => { timer = setTimeout(resolve, budget) })
    try { await Promise.race([this.inflight.catch(() => false), capped]) } finally { clearTimeout(timer) }
  }

  /**
   * 同步检查 TTL：过期就**起一次**单飞重探，不等结果。
   *
   * 调用方（召回/巩固）用它做「顺手保鲜」：中枢掉线再回来时，下一次记忆操作就会
   * 重新探测并恢复，不必等重启；并发调用不会各自探一次。
   */
  ensureFresh(now = Date.now()): void {
    if (!this.config.hub || this.inflight || this.fresh(now)) return
    void this.refresh(now).catch(() => undefined)
  }

  private async probeOnce(now: number, generation: number): Promise<boolean> {
    // 每轮重探顺手重读一次凭据：换对了 token 不必重启就能恢复。
    this.auth.refresh()
    const probe = this.options.probe ?? defaultProbe
    const hub = this.config.hub
    const url = hub.replace(/\/+$/, '') + '/health'
    let up = false
    try { up = await probe(url, this.config.timeoutMs) } catch { up = false }
    // 迟到的结果：配置已经换过（`retarget` 加过代数），这次结论对当前配置无效。
    if (generation !== this.generation) return this.last
    if (up !== this.last) this.options.log?.(`[memory] hub ${up ? 'reached' : 'unreachable'} (${hub})`)
    this.last = up
    this.at = now
    this.options.onReachChange?.(up ? 'up' : 'down')
    if (up) this.reportUsability()
    return up
  }

  /** 探测通但凭据不对时，把「通但不可用」一次说清（比日志里只留 reached 有用）。 */
  private reportUsability(): void {
    if (this.auth.usable()) return
    const snapshot = this.auth.snapshot()
    this.options.log?.(`[memory] hub reached but NOT usable: auth ${snapshot.state}`
      + `${snapshot.status === undefined ? '' : ` (${snapshot.status})`}${snapshot.problem ? ` — ${snapshot.problem}` : ''}`)
  }
}

/**
 * 按探测结果构造记忆端口：有中枢用 `HubMemory`（内部仍降级到 `local`），
 * 没有中枢直接用 `LocalMemory`。两版共用同一个本机账本，管理面看到的是同一批条目。
 */
export function pickMemoryPort(local: LocalMemory, probe: HubProbe): MemoryPort {
  // 中枢可达时，检索与巩固走真实 HTTP（契约 08）；不可达或调用失败由 HubMemory 内部降级本机。
  // base / timeout / token 都传函数：配置改完当场生效，不必重建端口；值也不挂在客户端对象上。
  const client = new HubHttp({ base: () => probe.base(), timeoutMs: () => probe.timeoutMs(),
    token: () => probe.token(),
    onAuthRejected: (status, detail) => probe.rejectAuth(status, detail),
    onAccepted: () => probe.acceptAuth() })
  return new HubMemory({
    reachable: () => probe.reachable(),
    search: (query, filter) => {
      // 宿主机允许的 bot_id 比中枢宽（`_lead`、65 字符的 id 都合法）。原样发过去会整次 422、
      // 整轮召回降级本机，且看不出是哪一位的问题。这里按服务端口径过滤：
      // 有可用的就只发可用的；一个都不认得就直接降级本机（不发明「不带 bots」的宽查询，
      // 那会把别的 Bot 的记忆也召回进来）。
      const bots = filter.bots ? hubBots(filter.bots) : undefined
      if (filter.bots?.length && !bots?.length) {
        throw new Error(`no bot_id accepted by the hub (server allows /^[a-z0-9][a-z0-9_-]{0,63}$/): ${filter.bots.join(',')}`)
      }
      return client.search({ query, ...bots?.length ? { bots } : {}, ...(filter.limit ? { limit: filter.limit } : {}) })
    },
    consolidate: range => client.consolidate(range),
    auth: {
      usable: () => probe.usable(),
      state: () => probe.authState(),
      reject: (status, detail) => probe.rejectAuth(status, detail),
      accept: () => probe.acceptAuth(),
    },
    ensureFresh: () => probe.ensureFresh(),
    ensureSettled: () => probe.ensureSettled(),
    fallback: local,
  })
}

export { LocalMemory, type LocalMemoryHost }
