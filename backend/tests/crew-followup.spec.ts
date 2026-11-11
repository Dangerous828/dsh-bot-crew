import { describe, expect, it } from 'vitest'
import { followupOf, followupsOf, followupText, SILENT_WORKING_MS, WAITING_FOR_PERSON_MS } from '../src/app/followup.ts'
import type { Ticket } from '../src/core/index.ts'

const NOW = Date.parse('2026-11-11T12:00:00.000Z')

/** 一张最小可用的票：只给跟进会读的那几个字段。 */
const ticket = (over: Record<string, unknown> = {}): Ticket => ({
  id: 't1',
  title: '把卡顿修掉',
  updatedAt: new Date(NOW - 1000).toISOString(),
  assignments: [],
  inputs: [],
  ...over,
} as unknown as Ticket)

const minutesAgo = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString()

describe('followupOf', () => {
  it('waits before nagging someone who is being asked a question', () => {
    const fresh = ticket({ updatedAt: minutesAgo(2), attention: { question: '按哪版来？' } })
    expect(followupOf(fresh, 'person/answer', NOW)).toBeUndefined()
    const stalled = ticket({ updatedAt: minutesAgo(12), attention: { question: '按哪版来？' } })
    expect(followupOf(stalled, 'person/answer', NOW)).toMatchObject({
      ticket_id: 't1', kind: 'waiting_for_person', action: 'answer', question: '按哪版来？',
    })
  })

  it('uses the threshold that matches the situation', () => {
    const waiting = ticket({ updatedAt: minutesAgo(11) })
    expect(WAITING_FOR_PERSON_MS).toBe(10 * 60 * 1000)
    expect(followupOf(waiting, 'person/delivery', NOW)!.kind).toBe('waiting_for_person')
    const working = ticket({ updatedAt: minutesAgo(30) })
    // 半小时的长跑是常态：这时候提醒等于催命。
    expect(followupOf(working, 'working', NOW)).toBeUndefined()
    expect(SILENT_WORKING_MS).toBe(45 * 60 * 1000)
    expect(followupOf(ticket({ updatedAt: minutesAgo(50) }), 'working', NOW)).toMatchObject({ kind: 'silent_working' })
  })

  it('never follows up a ticket that already ended', () => {
    expect(followupOf(ticket({ ended: { at: minutesAgo(60), by: 'worker', outcome: 'completed' }, updatedAt: minutesAgo(60) }),
      'person/answer', NOW)).toBeUndefined()
  })

  it('takes the newest sign of life, not just updatedAt', () => {
    // 票头没动，但 worker 刚报过一次进度：这是在跑，不是卡住。
    const alive = ticket({
      updatedAt: minutesAgo(120),
      assignments: [{ id: 'a1', state: 'running', startedAt: minutesAgo(130), report: { state: 'progress', summary: '还在跑', at: minutesAgo(1) } }],
    })
    expect(followupOf(alive, 'working', NOW)).toBeUndefined()
  })

  it('keeps quiet when it cannot tell how long it has been', () => {
    const unknowable = ticket({ updatedAt: '', assignments: [], inputs: [] })
    expect(followupOf(unknowable, 'person/answer', NOW)).toBeUndefined()
  })

  it('ignores idle tickets and states it does not recognise', () => {
    expect(followupOf(ticket({ updatedAt: minutesAgo(600) }), 'idle', NOW)).toBeUndefined()
    expect(followupOf(ticket({ updatedAt: minutesAgo(600) }), '', NOW)).toBeUndefined()
  })
})

describe('followupsOf', () => {
  it('lists what is waiting, longest wait first', () => {
    const long = { ticket: ticket({ id: 'long', updatedAt: minutesAgo(60) }), state: 'person/answer' }
    const short = { ticket: ticket({ id: 'short', updatedAt: minutesAgo(15) }), state: 'person/review' }
    expect(followupsOf([short, long], NOW).map(item => item.ticket_id)).toEqual(['long', 'short'])
  })

  it('drops the ones that do not qualify', () => {
    expect(followupsOf([{ ticket: ticket({ updatedAt: minutesAgo(1) }), state: 'person/answer' }], NOW)).toEqual([])
  })
})

describe('followupText', () => {
  it('says where it stopped, for how long, and what it asked', () => {
    const text = followupText({ ticket_id: 't1', title: '修卡顿', kind: 'waiting_for_person', stalled_ms: 25 * 60_000,
      action: 'answer', question: '按哪版来？' })
    expect(text).toContain('【跟进】「修卡顿」在等你回答')
    expect(text).toContain('已经 25 分钟 没动了')
    expect(text).toContain('它问的是：按哪版来？')
  })

  it('names the waiting step instead of saying "handle it"', () => {
    const at = (action: string): string => followupText({ ticket_id: 't', title: 'x', kind: 'waiting_for_person', stalled_ms: 11 * 60_000, action })
    expect(at('delivery')).toContain('在等你去取')
    expect(at('review')).toContain('在等你过目')
    expect(at('failed')).toContain('要不要重跑')
    expect(at('blocked')).toContain('卡住了')
    expect(at('weird')).toContain('卡住了')
  })

  it('switches to hours past two hours, and never invents a reason', () => {
    const text = followupText({ ticket_id: 't', title: 'x', kind: 'silent_working', stalled_ms: 3 * 3_600_000 })
    expect(text).toContain('3 小时')
    expect(text).toContain('没有新的回报')
  })
})
