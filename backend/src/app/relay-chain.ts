/**
 * 出门之后那条路：一条按代价排序的降级链。
 *
 * 需求说的是「relay 的中转再做一个作为兜底」。这里实现的不是「两条一模一样的隧道」——
 * 那样兜底与被兜底会同时遭遇同一种故障（比如自建中转的机房整体不可达，两个地址都在那台
 * NAS 上就一起死）。真正的兜底必须**与它失败的原因不相干**。所以是三条不同性质的路：
 *
 *   lan（局域网直连，已存在）
 *     同 Wi-Fi、同一台路由器。零公网依赖、延迟最低。代价：出了门就不存在，手机换了网络就断。
 *
 *   relay.self（自建中转，relay/ 那个服务）
 *     宿主出站连 NAS 上的中转，手机从中转进来。代价：整条链路都压在那台 NAS 与它的公网上行；
 *     家里断网、NAS 关机、宽带抖动，这条路就没了。
 *
 *   relay.fallback（第二条中转：任何**不在同一故障域**的 relay 实例）
 *     比如 Cloudflare Tunnel 的后端、或另一台云主机上的同一个 relay/ 镜像。
 *     代价：多一跳、受第三方限流（Cloudflare quick tunnel 的 URL 每次重启都变、还限并发），
 *     而且数据经过别人的基础设施 —— 所以它是最后才用的那一条。
 *
 * 为什么不是「再加一个协议」：写一个 HTTP 长轮询兜底通道看起来更像「另一条路」，但它会引入
 * 第二套语义（消息顺序、取消、流式），两套语义一旦不同步，bug 会出现在最难复现的那个组合里。
 * 同一个协议、换一个落地，兜底要解决的是「那个落地点在哪」，不是「再发明一套线格式」。
 *
 * 顺序与代价写在这里，是为了让「为什么先试这条」有唯一答案。
 */

/** 一条路是什么性质。面板与日志用它能说出「现在是哪一档在扛」。 */
export type RelayKind = 'lan' | 'relay' | 'fallback'

export interface RelayRoute {
  name: string
  kind: RelayKind
  /** 这条路此刻通不通。出错与返回 false 同义：都是「现在别用它」。 */
  reachable(): Promise<boolean> | boolean
}

export interface ChainOptions {
  routes: RelayRoute[]
  /** 单次探测的上限。公网上最常见的故障就是「连上了但不回」。 */
  probeTimeoutMs?: number
}

export interface ChainStatus {
  active?: string
  routes: { name: string; kind: RelayKind; reachable: boolean; active: boolean }[]
}

export interface Chain {
  /**
   * 现在该走哪条。返回 undefined 表示一条都不通 —— 这是「此刻的处境」，不是错误。
   * `refresh: true` 时忽略记忆、从最便宜的那条重新探。
   */
  choose(options?: { refresh?: boolean }): Promise<RelayRoute | undefined>
  /** 某条路坏了：下次 choose 会重新探。 */
  invalidate(name: string): void
  /** 整条链的状态，给面板与排障用。 */
  status(): Promise<ChainStatus>
}

const DEFAULT_PROBE_TIMEOUT_MS = 2_000

export function createChain(options: ChainOptions): Chain {
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  /** 上一次选中的那条：钉住它，免得每次请求都重新握手一遍。 */
  let active: string | undefined

  async function probe(route: RelayRoute): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined
    try {
      // 探测本身也要有上限。不设的话，SYN 超时（常见的 20–130 秒）会把整条链挂在第一档。
      const timeout = new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(false), probeTimeoutMs)
        timer.unref?.()
      })
      // reachable() 可能**同步**抛（DNS 解析、URL 解析）。`Promise.resolve(fn()).catch` 接不住
      // 同步抛的那一下 —— 异常在 Promise 被建立之前就飞出来了。所以包一层 async。
      const attempt = (async () => await route.reachable())().catch(() => false)
      return await Promise.race([attempt, timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  return {
    async choose(choice = {}) {
      // 记住的那条还在，就不重新探：探测本身是一次网络往返。
      if (!choice.refresh && active) {
        const kept = options.routes.find(route => route.name === active)
        if (kept && await probe(kept)) return kept
      }
      active = undefined
      for (const route of options.routes) {
        if (!await probe(route)) continue
        active = route.name
        return route
      }
      return undefined
    },
    invalidate(name) {
      // 无论坏掉的是不是当前这条，记忆都要清掉：链的顺序是「从便宜的往贵的试」，
      // 而坏掉的那条可能已经在下一轮里被别的路顶替了。留着记忆会让下一次 choose 直接复用它。
      if (active === name || !name) active = undefined
    },
    async status() {
      // status 每次都真的探一遍：面板要的是「此刻」，不是「上次」。并发探测，不是串行。
      const results = await Promise.all(options.routes.map(async route => ({
        name: route.name, kind: route.kind, reachable: await probe(route), active: route.name === active,
      })))
      return { ...(active ? { active } : {}), routes: results }
    },
  }
}

/**
 * 局域网这一档存在不存在。
 *
 * 判据是「有没有东西应答」，不是「应答是不是 200」：消息面在没配对时回 401，
 * 而 401 恰恰说明这条路是通的。
 */
export async function lanReachable(url: string, timeoutMs = 1_000): Promise<boolean> {
  try {
    await fetch(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs), redirect: 'error' })
    return true
  } catch {
    return false
  }
}

export interface RelayTarget { name: string; url: string }

/**
 * 从环境变量里读中转列表，第一条件自建，其余当兜底。
 *
 * `http://` 的地址在这里就剔掉：由 `new WebSocket()` 去报错的话，症状是「隧道一直重连、
 * 日志里只有一句 socket error」，而部署时打错一个协议头是最常见的手误。
 */
export function parseRelayCandidates(raw: string | undefined): RelayTarget[] {
  if (!raw) return []
  const targets: RelayTarget[] = []
  for (const piece of raw.split(',')) {
    const url = piece.trim()
    if (!url) continue
    if (!/^wss?:\/\//i.test(url)) continue
    targets.push({ name: targets.length === 0 ? 'relay.self' : 'relay.fallback', url })
  }
  return targets
}
