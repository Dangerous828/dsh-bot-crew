/**
 * 记忆系统的接口层：上层只认这一套方法，底下是「中枢版」还是「本机版」由运行时按有没有 Hub 决定。
 *
 * 为什么先抽这层：记忆要按部署形态分叉 —— 有中枢就把向量检索与睡眠期巩固交给中枢，
 * 没有就全在本机做。上层（recall/settle/治理）不该知道底下是谁；抽一层接口，
 * 以后加第三种存储、或中枢升级，都不动上层。
 *
 * 方法语义见各实现（`local.ts` 本机版、`hub.ts` 中枢版）。
 */
import type { Ticket } from '../core/index.ts'
import type { Fact } from './settle.ts'
import type { MemoryEntry } from './recall.ts'

/** 召回结果：注入片段 + 取出了哪几条（供日志与测试）。 */
export interface RecalledText {
  text: string
  taken: MemoryEntry[]
  chars: number
}

/** 写一条事实的结果：真正落盘的条目、被替代的旧条目名。 */
export interface UpsertResult {
  written: MemoryEntry[]
  superseded: string[]
}

/** 一轮巩固的结果：提炼出的新事实条数、合并/冲突处理计数。 */
export interface ConsolidateResult {
  facts: number
  merged: number
  superseded: number
}

/**
 * 记忆端口。两个实现：`LocalMemory`（全本机）与 `HubMemory`（向量与巩固走中枢）。
 *
 * `who`/`at` 这类来源信息由调用方给，端口不自己猜。
 */
export interface MemoryPort {
  /** 给这张票的 worker 取一小片相关记忆，拼成注入片段。读不到返回空串（不是报错）。 */
  recall(ticket: Ticket, query: string): string
  /** 人说的话里如果有定下来的规矩，记一条；返回写进去了几条。 */
  hear(trigger: Parameters<MemoryPortSeams['hear']>[0]): number
  /** 一票收尾，把结论记一条；返回写进去了几条。 */
  close(ticket: Ticket): number
  /** 主动写一条已提炼的事实（供 consolidator 或手动调用）。 */
  upsert(botId: string, fact: Fact, origin: string, source?: MemoryEntry['source']): UpsertResult
  /** 触发一轮睡眠期巩固（把一段原始日志提炼成事实）。没中枢时本机跑，有中枢时交给中枢。 */
  consolidate(range?: ConsolidateRange): Promise<ConsolidateResult>
  /** 主人说忘掉一条。 */
  forget(name: string): boolean
  /** 主人改一条。 */
  edit(name: string, patch: { description?: string; body?: string; importance?: number }): boolean
  /** 全部条目（治理/展示用）。 */
  all(): MemoryEntry[]
}

/** 巩固的输入范围：默认「最近若干小时」。 */
export interface ConsolidateRange {
  /** 起始时间（秒，含）。省略表示按实现默认窗口。 */
  since?: number
  /** 结束时间（秒，含）。省略表示到现在。 */
  until?: number
}

/** `hear` 需要的触发字段（与现有 MemoryLayer.hear 对齐）。 */
export interface MemoryPortSeams {
  hear: (trigger: { text: string; at: string; actor: { id: string }; channel?: { address: Record<string, unknown> } }) => number
}
