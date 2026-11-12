/**
 * 记忆中枢的探测与降级：决定这一轮记忆走中枢版还是本机版。
 *
 * 判定规则：
 * - 配置里 hub 地址为空 → 从来没有中枢，用本机版，不探测（省一次网络）。
 * - 配了地址 → 探测 `GET <hub>/health`（短超时）；通就用中枢版，不通就用本机版。
 * - 探测结果带 TTL 缓存：不用每次召回都打一次网络；过期的下一次调用现探。
 * - 中枢「能用」是一个软状态：探测通不代表每次检索都成功，调用侧失败仍降级本机（见 hub.ts）。
 *
 * 这里不做任何记忆读写，只回答「现在有没有中枢」，并据此构造 `MemoryPort`。
 */
import { HubMemory } from './hub.ts'
import { LocalMemory, type LocalMemoryHost } from './local.ts'
import type { MemoryPort } from './port.ts'

export interface DetectOptions {
  /** 中枢基址；空串表示没有中枢。 */
  hub: string
  /** 探测超时（毫秒）。 */
  timeoutMs: number
  /** 探测结果缓存多久（毫秒）；默认 30 秒。 */
  ttlMs?: number
  /** 探测函数，默认 fetch `<hub>/health`；测试可注入。返回是否可达。 */
  probe?: (url: string, timeoutMs: number) => Promise<boolean>
  /** 日志。 */
  log?: (line: string) => void
}

/** 默认探测：GET <hub>/health，2xx 即可达；任何异常都当不可达。 */
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
 * `refresh()` 现探并刷新缓存。构造时可传 `initial` 免得第一次调用前没有结论。
 */
export class HubProbe {
  private last: boolean
  private at: number
  constructor(private readonly options: DetectOptions) {
    this.last = false
    this.at = 0
  }

  /** 现在有没有中枢（读缓存；从没探过 = 没有）。 */
  reachable(): boolean {
    if (!this.options.hub) return false
    return this.last
  }

  /** 现探一次并更新缓存，返回是否可达。hub 为空时直接返回 false 不探测。 */
  async refresh(now = Date.now()): Promise<boolean> {
    if (!this.options.hub) { this.last = false; this.at = now; return false }
    const ttl = this.options.ttlMs ?? 30_000
    if (this.at && now - this.at < ttl) return this.last
    const probe = this.options.probe ?? defaultProbe
    const url = this.options.hub.replace(/\/+$/, '') + '/health'
    const up = await probe(url, this.options.timeoutMs)
    if (up !== this.last) this.options.log?.(`[memory] hub ${up ? 'reached' : 'unreachable'} (${this.options.hub})`)
    this.last = up
    this.at = now
    return up
  }
}

/**
 * 按探测结果构造记忆端口：有中枢用 `HubMemory`（内部仍降级到 `local`），
 * 没有中枢直接用 `LocalMemory`。两版共用同一个本机账本，管理面看到的是同一批条目。
 */
export function pickMemoryPort(local: LocalMemory, probe: HubProbe): MemoryPort {
  return new HubMemory({ reachable: () => probe.reachable(), fallback: local })
}

export { LocalMemory, type LocalMemoryHost }
