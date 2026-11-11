/**
 * 压缩产物进账本：长会话被折叠成一段摘要时，把那段摘要记成一条记忆。
 *
 * 为什么不是「自己写一个压缩器」：DSH 已经有 `ctx.compaction`（`dsh-compaction` /
 * `-basic` / `-tool-result-pruner`），它负责决定什么时候折、怎么折。这一份只接一件事 ——
 * **折完那一段落到哪里**。落进记忆账本，那么：
 *
 * - 会话被归档、重开一个新 Session 时，它仍然带着「之前聊过什么」；
 * - 会话本身可以放心短，因为长的那部分已经变成一条可被召回的账。
 *
 * 这正是路线图第 1 期说的「会话可以短，记忆要长」。压缩器不归这里管，也不许这里
 * 偷偷改 CompressionEngine 的判定 —— 那是宿主的事。
 */

/** 宿主发来的 `compaction/summary` 事件的形状（只声明这里用得到的）。 */
export interface CompactionSummaryEvent {
  type: string
  /** 折进来的那一段会话摘要。 */
  summary?: string
  /** 被折掉的范围（条数或区间），只用来写「折了多少」这一句。 */
  replaced?: number
  compactionId?: string
}

/** 折出来的摘要至少这么长才值得记：太短的摘要没有信息量，进账本只会挤掉真事。 */
export const MIN_SUMMARY_CHARS = 80

/** 一条摘要最多记这么长：账本里一条记忆是要被复述的，不是被通读的。 */
export const MAX_SUMMARY_CHARS = 1200

/**
 * 这段摘要值不值得记成一条记忆。
 *
 * 认不出来的事件、空摘要、太短的摘要都不记 —— 账本一脏，下次召回全是废话，
 * 比没有记忆更糟（与 `settle.ts` 同一条规矩）。
 */
export function worthRemembering(event: CompactionSummaryEvent | undefined): boolean {
  if (!event || event.type !== 'compaction/summary') return false
  const summary = event.summary?.trim() ?? ''
  return summary.length >= MIN_SUMMARY_CHARS
}

/**
 * 把摘要整成一条能进账本的事实：掐到上限、标上是「会话摘要」而不是「主人说的」。
 *
 * 掐断时补一句「（后面还有，已折叠）」：让人知道这不是全文，别把它当唯一证据。
 */
export function summaryFact(event: CompactionSummaryEvent, at = new Date().toISOString()): { description: string; body: string; dedupe_key: string } {
  const summary = (event.summary ?? '').trim()
  const clipped = summary.length > MAX_SUMMARY_CHARS
  const body = (clipped ? summary.slice(0, MAX_SUMMARY_CHARS) + '\n\n（后面还有，已折叠）' : summary)
    + `\n\n折于 ${at}${event.replaced ? `，折掉 ${event.replaced} 条` : ''}。`
  return {
    // dedupe_key 用 compactionId：同一段被折两次（重试）不该记两遍。
    dedupe_key: event.compactionId ? `compact:${event.compactionId}` : `compact:${hash(summary)}`,
    description: '这段会话的摘要',
    body,
  }
}

/** 没有 compactionId 时用正文的短指纹当键：同一段摘要重试写入是幂等的。 */
function hash(text: string): string {
  let value = 0
  for (let index = 0; index < text.length; index++) {
    value = (value * 31 + text.charCodeAt(index)) | 0
  }
  return (value >>> 0).toString(36)
}
