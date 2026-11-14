import { describe, expect, it } from 'vitest'
import {
  DAILY_HOUR, MORNING_HOUR, morningDue, morningNotice, onceToday, type MorningFacts,
} from '../src/app/notices-out.ts'

const facts = (over: Partial<MorningFacts> = {}): MorningFacts => ({
  day: '11 月 14 日',
  overnight: { finished: 2, failed: 0 },
  events: [{ at: '09:30', title: '周会' }],
  pending: [{ key: 'ticket:t1', text: '「修卡顿」等你回答：按哪版来？' }],
  ...over,
})

describe('morningDue', () => {
  it('fires in the morning window only', () => {
    expect(morningDue(new Date(2026, 10, 14, MORNING_HOUR - 1, 59))).toBe(false)
    expect(morningDue(new Date(2026, 10, 14, MORNING_HOUR, 0))).toBe(true)
    expect(morningDue(new Date(2026, 10, 14, 12, 0))).toBe(true)
  })

  it('hands the evening over to the daily report', () => {
    // 两份报告各占一段：早上那份过了日报的点就闭嘴，否则同一晚会各说一遍。
    expect(morningDue(new Date(2026, 10, 14, DAILY_HOUR, 0))).toBe(false)
    expect(morningDue(new Date(2026, 10, 14, DAILY_HOUR - 1, 59))).toBe(true)
  })

  it('is earlier than the daily report, not the same hour', () => {
    expect(MORNING_HOUR).toBeLessThan(DAILY_HOUR)
  })
})

describe('morningNotice', () => {
  it('leads with the night, then today, then what waits on me', () => {
    const notice = morningNotice(facts())
    expect(notice?.title).toBe('11 月 14 日 早报')
    expect(notice?.body.split('\n')).toEqual(['昨夜 办完 2 件', '今日 09:30 周会', '待处理 「修卡顿」等你回答：按哪版来？'])
    expect(notice?.kind).toBe('morning')
  })

  it('keeps the three sections in a fixed order even when some are empty', () => {
    // 段序固定，人每天扫的位置就固定；空的那段整段不写，不留一行「今日：无」。
    const notice = morningNotice(facts({ overnight: { finished: 0, failed: 0 }, events: [] }))
    expect(notice?.body).toBe('待处理 「修卡顿」等你回答：按哪版来？')
  })

  it('marks an all-day event instead of giving it a clock', () => {
    const notice = morningNotice(facts({ events: [{ at: '全天', title: '团建', allDay: true }] }))
    expect(notice?.body).toContain('今日 全天 团建')
  })

  it('says nothing on a morning with nothing in it', () => {
    // 与日报同一条规矩：一条「今天没什么事」只是在占人时间。
    expect(morningNotice(facts({ overnight: { finished: 0, failed: 0 }, events: [], pending: [] }))).toBeUndefined()
  })

  it('still speaks for a night that only had failures', () => {
    const notice = morningNotice(facts({ overnight: { finished: 0, failed: 2 }, events: [], pending: [] }))
    expect(notice?.body).toBe('昨夜 失败 2 件')
  })

  it('caps a long pending list instead of pasting a wall of text', () => {
    const pending = Array.from({ length: 8 }, (_, index) => ({ key: `ticket:t${index}`, text: `第 ${index + 1} 件` }))
    const notice = morningNotice(facts({ overnight: { finished: 0, failed: 0 }, events: [], pending }))
    const lines = notice?.body.split('\n') ?? []
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('第 5 件')
    expect(lines[0]).not.toContain('第 6 件')
    expect(lines[0]).toContain('还有 3 件')
  })

  it('takes a caller-supplied ledger so the same item is not said twice in a day', () => {
    // 晨报与日报共用一本账：早上说过的，晚上不再说。
    const notice = morningNotice(facts({ spoken: ['ticket:t1'] }))
    expect(notice?.body).not.toContain('修卡顿')
    expect(notice?.spoken).toEqual(['ticket:t1'])
  })

  it('drops nothing at all when the whole day has already been said', () => {
    expect(morningNotice(facts({ overnight: { finished: 0, failed: 0 }, events: [], spoken: ['ticket:t1'] })))
      .toBeUndefined()
  })
})

describe('onceToday', () => {
  it('keeps only what today has not said yet, and extends the ledger', () => {
    const result = onceToday([{ key: 'ticket:1', text: '甲' }, { key: 'ticket:2', text: '乙' }], ['ticket:1'])
    expect(result.items.map(item => item.text)).toEqual(['乙'])
    expect(result.spoken).toEqual(['ticket:1', 'ticket:2'])
  })

  it('does not grow the ledger with what it skipped', () => {
    expect(onceToday([{ key: 'k1', text: '甲' }], ['k1'])).toEqual({ items: [], spoken: ['k1'] })
  })

  it('collapses a duplicate key inside the same batch', () => {
    const result = onceToday([{ key: 'k1', text: '甲' }, { key: 'k1', text: '甲（重）' }], [])
    expect(result.items.map(item => item.text)).toEqual(['甲'])
    expect(result.spoken).toEqual(['k1'])
  })
})
