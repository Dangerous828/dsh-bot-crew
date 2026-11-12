/**
 * settle 的输入端：一轮结束之后，哪一句值得记下来。
 *
 * 这一层只做「认得出」的部分 —— 人自己说定的规矩、队伍跑完一票的结论。
 * 为什么不用 LLM 来提炼：每次一轮都多跑一轮模型，成本比它省下的上下文还贵，
 * 而且提炼出来的话没法回查（"它凭什么记这一条"）。这里的每一条都能指回原文。
 *
 * 认不出来的就不记。宁可少记，也不要把碎碎念写进账本 —— 账本一脏，
 * 下次召回的全是废话，比没有记忆更糟。
 */

export interface Fact {
  /** 单行标题，进 frontmatter 的 `description`。 */
  description: string
  /** 正文；只写这一句为什么值得记。 */
  body: string
  type: 'user' | 'feedback' | 'project' | 'reference'
  importance: number
  /** 去重键：同一件事说出来两次只留一条。 */
  dedupe_key: string
}

/** 人说话里「这是规矩」的证据。命中才算 durable，不命中就当闲聊。 */
const DECISION = [
  // 「以后都先说结论」「以后先看数据」是最常见的两种说法，而原来的列表里只有
  // 按/用/要/就/走/叫/这么/这样/别 —— 「先」不在其中，于是最自然的句式反而认不出来。
  //
  // 这里刻意**不收「再」**：「以后再说」「以后再看吧」是推脱，跟「以后再说清楚」这种
  // 承诺长得一样，靠句式分不开。宁可漏记一句推脱，也不要往账本里塞「以后再看吧」。
  /以后(?:都|一律|全部|每次|一直)?(?:先|只|必须|得|按|用|要|就|走|叫|这么|这样|别)/,
  /记住[：:，,]?/,
  /(?:我|我们)(?:习惯|偏好|喜欢|一向|一般)(?:是|都|先|用)?/,
  /(?:不要|别|禁止|千万别|不要再)(?:再)?(?:用|改|动|碰|写|删|跑|装|提交)/,
  /(?:规矩|规定|原则|约定)(?:是|就是|定)[：:，,]?/,
  /从今(?:以后|往后)/,
  /(?:默认|统一)(?:用|按|走|叫)/,
  /(?:这个|这件事|这里)(?:要|得)(?:记住|定下来|说清楚)/,
]

/** 一句话是不是「定下来的事」。 */
export function looksDurable(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length < 4) return false
  return DECISION.some(pattern => pattern.test(trimmed))
}

/** 压成一行：frontmatter 的 description 不能有换行（桥接解析会丢）。 */
function oneLine(text: string, limit = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

/** 取话题的第一句：去掉客套，留下真正被要求的那件事。 */
function headline(text: string, limit = 40): string {
  const first = text.split(/[。！？!?\n]/).map(part => part.trim()).find(Boolean) ?? text
  return oneLine(first, limit)
}

/**
 * 从一句人说的话里取出事实。不像规矩就返回 undefined。
 *
 * `dedupe_key` 用她原话的话题前缀，而不是全长：同一句规矩换个语气再说一遍，
 * 键得一样，否则账本里会攒出三五条近义条目。
 */
export function factOfPersonMessage(text: string, at: number): Fact | undefined {
  if (!looksDurable(text)) return undefined
  const subject = headline(text)
  return {
    description: oneLine(text),
    body: `主人原话：「${text.trim()}」\n\n记于 ${new Date(at * 1000).toISOString()}。`,
    type: 'feedback',
    importance: 5,
    dedupe_key: `person:${subject}`,
  }
}

/**
 * 一票做完了：记它的结论。
 *
 * 只记 `ready` / `dropped`（真跑完或主动放弃）。`progress` / `waiting` 是过程，
 * 下一轮还会变，写进账本只会让下次召回到半截事。
 */
export function factOfFinishedTicket(
  ticket: { id: string; title?: string; bot_id?: string },
  report: { state: string; summary: string },
  at: number,
): Fact | undefined {
  if (report.state !== 'ready' && report.state !== 'dropped') return undefined
  const summary = report.summary.trim()
  if (!summary) return undefined
  const title = (ticket.title ?? '').trim() || ticket.id
  return {
    description: oneLine(`${report.state === 'ready' ? '已办完' : '已放弃'}：${title}`, 90),
    body: `${summary}\n\n票号 ${ticket.id}${ticket.bot_id ? `，由 ${ticket.bot_id} 做` : ''}；${new Date(at * 1000).toISOString()} 收尾。`,
    type: 'project',
    importance: report.state === 'ready' ? 3 : 2,
    // 一票一条：票号就是天然的去重键，重试/重开不会在账本里长第二条。
    dedupe_key: `ticket:${ticket.id}`,
  }
}
