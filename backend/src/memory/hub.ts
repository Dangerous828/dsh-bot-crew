/**
 * 中枢版记忆：向量检索与睡眠期巩固都走中枢 Hub，本机只做轻量兜底。
 *
 * 第 1 步（当前）：搭骨架。中枢还没升级出「向量检索 / consolidator」接口，
 * 所以召回与巩固暂时委托给注入的本机实现（`fallback`）——行为与改造前一致，
 * 不改变任何现有结论。等中枢侧接口定了，把标了 TODO(hub) 的地方换成真实 Hub 调用即可，
 * 上层与测试都不用动。
 *
 * 关键约束（按定下的规则）：
 * - 本机不算 embedding；要语义召回就把 query 发中枢。
 * - 原始对话不上中枢；上行的只有「筛选过的稳定事实」，由 local_dream 直通链路送。
 * - 中枢不可用时降级到本机实现，不阻塞 worker 开工。
 */
import type { Ticket, Trigger } from '../core/index.ts'
import type { Fact } from './settle.ts'
import type { ConsolidateRange, ConsolidateResult, MemoryPort, UpsertResult } from './port.ts'
import type { MemoryEntry } from './recall.ts'

export interface HubMemoryHost {
  /** 中枢是否可达（探测在 detect.ts，这里只读结果）。不可达时全部走 fallback。 */
  reachable(): boolean
  /** 中枢向量检索。TODO(hub)：中枢接口未定，本步先不用；定了在这里接。 */
  search?(query: string, filter: { bots?: string[]; limit?: number }): Promise<MemoryEntry[] | undefined>
  /** 触发中枢 consolidator。TODO(hub)：中枢接口未定。 */
  consolidate?(range: ConsolidateRange): Promise<ConsolidateResult | undefined>
  /** 降级用：中枢不可用或该能力未提供时，委托给它（本机版）。 */
  fallback: MemoryPort
}

/** 中枢版记忆端口：向量检索与睡眠期巩固走中枢，中枢不可用时降级到本机实现。 */
export class HubMemory implements MemoryPort {
  constructor(private readonly host: HubMemoryHost) {}

  /**
   * 召回。第 1 步统一走本机兜底（行为与改造前一致）。
   *
   * TODO(hub)：当 `reachable()` 且 `search` 可用时，用中枢向量检索替换本机二元组召回；
   * 拿到的 entries 用 `compose()`/`injectText()` 拼成注入片段（复用 recall.ts，别另写一套）。
   */
  recall(ticket: Ticket, query: string): string {
    return this.host.fallback.recall(ticket, query)
  }

  hear(trigger: Pick<Trigger, 'text' | 'at' | 'actor'> & { channel?: Trigger['channel'] }): number {
    return this.host.fallback.hear(trigger)
  }

  close(ticket: Ticket): number {
    return this.host.fallback.close(ticket)
  }

  upsert(botId: string, fact: Fact, origin: string, source?: MemoryEntry['source']): UpsertResult {
    // 本机落账本永远发生；上行到中枢由 local_dream 直通链路按分流规则处理，不在这里同步发。
    return this.host.fallback.upsert(botId, fact, origin, source)
  }

  /** 睡眠期巩固优先交中枢；中枢不可用/未提供则本机跑。 */
  async consolidate(range: ConsolidateRange = {}): Promise<ConsolidateResult> {
    if (this.host.reachable() && this.host.consolidate) {
      try {
        const done = await this.host.consolidate(range)
        if (done) return done
      } catch (error) {
        console.log('[memory] hub consolidate failed, degraded: %s', String(error))
      }
    }
    return this.host.fallback.consolidate(range)
  }

  forget(name: string): boolean { return this.host.fallback.forget(name) }
  edit(name: string, patch: { description?: string; body?: string; importance?: number }): boolean { return this.host.fallback.edit(name, patch) }
  all(): MemoryEntry[] { return this.host.fallback.all() }
}
