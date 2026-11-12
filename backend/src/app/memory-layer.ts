/**
 * 记忆层在运行时的那一层：谁写、谁读、什么时候写，以及「用中枢版还是本机版」的分叉。
 *
 * 三个入口不变：
 * - `recall(ticket, query)`：worker 上工时给一小段相关记忆（`DshExecutor.launch` 调）；
 * - `hear(trigger)`：人说的话里如果有「定下来的规矩」，记一条（`Engine.receive` 之后调）；
 * - `close(ticket)`：一票收尾时把结论记一条（`ticket.ended` 事件里调）。
 *
 * 分叉：构造时给一个 `MemoryPort` 选择器（探测在 detect.ts）。有中枢用 `HubMemory`，
 * 没有用 `LocalMemory`；中枢挂掉时 `HubMemory` 内部降级到本机，不阻塞开工。
 *
 * 三条共同的规矩：
 * 1. **只记认得出来的**。认不出来就不记 —— 账本一脏，下次召回的全是废话。
 * 2. **不上 Hub 原始对话**。上行走用户已有的 local_dream 直通源，只送筛选过的稳定事实。
 * 3. **读不到就说读不到**。返回 `''` 表示「这次没有相关记忆」，不是「记忆层坏了」。
 */
import type { Ticket, Trigger } from '../core/index.ts'
import type { Store } from './store.ts'
import type { MemoryPort } from '../memory/port.ts'
import type { MemoryEntry } from '../memory/recall.ts'
import type { Fact } from '../memory/settle.ts'
import type { UpsertResult } from '../memory/port.ts'
import { LocalMemory } from '../memory/local.ts'

export { RECALL_MAX_CHARS, RECALL_TOP_K } from '../memory/local.ts'

export interface MemoryHost {
  readonly store: Store
  /** 取几位 Bot 的名字，用于把「@ 到的人」翻成 bot_id。 */
  bots(): readonly string[]
  /** 睡眠期巩固用的提炼器（本机版）；省略则本机不提炼。 */
  distill?: (text: string, at: number) => Promise<Fact[]>
  /** 拉原始 episodic 日志给 consolidator；省略则本机巩固跳过。 */
  episodic?: (range: { since?: number; until?: number }) => { text: string; at: number }[]
  /** 记忆端口选择器：有中枢用 HubMemory，没有用 LocalMemory。省略则用本机版。 */
  port?: MemoryPort
}

/**
 * 记忆层的运行时外壳：把 `MemoryPort`（存与读写规则）接在队伍的入口事件上。
 * `Runtime` 持有它一个实例，`DshExecutor` 通过 `ExecutorHost.recall` 问它要一小片召回。
 */
export class MemoryLayer {
  /** 实际使用的端口（中枢版或本机版）。 */
  readonly port: MemoryPort
  /** 暴露账本给管理面（列表/编辑/忘记），两版都落本机账本，所以取本机实现即可。 */
  readonly ledger: LocalMemory['ledger']
  private readonly local: LocalMemory

  constructor(private readonly host: MemoryHost) {
    this.local = new LocalMemory(host)
    this.port = host.port ?? this.local
    this.ledger = this.local.ledger
  }

  recall(ticket: Ticket, query: string): Promise<string> {
    return this.port.recall(ticket, query)
  }

  hear(trigger: Pick<Trigger, 'text' | 'at' | 'actor'> & { channel?: Trigger['channel'] }): number {
    return this.port.hear(trigger)
  }

  close(ticket: Ticket): number {
    return this.port.close(ticket)
  }

  /** 供 consolidator 定时/空闲调：触发一轮睡眠期巩固。 */
  consolidate(range?: { since?: number; until?: number }): Promise<{ facts: number; merged: number; superseded: number }> {
    return this.port.consolidate(range)
  }

  upsert(botId: string, fact: Fact, origin: string, source?: MemoryEntry['source']): UpsertResult {
    return this.port.upsert(botId, fact, origin, source)
  }

  forget(name: string): boolean { return this.port.forget(name) }
  /** 末位淘汰：遗忘区里超期且没被调起的真删掉。 */
  evict(now?: number): string[] { return this.port.evict(now) }
  edit(name: string, patch: { description?: string; body?: string; importance?: number }): boolean { return this.port.edit(name, patch) }
  all(): MemoryEntry[] { return this.port.all() }
}
