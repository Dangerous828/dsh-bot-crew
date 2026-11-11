import { describe, expect, it } from 'vitest'
import { DAILY_HOUR, dailyDue, dailyNotice, pushFor, wants, type Notice } from '../src/app/notices-out.ts'

const notice = (over: Partial<Notice> = {}): Notice => ({ title: '有事', body: '队伍在等你', kind: 'followup', ...over })

describe('wants', () => {
  it('takes everything by default, and honours a mute list', () => {
    expect(wants({ deviceId: 'dev_a1' }, 'followup')).toBe(true)
    expect(wants({ deviceId: 'dev_a1', muted: ['routine'] }, 'routine')).toBe(false)
    expect(wants({ deviceId: 'dev_a1', muted: ['routine'] }, 'followup')).toBe(true)
  })
})

describe('pushFor', () => {
  it('makes one message per device that wants it', () => {
    const sent = pushFor(notice(), [{ deviceId: 'dev_a1' }, { deviceId: 'dev_b2', muted: ['followup'] }, { deviceId: 'dev_c3' }],
      new Date('2026-11-12T00:00:00.000Z'))
    expect(sent.map(item => item.deviceId)).toEqual(['dev_a1', 'dev_c3'])
    expect(sent[0]).toMatchObject({ title: '有事', kind: 'followup', at: '2026-11-12T00:00:00.000Z' })
  })

  it('sends nothing when every device muted that kind', () => {
    expect(pushFor(notice(), [{ deviceId: 'dev_a1', muted: ['followup'] }])).toEqual([])
  })
})

describe('dailyNotice', () => {
  it('says only what actually happened', () => {
    const result = dailyNotice({ day: '11 月 12 日', finished: 3, failed: 1, waiting: 0, routines: 2 })
    expect(result?.title).toBe('11 月 12 日 的日报')
    expect(result?.body).toBe('办完 3 件 · 失败 1 件 · 到点派了 2 次')
    expect(result?.body).not.toContain('等你')
  })

  it('says nothing at all for a day where nothing happened', () => {
    // 一条「今天什么也没发生」只是在占人时间。
    expect(dailyNotice({ day: '11 月 12 日', finished: 0, failed: 0, waiting: 0, routines: 0 })).toBeUndefined()
  })

  it('still speaks when there is a highlight even with no counts', () => {
    const result = dailyNotice({ day: '11 月 12 日', finished: 0, failed: 0, waiting: 0, routines: 0,
      highlights: ['「修卡顿」等你回答：按哪版来？'] })
    expect(result?.body).toBe('「修卡顿」等你回答：按哪版来？')
  })

  it('keeps highlights under the counts, one per line', () => {
    const result = dailyNotice({ day: '11 月 12 日', finished: 1, failed: 0, waiting: 1, routines: 0,
      highlights: ['甲', '乙'] })
    expect(result?.body).toBe('办完 1 件 · 1 件等你\n甲\n乙')
  })
})

describe('dailyDue', () => {
  it('waits until the evening', () => {
    expect(dailyDue(new Date(2026, 10, 12, DAILY_HOUR - 1, 0))).toBe(false)
    expect(dailyDue(new Date(2026, 10, 12, DAILY_HOUR, 0))).toBe(true)
    expect(dailyDue(new Date(2026, 10, 12, 23, 30))).toBe(true)
  })
})
