/**
 * 审计账：每件事都能答出「谁派的、谁判的、谁干的、花了多少」。
 *
 * 这一份不新增存储 —— 三样东西都已经在盘上了：
 * - **谁派的**：Trigger 的 `actor`（来源与身份）与它的类型（人说的 / 规则推出来的 / Bot 说的）；
 * - **谁判的**：`Decision`（评估的结论、命中的规则、强度、依据）；
 * - **谁干的**：Ticket 的 `channels`（归哪位 Bot）与 Assignment（谁在跑、跑了几次、什么时候报的）；
 * - **花了多少**：worker 会话里 `assistant/message.usage` 的合计（`spend.ts`）。
 *
 * 这里做的是把它们编成一张表 —— 不改任何一条记录，也不替缺的那格编内容。
 * 缺是缺：`assessor` 没记、`usage` 没上报，就写 `unrecorded`，不填一个像样的假值。
 */
import type { Decision, Ticket, Trigger } from '../core/index.ts'
import type { Spend } from './spend.ts'

/** 一行审计：一张票从头到尾的那条链。 */
export interface AuditRow {
  ticket_id: string
  title: string
  /** 派的：谁、从哪来、是哪种 Trigger。 */
  requested_by: { source: string; actor: string; at: string; via: 'person' | 'rule' | 'bot' | 'routine' | 'unknown' }
  /** 判的：DSH 的那一轮评估。`unrecorded` 表示账上没有这条决定。 */
  judged: { outcome: string; at: string; strength?: string; rules: string[]; reason: string } | 'unrecorded'
  /** 干活的：归哪位 Bot、跑过几次、最后说了什么。 */
  worked_by: { bot?: string; assignments: number; started_at?: string; report?: { state: string; at: string; summary: string } }
  /** 花了多少：从 worker 会话算出来的合计；读不到会话时是 `undefined`（不是 0）。 */
  spent?: Spend
  /** 收尾：以什么结局结束的，谁收的。 */
  ended?: { at: string; by: string; outcome: string }
}

/** Trigger 是哪一类来源。`routine` 是到点派单（`meta.routine`），它冒充人说的话但不该被当成人说的。 */
export function requestedVia(trigger: Trigger): AuditRow['requested_by']['via'] {
  const meta = trigger.meta as { routine?: unknown; bot_id?: unknown } | undefined
  if (typeof meta?.routine === 'string') return 'routine'
  const type = (trigger as { type?: string }).type
  if (type === 'rule' || (trigger as { ruleId?: string }).ruleId) return 'rule'
  if (type === 'bot' || trigger.actor.id.startsWith('bot-')) return 'bot'
  return trigger.human ? 'person' : 'unknown'
}

/** 一票一行。`decision` 是这张票的裁决（没有就是 `unrecorded`），`report` 取最后一次报告。 */
export function auditOf(input: {
  ticket: Ticket
  trigger?: Trigger
  decision?: Decision
  report?: { state: string; at: string; summary: string }
  spent?: Spend
}): AuditRow {
  const { ticket, trigger, decision, report, spent } = input
  const channel = ticket.channels[0]
  const bot = (channel?.address as { bot_id?: unknown } | undefined)?.bot_id
  const assignment = ticket.assignments.at(-1)
  return {
    ticket_id: ticket.id,
    title: ticket.title,
    requested_by: {
      source: trigger?.actor.source ?? channel?.source ?? 'unknown',
      actor: trigger?.actor.id ?? 'unknown',
      at: trigger?.at ?? ticket.createdAt,
      via: trigger ? requestedVia(trigger) : 'unknown',
    },
    judged: decision
      ? {
        outcome: decision.kind,
        at: decision.at,
        ...(decision.mandate?.strength ? { strength: decision.mandate.strength } : {}),
        rules: decision.mandate?.basis.rules ?? [],
        reason: decision.reason.map(item => item.code).join(','),
      }
      : 'unrecorded',
    worked_by: {
      ...(typeof bot === 'string' && bot ? { bot } : {}),
      assignments: ticket.assignments.length,
      ...(assignment?.startedAt ? { started_at: assignment.startedAt } : {}),
      ...(report ? { report } : {}),
    },
    // 读不到会话时 `spent` 是空的：不知道就说不知道，不写成 0 步。
    ...(spent ? { spent } : {}),
    ...(ticket.ended ? { ended: { at: ticket.ended.at, by: ticket.ended.by, outcome: ticket.ended.outcome } } : {}),
  }
}

/**
 * 一行审计的人话摘要：一句话答完「谁、判成什么、谁在做、花了多少」。
 *
 * 界面与日志共用同一句，两处各写一份就迟早有一处说谎。
 */
export function auditLine(row: AuditRow): string {
  const via = row.requested_by.via === 'person' ? '人说的'
    : row.requested_by.via === 'rule' ? '规则推的'
      : row.requested_by.via === 'routine' ? '到点派的'
        : row.requested_by.via === 'bot' ? 'Bot 说的' : '来源不明'
  const judged = row.judged === 'unrecorded' ? '没有裁决记录' : `判为 ${row.judged.outcome}`
  const who = row.worked_by.bot ? `由 ${row.worked_by.bot} 做` : '还没派人做'
  const spent = row.spent === undefined ? '用量读不到'
    : row.spent.unaccounted_steps > 0 ? `用量 ${row.spent.total_tokens}（其中 ${row.spent.unaccounted_steps} 步没有上报）`
      : `用量 ${row.spent.total_tokens}`
  return `${via} · ${judged} · ${who} · ${spent}`
}
