/**
 * 跟进：没下文的事，它会回来问你，而不是等你自己想起来。
 *
 * 这一份不是「再发一遍消息」，是**提醒**：同一件事只提醒一次，提醒之后仍没动静就安静等着 ——
 * 隔五分钟问一次「你还在吗」的助手不是助手，是骚扰。
 *
 * 两种「没下文」：
 *
 * 1. **等你处理**（`person/*`）：票卡在等人回答 / 等人接手 / 等人评审。这种最要紧 ——
 *    队伍停在那儿什么也做不了，而主人可能根本没注意到。
 * 2. **跑着没动静**（`working` 且很久没新报告）：worker 可能在长跑，也可能早就卡死了。
 *    这一种提醒得克制：长跑是常态，一条提醒就够了，不追第二次。
 *
 * 判定全在这里（纯函数），发不发、发给谁由运行时决定。
 */
import type { Ticket } from '../core/index.ts'

/** 多久没动静算「没下文」。等你处理比跑着没动静要短：停工的代价是即时可见的。 */
export const WAITING_FOR_PERSON_MS = 10 * 60 * 1000
/** 跑着没动静的容忍度：一次长跑（装依赖、跑全量测试）常常十分钟以上。 */
export const SILENT_WORKING_MS = 45 * 60 * 1000

export type FollowupKind = 'waiting_for_person' | 'silent_working'

export interface FollowupCandidate {
  ticket_id: string
  title: string
  kind: FollowupKind
  /** 卡住多久了（毫秒）。 */
  stalled_ms: number
  /** 等人处理时，卡在哪一步（answer / delivery / review / blocked / failed）。 */
  action?: string
  question?: string
}

/** 一张票最近一次有动静的时刻（毫秒）；说不清就返回 undefined，宁可不提醒。 */
function lastActivity(ticket: Ticket): number | undefined {
  const times = [
    ticket.updatedAt,
    ...ticket.assignments.map(assignment => assignment.report?.at ?? assignment.idleAt ?? assignment.startedAt),
    ...ticket.inputs.map(input => input.at),
  ]
  let newest: number | undefined
  for (const at of times) {
    const value = typeof at === 'string' ? Date.parse(at) : Number.NaN
    if (!Number.isNaN(value) && (newest === undefined || value > newest)) newest = value
  }
  return newest
}

/**
 * 这张票现在该不该提醒，以及提醒什么。
 *
 * `cardState` 与卡片共用同一套判定（`TICKET_STATES`），所以这里说的「等你处理」
 * 和界面上那枚点说的是同一件事 —— 两处各写一份，迟早会有一处说谎。
 */
export function followupOf(ticket: Ticket, state: string, now = Date.now()): FollowupCandidate | undefined {
  if (ticket.ended || !state) return undefined
  const last = lastActivity(ticket)
  if (last === undefined) return undefined
  const stalled = now - last
  if (stalled <= 0) return undefined
  if (state.startsWith('person/')) {
    if (stalled < WAITING_FOR_PERSON_MS) return undefined
    const action = state.slice('person/'.length)
    return {
      ticket_id: ticket.id, title: ticket.title, kind: 'waiting_for_person', stalled_ms: stalled, action,
      ...(ticket.attention?.question ? { question: ticket.attention.question } : {}),
    }
  }
  if (state === 'working' && stalled >= SILENT_WORKING_MS) {
    return { ticket_id: ticket.id, title: ticket.title, kind: 'silent_working', stalled_ms: stalled }
  }
  return undefined
}

/** 从全部票里挑出该提醒的，等得最久的先。 */
export function followupsOf(tickets: readonly { ticket: Ticket; state: string }[], now = Date.now()): FollowupCandidate[] {
  return tickets
    .flatMap(({ ticket, state }) => { const found = followupOf(ticket, state, now); return found ? [found] : [] })
    .sort((left, right) => right.stalled_ms - left.stalled_ms)
}

/**
 * 提醒的那句话。写清「停在哪、多久了、你可以做什么」，不说「请及时处理」这种等于没说的话。
 */
export function followupText(candidate: FollowupCandidate): string {
  const waited = Math.round(candidate.stalled_ms / 60_000)
  const span = waited >= 120 ? `${Math.round(waited / 60)} 小时` : `${waited} 分钟`
  if (candidate.kind === 'waiting_for_person') {
    const where = candidate.action === 'answer' ? '在等你回答'
      : candidate.action === 'delivery' ? '在等你去取'
        : candidate.action === 'review' ? '在等你过目'
          : candidate.action === 'failed' ? '失败了，在等你决定要不要重跑'
            : '卡住了，在等你处理'
    const question = candidate.question ? `\n它问的是：${candidate.question}` : ''
    return `【跟进】「${candidate.title}」${where}，已经 ${span} 没动了。${question}`
  }
  return `【跟进】「${candidate.title}」还在跑，但已经 ${span} 没有新的回报。要不要看一眼它现在做到哪了。`
}
