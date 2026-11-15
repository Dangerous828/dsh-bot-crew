/**
 * 中枢版记忆：向量检索与睡眠期巩固都走中枢 Hub，本机只做轻量兜底。
 *
 * 关键约束（按定下的规则）：
 * - 本机不算 embedding；要语义召回就把 query 发中枢。
 * - 原始对话不上中枢；上行的只有「筛选过的稳定事实」，由 local_dream 直通链路送。
 * - 中枢不可用时降级到本机实现，不阻塞 worker 开工。
 * - **鉴权失败不是「不可用」的普通一种**：地址对、token 不对时，日志必须明确说
 *   「hub 未启用、记忆走本机」，而不是与网络故障混成一句 `degraded`。凭据错了要能查出来。
 * - **巩固的 dry-run 不算写过**：中枢默认只出合并计划，那时不能把 `merged:0`
 *   当「执行过、合并了 0 条」报给上层。
 */
import type { Ticket, Trigger } from '../core/index.ts'
import { botOf } from './local.ts'
import { compose, injectText, type MemoryEntry } from './recall.ts'
import type { Fact } from './settle.ts'
import type { ConsolidateRange, ConsolidateResult, MemoryPort, UpsertResult } from './port.ts'
import type { HubAuthSnapshot } from './auth.ts'
import { isHubAuthError } from './hub-client.ts'

/** 注入给 worker 的记忆片段最多多少字（与 local 一致，两版行为对齐）。 */
const HUB_RECALL_MAX_CHARS = 1200

/** 鉴权面的最小能力：能读状态、能标被拒/恢复。 */
export interface HubAuthHost {
  /** 现在能不能用（网络通 + 凭据没被拒）。 */
  usable(): boolean
  /** 只读状态（不含凭据值），给日志与面板。 */
  state(): HubAuthSnapshot
  /** 中枢拒了凭据。 */
  reject(status: number, detail?: string): void
  /** 中枢接受了。 */
  accept(): void
}

export interface HubMemoryHost {
  /** 中枢是否可达（探测在 detect.ts，这里只读结果）。不可达时全部走 fallback。 */
  reachable(): boolean
  /** 中枢向量检索。 */
  search?(query: string, filter: { bots?: string[]; limit?: number }): Promise<MemoryEntry[] | undefined>
  /** 触发中枢 consolidator；返回值带 `dryRun` 说明这次到底写没写。 */
  consolidate?(range: ConsolidateRange): Promise<ConsolidateResult | undefined>
  /** 鉴权面；省略时退化成「不区分鉴权失败」（老宿主与测试的兼容路径）。 */
  auth?: HubAuthHost
  /**
   * TTL 保鲜：每次记忆操作前调一次。过期就起一次单飞重探，不阻塞本次调用。
   * 这样中枢掉线再回来时能自己恢复，而不用等重启或下一个整点。
   */
  ensureFresh?(): void
  /**
   * 配置刚换、还没有任何探测结论时，等这一次探测落定（有超时上界）。
   *
   * 与 `ensureFresh` 分开：稳态下「过期」必须不阻塞（一次召回不该被网络拖着走），
   * 但**刚保存完配置**的第一次操作必须知道新配置的真实结论，否则用户看到的还是
   * 「改完没生效」—— 正是要修的症状。
   */
  ensureSettled?(): Promise<void>
  /** 降级用：中枢不可用或该能力未提供时，委托给它（本机版）。 */
  fallback: MemoryPort
}

/** 中枢版记忆端口：向量检索与睡眠期巩固走中枢，中枢不可用时降级到本机实现。 */
export class HubMemory implements MemoryPort {
  constructor(private readonly host: HubMemoryHost) {}

  /** 中枢能不能真用：可达且凭据没被拒。 */
  private up(): boolean {
    if (!this.host.reachable()) return false
    return this.host.auth ? this.host.auth.usable() : true
  }

