import { describe, expect, it } from 'vitest'
import { auditLine, auditOf, requestedVia } from '../src/app/audit.ts'
import { spendOf } from '../src/app/spend.ts'
import type { Decision, Ticket, Trigger } from '../src/core/index.ts'

const ticket = (over: Record<string, unknown> = {}): Ticket => ({
  id: 't1',
  title: '把卡顿修掉',
  createdAt: '2026-11-11T10:00:00.000Z',
  channels: [{ source: 'team', thread: 'team:main', address: { bot_id: 'lead', conversation: 'main' } }],
  assignments: [{ id: 'a1', state: 'running', startedAt: '2026-11-11T10:01:00.000Z' }],
  ...over,
} as unknown as Ticket)

const trigger = (over: Record<string, unknown> = {}): Trigger => ({
  id: 'tr1', source: 'team', actor: { source: 'team', id: 'owner' }, human: true,
  at: '2026-11-11T10:00:00.000Z', text: '修一下', threads: [{ source: 'team', id: 'main' }], meta: {},
  ...over,
} as unknown as Trigger)

const decision = (over: Record<string, unknown> = {}): Decision => ({
  kind: 'accept', at: '2026-11-11T10:00:30.000Z', reason: [{ code: 'explicitRequest' }],
  mandate: { strength: 'explicit', basis: { rules: ['r1'] } },
  ...over,
} as unknown as Decision)

describe('requestedVia', () => {
  it('tells a person from a rule, a bot and a scheduled task', () => {
    expect(requestedVia(trigger())).toBe('person')
    expect(requestedVia(trigger({ human: false }))).toBe('unknown')
    expect(requestedVia(trigger({ type: 'bot', actor: { source: 'team', id: 'bot-lead' } }))).toBe('bot')
    expect(requestedVia(trigger({ meta: { routine: 'daily-standup' } }))).toBe('routine')
  })
})

describe('auditOf', () => {
  it('writes the whole chain: who asked, what was judged, who works, what it cost', () => {
    const spent = spendOf([{ type: 'assistant/message', turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 20 } }])
    const row = auditOf({ ticket: ticket(), trigger: trigger(), decision: decision(), spent })
    expect(row.requested_by).toMatchObject({ source: 'team', actor: 'owner', via: 'person' })
    expect(row.judged).toMatchObject({ outcome: 'accept', strength: 'explicit', rules: ['r1'] })
    expect(row.worked_by).toMatchObject({ bot: 'lead', assignments: 1, started_at: '2026-11-11T10:01:00.000Z' })
    expect(row.spent?.total_tokens).toBe(120)
  })

  it('says "unrecorded" instead of inventing a decision', () => {
    expect(auditOf({ ticket: ticket(), trigger: trigger() }).judged).toBe('unrecorded')
  })

  it('leaves the spend out when the worker session could not be read', () => {
    // 不写 0：0 步会被读成「它没花」，而事实是「不知道花没花」。
    expect(auditOf({ ticket: ticket(), trigger: trigger() })).not.toHaveProperty('spent')
  })

  it('records how it ended when it has ended', () => {
    const row = auditOf({ ticket: ticket({ ended: { at: '2026-11-11T12:00:00.000Z', by: 'worker', outcome: 'completed' } }), trigger: trigger() })
    expect(row.ended).toMatchObject({ by: 'worker', outcome: 'completed' })
  })

  it('survives a ticket whose trigger or bot is missing', () => {
    const row = auditOf({ ticket: ticket({ channels: [] }) })
    expect(row.requested_by).toMatchObject({ source: 'unknown', actor: 'unknown', via: 'unknown' })
    expect(row.worked_by.bot).toBeUndefined()
  })
})

describe('auditLine', () => {
  it('answers the four questions in one sentence', () => {
    const row = auditOf({ ticket: ticket(), trigger: trigger(), decision: decision(),
      spent: spendOf([{ type: 'assistant/message', turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 20 } }]) })
    const line = auditLine(row)
    expect(line).toContain('人说的')
    expect(line).toContain('判为 accept')
    expect(line).toContain('由 lead 做')
    expect(line).toContain('用量 120')
  })

  it('never hides the steps that reported nothing', () => {
    const row = auditOf({ ticket: ticket(), trigger: trigger(), decision: decision(),
      spent: spendOf([{ type: 'assistant/message', turn: 1, step: 1, usage: { inputTokens: 1, outputTokens: 1 } }, { type: 'assistant/message', turn: 1, step: 2 }]) })
    expect(auditLine(row)).toContain('1 步没有上报')
  })

  it('says the usage is unreadable rather than printing zero', () => {
    expect(auditLine(auditOf({ ticket: ticket(), trigger: trigger() }))).toContain('用量读不到')
  })

  it('names the scheduled and rule-driven origins', () => {
    expect(auditLine(auditOf({ ticket: ticket(), trigger: trigger({ meta: { routine: 'r' } }) }))).toContain('到点派的')
    expect(auditLine(auditOf({ ticket: ticket(), trigger: trigger({ human: false, type: 'rule' }) }))).toContain('规则推的')
  })
})
