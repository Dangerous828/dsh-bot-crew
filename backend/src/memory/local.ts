/**
 * 本机版记忆：全在本机完成召回与巩固，不联网、不依赖中枢。
 *
 * 行为与改造前一致（正则 settle + 二元组召回 + KV 账本），是「没有中枢」或「中枢降级」时的实现。
 * 睡眠期巩固的本地实现按「要」的决定做：调用一次便宜模型提炼，见 `consolidate()`。
 */
import type { Ticket, Trigger } from '../core/index.ts'
import { MemoryLedger, type SettleInput } from '../app/memory.ts'
import type { Store } from '../app/store.ts'
import { compose, injectText, rank } from './recall.ts'
import { factOfFinishedTicket, factOfPersonMessage, type Fact } from './settle.ts'
import type { ConsolidateRange, ConsolidateResult, MemoryPort, RecalledText, UpsertResult } from './port.ts'
import type { MemoryEntry } from './recall.ts'

/** 注入给 worker 的记忆片段最多多少字。够放 5–8 条，又远小于一次重放历史。 */
export const RECALL_MAX_CHARS = 1200
/** 一次取几条。 */
export const RECALL_TOP_K = 6

export interface LocalMemoryHost {
  readonly store: Store
  /** 取几位 Bot 的名字，用于把「@ 到的人」翻成 bot_id。 */
  bots(): readonly string[]
  /**
   * 睡眠期巩固用的提炼器：给一段原始文本，产出结构化事实。
   * 取决于部署：有 provider 便宜模型就用它；测试里注入假实现。省略则不提炼（只靠正则 settle）。
   */
  distill?: (text: string, at: number) => Promise<Fact[]>
  /** 拉一段原始 episodic 日志给 consolidator（没给就跳过巩固）。 */
  episodic?: (range: ConsolidateRange) => { text: string; at: number }[]
}

/** 一张票归哪位 Bot：票的通道地址里带着 bot_id，取不到就归默认那位。 */
export function botOf(ticket: Pick<Ticket, 'channels'>): string {
  return String((ticket.channels[0]?.address as { bot_id?: unknown } | undefined)?.bot_id ?? '')
}

const atSeconds = (iso: string): number => Math.floor(Date.parse(iso) / 1000) || Math.floor(Date.now() / 1000)

/** 本机版记忆端口：召回、写账、睡眠期巩固全在本机完成，不依赖中枢。 */
export class LocalMemory implements MemoryPort {
  readonly ledger: MemoryLedger
  constructor(private readonly host: LocalMemoryHost) {
    this.ledger = new MemoryLedger(host.store)
  }

  recall(ticket: Ticket, query: string): string {
    const bot = botOf(ticket)
    const own = rank(this.ledger.all(), query, { bots: bot ? [bot] : [], topK: RECALL_TOP_K })
    const seen = new Set(own.map(hit => hit.entry.name))
    const others = rank(this.ledger.all(), query, { topK: RECALL_TOP_K }).filter(hit => !seen.has(hit.entry.name))
    const composed = compose([...own, ...others], RECALL_MAX_CHARS)
    if (!composed.text) return ''
    console.log('[memory] recall mode=local bot=%s chars=%d taken=%s', bot || '-', composed.chars,
      JSON.stringify(composed.taken.map(entry => entry.name)))
    return injectText(composed)
  }

  hear(trigger: Pick<Trigger, 'text' | 'at' | 'actor'> & { channel?: Trigger['channel'] }): number {
    const at = atSeconds(trigger.at)
    const fact = factOfPersonMessage(trigger.text, at)
    if (!fact) return 0
    const bot = String((trigger.channel?.address as { bot_id?: unknown } | undefined)?.bot_id ?? '')
    const owner = bot || this.host.bots()[0] || 'lead'
    const result = this.upsert(owner, fact, `person:${trigger.actor.id}`, { at: trigger.at })
    if (result.written.length) console.log('[memory] settle source=person bot=%s key=%s', owner, fact.dedupe_key)
    return result.written.length
  }

  close(ticket: Ticket): number {
    const report = ticket.assignments.findLast(assignment => assignment.report)?.report
    if (!report) return 0
    const at = atSeconds(report.at)
    const bot = botOf(ticket)
    const fact = factOfFinishedTicket({ id: ticket.id, title: ticket.title, bot_id: bot || undefined }, report, at)
    if (!fact) return 0
    const result = this.upsert(bot || this.host.bots()[0] || 'lead', fact, `ticket:${ticket.id}`, { ticket_id: ticket.id, at: report.at })
    if (result.written.length) console.log('[memory] settle source=ticket ticket=%s bot=%s', ticket.id, bot || '-')
    return result.written.length
  }

  upsert(botId: string, fact: Fact, origin: string, source?: MemoryEntry['source']): UpsertResult {
    const input: SettleInput = { bot_id: botId, fact, origin, ...(source ? { source } : {}) }
    return this.ledger.settle(input)
  }

  /**
   * 睡眠期巩固（本机版，按「要」的决定）：拉一段原始日志，用便宜模型提炼成事实，与账本合并。
   *
   * 没配 `distill` 或 `episodic` 时什么都不做（返回 0）—— 不假装整理过。
   * 粗筛省成本：只有拉到的文本非空且够长才调动模型。
   */
  async consolidate(range: ConsolidateRange = {}): Promise<ConsolidateResult> {
    const result: ConsolidateResult = { facts: 0, merged: 0, superseded: 0 }
    if (!this.host.distill || !this.host.episodic) return result
    const batches = this.host.episodic(range)
    const owner = this.host.bots()[0] || 'lead'
    for (const batch of batches) {
      const text = batch.text.trim()
      // 粗筛：太短的多半是一句闲聊，不值得花一次模型调用。
      if (text.length < 40) continue
      let facts: Fact[]
      try { facts = await this.host.distill(text, batch.at) } catch (error) {
        console.log('[memory] consolidate distill failed: %s', String(error)); continue
      }
      for (const fact of facts) {
        const written = this.upsert(owner, fact, 'host:consolidate', { at: new Date(batch.at * 1000).toISOString() })
        if (written.written.length) result.facts += 1
        result.superseded += written.superseded.length
      }
    }
    if (result.facts) console.log('[memory] consolidate mode=local facts=%d superseded=%d', result.facts, result.superseded)
    return result
  }

  forget(name: string): boolean { return this.ledger.forget(name) }
  edit(name: string, patch: { description?: string; body?: string; importance?: number }): boolean { return this.ledger.edit(name, patch) }
  all(): MemoryEntry[] { return this.ledger.all() }
}