  /**
   * 召回。中枢可达且提供了向量检索时走中枢（按意思找）；否则/失败退回本机（按字面找）。
   *
   * 中枢只回「命中的记忆条目」，拼注入片段的活复用本机那套 `compose`/`injectText`，不另写一套。
   */
  async recall(ticket: Ticket, query: string): Promise<string> {
    await this.host.ensureSettled?.()
    this.host.ensureFresh?.()
    if (!this.up() || !this.host.search) return this.host.fallback.recall(ticket, query)
    try {
      // **必须带上这张票的 bot_id**：中枢的租户隔离只到 crew 命名空间（`dsh-memory/bot`），
      // 不分 Bot。不带 `bots` 就是「整个队伍的记忆都拿来」—— lead 的注入里会混进 coder 的规矩，
      // 而且看起来完全正常（条目形状对、分数高）。本机版的召回本来就按 Bot 过滤，这里对齐。
      const bot = botOf(ticket)
      const entries = await this.host.search(query, { ...bot ? { bots: [bot] } : {}, limit: 6 })
      if (!entries || entries.length === 0) return this.host.fallback.recall(ticket, query)
      // 中枢已按相似度排好序，直接按预算拼接；命中条目记一笔「被调起」，供末位淘汰用。
      const composed = compose(entries.map(entry => ({ entry, score: 1 })), HUB_RECALL_MAX_CHARS)
      if (!composed.text) return this.host.fallback.recall(ticket, query)
      this.host.fallback.touch?.(composed.taken.map(entry => entry.name))
      console.log('[memory] recall mode=hub chars=%d taken=%s', composed.chars, JSON.stringify(composed.taken.map(e => e.name)))
      return injectText(composed)
    } catch (error) {
      this.noteFailure('search', error)
      return this.host.fallback.recall(ticket, query)
    }
  }

  /**
   * 失败分两类说：
   * - 鉴权被拒（401/403）：明确否定 —— 中枢地址是通的，但凭据不被接受，hub 未启用。
   * - 其他（超时/5xx/坏响应）：一次降级记录。
   *
   * 错误文本里的 token 由 `HubAuthError` 保证不含值（只带状态码与响应体 detail）。
   */
  private noteFailure(what: 'search' | 'consolidate', error: unknown): void {
    if (isHubAuthError(error)) {
      console.log('[memory] hub %s auth rejected (%d) — hub NOT in use, memory falls back to local; check memory.tokenEnv / memory.tokenFile',
        what, error.status)
      return
    }
    console.log('[memory] hub %s failed, degraded: %s', what, String(error))
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

  /**
   * 睡眠期巩固：**本机账本是唯一的真实写入者**，中枢只提供合并计划。
   *
   * 为什么不是「有中枢就只问中枢」：中枢兼容面默认 `apply=false`（只统计可合并对，
   * 不写），因为客户端超时只有 3s，不该拿它驱动批量软删。而本机 `LocalMemory.consolidate`
   * 才是拉 episodic → 提炼 → 落 KV 的那条路。早先的写法在中枢回了 `dryRun` 时直接 return，
   * 于是「hub 一配上，宿主机巩固写入永久停摆，而服务端一条也不写」—— 两边都没写，
   * 看起来却像成功。现在改成：先问中枢要计划（只为日志与可见性），**然后仍然跑本机提炼**，
   * 返回值里的 `facts/merged/superseded` 只报真写了的数，中枢那份读数放 `hubPlan`。
   *
   * 若将来中枢真的改成默认 `apply=true`（服务端拍板），那也是另一条路：那时中枢会写库，
   * 这里再谈「谁写」。当前契约下不能把计划当写入。
   */
  async consolidate(range: ConsolidateRange = {}): Promise<ConsolidateResult> {
    await this.host.ensureSettled?.()
    this.host.ensureFresh?.()
    let plan: ConsolidateResult['hubPlan']
    if (this.up() && this.host.consolidate) {
      try {
        const done = await this.host.consolidate(range)
        if (done) {
          plan = { facts: done.facts, merged: done.merged, superseded: done.superseded,
            dryRun: done.dryRun === true, ...done.candidates === undefined ? {} : { candidates: done.candidates } }
          console.log('[memory] consolidate hub plan facts=%d merged=%d superseded=%d dryRun=%s candidates=%d（中枢只出计划，不写库）',
            done.facts, done.merged, done.superseded, String(done.dryRun === true), done.candidates ?? 0)
        }
      } catch (error) {
        this.noteFailure('consolidate', error)
      }
    }
    // 本机照跑：账本写入只有这一条路，中枢的计划不替代它。
    const local = await this.host.fallback.consolidate(range)
    return plan ? { ...local, ...plan.dryRun ? { dryRun: true } : {}, ...plan.candidates === undefined ? {} : { candidates: plan.candidates }, hubPlan: plan } : local
  }

  forget(name: string): boolean { return this.host.fallback.forget(name) }
  evict(now?: number): string[] { return this.host.fallback.evict(now) }
  edit(name: string, patch: { description?: string; body?: string; importance?: number }): boolean { return this.host.fallback.edit(name, patch) }
  all(): MemoryEntry[] { return this.host.fallback.all() }
}
