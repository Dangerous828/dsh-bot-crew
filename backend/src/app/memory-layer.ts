/**
 * 记忆层在运行时的那一层：谁写、谁读、什么时候写。
 *
 * 三个入口：
 * - `recall(ticket, query)`：worker 上工时给一小段相关记忆（`DshExecutor.launch` 调）；
 * - `hear(trigger)`：人说的话里如果有「定下来的规矩」，记一条（`Engine.receive` 之后调）；
 * - `close(ticket)`：一票收尾时把结论记一条（`ticket.ended` 事件里调）。
 *
 * 三条共同的规矩：
 * 1. **只记认得出来的**。认不出来就不记 —— 账本一脏，下次召回的全是废话。
 * 2. **不上 Hub**。本地一条都不上行，上行走用户已有的 local_dream 直通源。
 * 3. **读不到就说读不到**。返回 `''` 表示「这次没有相关记忆」，不是「记忆层坏了」。
 */
import type { Ticket, Trigger } from '../core/index.ts'
import { MemoryLedger } from './memory.ts'
import { compose, injectText, rank } from '../memory/recall.ts'
import { factOfFinishedTicket, factOfPersonMessage } from '../memory/settle.ts'
import type { Store } from './store.ts'

/** 注入给 worker 的记忆片段最多多少字。够放 5–8 条，又远小于一次重放历史。 */
export const RECALL_MAX_CHARS = 1200
/** 一次取几条。 */
export const RECALL_TOP_K = 6

export interface MemoryHost {
  readonly store: Store
  /** 取几位 Bot 的名字，用于把「@ 到的人」翻成 bot_id。 */
  bots(): readonly string[]
}

/** 一张票归哪位 Bot：票的通道地址里带着 bot_id，取不到就归默认那位。 */
export function botOf(ticket: Pick<Ticket, 'channels'>): string {
  return String((ticket.channels[0]?.address as { bot_id?: unknown } | undefined)?.bot_id ?? '')
}

/**
 * 记忆层的运行时外壳：把 `MemoryLedger`（存）与 `recall` / `settle`（读写规则）接在队伍的入口事件上。
 * `Runtime` 持有它一个实例，`DshExecutor` 通过 `ExecutorHost.recall` 问它要一小片召回。
 */
export class MemoryLayer {
  readonly ledger: MemoryLedger
  constructor(private readonly host: MemoryHost) {
    this.ledger = new MemoryLedger(host.store)
  }

  /**
   * 给这张票的 worker 取一小片记忆。
   *
   * 先在这位 Bot 的命名空间里找；这位自己没记过什么，再放宽到全队 —— 主人定的规矩属于整个队伍，
   * 不该因为「这票派给了新来的」就集体失忆。
   */
  recall(ticket: Ticket, query: string): string {
    const bot = botOf(ticket)
    const own = rank(this.ledger.all(), query, { bots: bot ? [bot] : [], topK: RECALL_TOP_K })
    const seen = new Set(own.map(hit => hit.entry.name))
    const others = rank(this.ledger.all(), query, { topK: RECALL_TOP_K }).filter(hit => !seen.has(hit.entry.name))
    const composed = compose([...own, ...others], RECALL_MAX_CHARS)
    if (!composed.text) return ''
    // 一行日志：取出了哪几条、占多少字。召回是静默的，没这行日志就「不知道它为什么这么说」。
    console.log('[memory] recall bot=%s chars=%d taken=%s', bot || '-', composed.chars,
      JSON.stringify(composed.taken.map(entry => entry.name)))
    return injectText(composed)
  }

  /** 人说的话里如果有定下来的规矩，记一条。返回写进去了几条。 */
  hear(trigger: Pick<Trigger, 'text' | 'at' | 'actor'> & { channel?: Trigger['channel'] }): number {
    const at = Math.floor(Date.parse(trigger.at) / 1000) || Math.floor(Date.now() / 1000)
    const fact = factOfPersonMessage(trigger.text, at)
    if (!fact) return 0
    const bot = String((trigger.channel?.address as { bot_id?: unknown } | undefined)?.bot_id ?? '')
    // 没点名归给谁：记在全队默认那位身上，召回时全队都看得见（见 recall 的放宽规则）。
    const owner = bot || this.host.bots()[0] || 'lead'
    const result = this.ledger.settle({ bot_id: owner, fact, origin: `person:${trigger.actor.id}`,
      source: { at: trigger.at } })
    if (result.written.length) {
      console.log('[memory] settle source=person bot=%s key=%s', owner, fact.dedupe_key)
    }
    return result.written.length
  }

  /** 一票收尾：把结论记一条。 */
  close(ticket: Ticket): number {
    const report = ticket.assignments.findLast(assignment => assignment.report)?.report
    if (!report) return 0
    const at = Math.floor(Date.parse(report.at) / 1000) || Math.floor(Date.now() / 1000)
    const bot = botOf(ticket)
    const fact = factOfFinishedTicket({ id: ticket.id, title: ticket.title, bot_id: bot || undefined }, report, at)
    if (!fact) return 0
    const result = this.ledger.settle({ bot_id: bot || this.host.bots()[0] || 'lead', fact,
      origin: `ticket:${ticket.id}`, source: { ticket_id: ticket.id, at: report.at } })
    if (result.written.length) console.log('[memory] settle source=ticket ticket=%s bot=%s', ticket.id, bot || '-')
    return result.written.length
  }
}
