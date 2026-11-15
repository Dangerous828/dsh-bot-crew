import { describe, expect, it } from 'vitest'
import {
  DAILY_HOUR, MORNING_HOUR, clockOf, dailyDue, dayLabel, localDay, morningDue, morningNotice, onceToday, startOfLocalDay, windowLabel,
  type MorningFacts,
} from '../src/app/notices-out.ts'

const facts = (over: Partial<MorningFacts> = {}): MorningFacts => ({
  day: '11 月 14 日',
  overnight: { finished: 2, failed: 0 },
  events: [{ at: '09:30', title: '周会' }],
  pending: [{ key: 'ticket:t1', text: '「修卡顿」等你回答：按哪版来？' }],
  // 窗口从今天之内起算 → 抬头说「今日」。跨日的用例自己覆盖 `windowStart`。
  windowStart: new Date(2026, 10, 14, 7, 30).toISOString(),
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

describe('localDay / dayLabel', () => {
  it('names the day the person is living in, not the UTC one', () => {
    // 08:00 北京时间是前一天 00:00 UTC：按 UTC 取日会把早报算到昨天。
    const morning = new Date(2026, 10, 14, 8, 0)
    expect(localDay(morning)).toBe('2026-11-14')
    expect(dayLabel(morning)).toBe('11 月 14 日')
    expect(localDay(new Date(2026, 10, 14, 23, 59))).toBe('2026-11-14')
    expect(localDay(new Date(2026, 10, 15, 0, 0))).toBe('2026-11-15')
  })
})

describe('startOfLocalDay', () => {
  it('starts today at local midnight', () => {
    const start = startOfLocalDay(new Date(2026, 10, 14, 8, 0))
    expect([start.getFullYear(), start.getMonth(), start.getDate(), start.getHours(), start.getMinutes()])
      .toEqual([2026, 10, 14, 0, 0])
  })

  it('is only the fallback lower bound when no report has ever run', () => {
    // 「昨夜」不由这里现算：真正的下界是持久化的水位线（`KV.notices.reported`）。
    // 这里只是「这台机器从没报过」时的兜底 —— 从没报过就不考古，从今天零点起算。
    const now = new Date(2026, 10, 14, 8, 0)
    expect(startOfLocalDay(now).getTime()).toBeGreaterThan(new Date(2026, 10, 13, DAILY_HOUR).getTime())
  })
})

describe('clockOf', () => {
  it('gives a local wall clock, not a UTC one', () => {
    expect(clockOf(new Date(2026, 10, 14, 9, 5).toISOString())).toBe('09:05')
    expect(clockOf(new Date(2026, 10, 14, 23, 59).toISOString())).toBe('23:59')
  })
})

describe('morningNotice', () => {
  it('leads with the night, then today, then what waits on me', () => {
    const notice = morningNotice(facts())
    expect(notice?.title).toBe('11 月 14 日 早报')
    expect(notice?.body.split('\n')).toEqual(['今日 办完 2 件', '今日 09:30 周会', '待处理 「修卡顿」等你回答：按哪版来？'])
    expect(notice?.kind).toBe('morning')
  })

  it('keeps the three sections in a fixed order even when some are empty', () => {
    // 段序固定，人每天扫的位置就固定；空的那段整段不写，不留一行「今日：无」。
    const notice = morningNotice(facts({ overnight: { finished: 0, failed: 0 }, events: [] }))
    expect(notice?.body).toBe('待处理 「修卡顿」等你回答：按哪版来？')
  })

  it('says the calendar cannot be read instead of letting an empty list mean "no meetings"', () => {
    // 设计系统 §六：空着和读不到是两件事。没有接入日历时说读不到，不冒充「今天没会」。
    const notice = morningNotice(facts({ events: [], calendarNote: '还没有接入日历' }))
    expect(notice?.body.split('\n')).toEqual([
      '今日 办完 2 件', '今日日程读不到（还没有接入日历）', '待处理 「修卡顿」等你回答：按哪版来？',
    ])
  })

  it('drops the calendar line once a real calendar answers, even with nothing on it', () => {
    const notice = morningNotice(facts({ events: [] }))
    // 日程栏整段不写。注意不能断言「正文里没有『今日』」—— 抬头那一段也可能叫「今日」，
    // 那样的断言分不清「日程栏没写」与「抬头换了叫法」。
    expect(notice?.body).not.toContain('读不到')
    expect(notice?.body.split('\n').some(line => line.startsWith('今日 ') && line.includes('周会'))).toBe(false)
    expect(notice?.body).not.toMatch(/今日日程/)
  })

  it('does not push a morning just to say the calendar is unreadable', () => {
    // 每天早上一句「还没接入日历」是纯噪音，人两天就会把早报静音。
    const notice = morningNotice(facts({ overnight: { finished: 0, failed: 0 }, events: [], pending: [], calendarNote: 'x' }))
    expect(notice).toBeUndefined()
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
    expect(notice?.body).toBe('今日 失败 2 件')
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

describe('the two windows never overlap', () => {
  it('never makes both due at the same hour, so one tick cannot run both', () => {
    // 调度器每一拍并发 `void runMorning()` 与 `void runDaily()`；两者永不同时为真，
    // 「同一拍都跑、抢着写同一条水位线」这件事从根上不会发生。
    for (let hour = 0; hour < 24; hour += 1) {
      for (const minute of [0, 30, 59]) {
        const now = new Date(2026, 10, 14, hour, minute)
        expect(morningDue(now) && dailyDue(now), `${hour}:${minute}`).toBe(false)
      }
    }
  })
})

describe('windowLabel', () => {
  it('says 今日 when the window started today', () => {
    // 首次启动从今天零点起算、或水位就在今天之内 —— 那时说「今日」是准确的。
    expect(windowLabel(new Date(2026, 10, 14, 0, 0).toISOString(), '11 月 14 日')).toBe('今日')
    expect(windowLabel(new Date(2026, 10, 14, 7, 30).toISOString(), '11 月 14 日')).toBe('今日')
  })

  it('names the real start when the window reaches back past today', () => {
    // 停机几天后第一次报表：必须说出真实起点，不能拿「昨夜」冒充。
    expect(windowLabel(new Date(2026, 10, 12, 8, 0).toISOString(), '11 月 14 日')).toBe('自 11 月 12 日 08:00 起')
    expect(windowLabel(new Date(2026, 10, 13, 21, 0).toISOString(), '11 月 14 日')).toBe('自 11 月 13 日 21:00 起')
  })

  it('falls back to 上次汇报以来 when there is no watermark to name', () => {
    // 不知道起于何时就别编一个具体时刻。
    expect(windowLabel(undefined, '11 月 14 日')).toBe('上次汇报以来')
    expect(windowLabel('not-a-date', '11 月 14 日')).toBe('上次汇报以来')
  })

  it('never says 昨夜 — the night is one case of a window, not its name', () => {
    for (const start of [new Date(2026, 10, 13, 21, 0), new Date(2026, 10, 12, 8, 0), new Date(2026, 10, 14, 0, 0)]) {
      expect(windowLabel(start.toISOString(), '11 月 14 日')).not.toContain('昨夜')
    }
  })
})

describe('morningNotice window label', () => {
  it('leads the counts with the window the numbers actually cover', () => {
    // 同一批数，窗口不同，抬头就不同 —— 这是这次修的那件事：数是真的，时间范围也得是真的。
    const overnight = { finished: 12, failed: 0 }
    const span = morningNotice(facts({ overnight, windowStart: new Date(2026, 10, 12, 8, 0).toISOString() }))
    expect(span?.body.split('\n')[0]).toBe('自 11 月 12 日 08:00 起 办完 12 件')
    const today = morningNotice(facts({ overnight, windowStart: new Date(2026, 10, 14, 0, 0).toISOString() }))
    expect(today?.body.split('\n')[0]).toBe('今日 办完 12 件')
  })

  it('does not claim a window when the caller has no watermark', () => {
    const notice = morningNotice(facts({ windowStart: undefined }))
    expect(notice?.body.split('\n')[0]).toBe('上次汇报以来 办完 2 件')
  })
})
