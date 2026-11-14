import { describe, expect, it } from 'vitest'
import {
  SOON_MS, eventSignature, judgeEvent, scanCalendar, type CalendarEvent, type CalendarPort, type CalendarSighting,
} from '../src/app/calendar.ts'

const NOW = new Date('2026-11-14T09:00:00.000Z')
const at = (minutes: number): string => new Date(NOW.getTime() + minutes * 60_000).toISOString()

const event = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: 'evt-1',
  title: '周会',
  startsAt: at(30),
  endsAt: at(60),
  attendees: ['me@example.com', 'lin@example.com'],
  ...over,
})

const sighting = (over: Partial<CalendarSighting> = {}): CalendarSighting => ({ event: event(), ...over })

describe('judgeEvent — 临近', () => {
  it('reminds inside the window and stays quiet outside it', () => {
    expect(judgeEvent(sighting({ event: event({ startsAt: at(15), endsAt: at(45) }) }), NOW))
      .toMatchObject({ notify: true, when: 'soon', reason: 'soon' })
    expect(judgeEvent(sighting({ event: event({ startsAt: at(16), endsAt: at(46) }) }), NOW))
      .toMatchObject({ notify: false, when: null, reason: 'later' })
    expect(judgeEvent(sighting({ event: event({ startsAt: at(1), endsAt: at(31) }) }), NOW))
      .toMatchObject({ notify: true, when: 'soon', reason: 'soon' })
  })

  it('tells me a meeting has already started while it is still running', () => {
    // 迟到十分钟比「还有十五分钟」更值得说一句。
    expect(judgeEvent(sighting({ event: event({ startsAt: at(-10), endsAt: at(20) }) }), NOW))
      .toMatchObject({ notify: true, when: 'soon', reason: 'ongoing' })
  })

  it('says nothing about an event that already ended', () => {
    expect(judgeEvent(sighting({ event: event({ startsAt: at(-60), endsAt: at(-30) }) }), NOW))
      .toMatchObject({ notify: false, when: null, reason: 'past' })
  })

  it('says nothing about all-day events', () => {
    // 全天事件没有「马上开始」这一说，提醒只会在早上八点准时烦人。
    expect(judgeEvent(sighting({ event: event({ allDay: true, startsAt: at(-1), endsAt: at(600) }) }), NOW))
      .toMatchObject({ notify: false, when: null, reason: 'all-day' })
  })
})

describe('judgeEvent — 变更与取消', () => {
  it('reminds when the time or title moved', () => {
    const previousSignature = eventSignature(event({ startsAt: at(120), endsAt: at(150) }))
    const verdict = judgeEvent(sighting({ previousSignature }), NOW)
    expect(verdict).toMatchObject({ notify: true, when: 'changed', reason: 'changed' })
    expect(verdict.key).toBe(`changed:${eventSignature(event())}`)
  })

  it('reminds when an event I knew about is cancelled', () => {
    expect(judgeEvent(sighting({ event: event({ cancelled: true }), previousSignature: eventSignature(event()) }), NOW))
      .toMatchObject({ notify: true, when: 'cancelled', reason: 'cancelled', key: 'cancelled' })
  })

  it('says nothing about a cancelled event I never knew about', () => {
    // 我从没把这场会排进计划，告诉我也无从改计划，只是噪声。
    expect(judgeEvent(sighting({ event: event({ cancelled: true }) }), NOW))
      .toMatchObject({ notify: false, when: null, reason: 'unseen-cancel' })
  })

  it('prefers cancellation over a change over being soon', () => {
    // 同一场会一轮只说一句：三句叠起来人只会划掉不看。
    const previousSignature = eventSignature(event({ startsAt: at(120), endsAt: at(150) }))
    expect(judgeEvent(sighting({ event: event({ startsAt: at(5), endsAt: at(35), cancelled: true }), previousSignature }), NOW))
      .toMatchObject({ when: 'cancelled' })
    expect(judgeEvent(sighting({ event: event({ startsAt: at(5), endsAt: at(35) }), previousSignature }), NOW))
      .toMatchObject({ when: 'changed' })
  })
})

describe('judgeEvent — 同一场会每类只提醒一次', () => {
  it('skips a kind it has already told', () => {
    expect(judgeEvent(sighting({ event: event({ startsAt: at(10), endsAt: at(40) }), told: ['soon'] }), NOW))
      .toMatchObject({ notify: false, when: null, reason: 'told' })
  })

  it('tells a second, different change as its own thing', () => {
    // 「改了」和「又改了」是两回事；用旧指纹当已说过的键，就不会吞掉第二次改动。
    const old = eventSignature(event({ startsAt: at(120), endsAt: at(150) }))
    expect(judgeEvent(sighting({ previousSignature: old, told: [`changed:${old}`] }), NOW))
      .toMatchObject({ notify: true, when: 'changed' })
  })
})

describe('scanCalendar — Source 骨架（真实接入点是一个 fetch）', () => {
  const port = (events: readonly CalendarEvent[]): CalendarPort => ({ fetch: async () => events })

  it('reports the ones worth telling and hands back the fingerprints it saw', async () => {
    const scan = await scanCalendar(port([
      event({ id: 'a', title: '周会', startsAt: at(10), endsAt: at(40) }),
      event({ id: 'b', title: '季度评审', startsAt: at(600), endsAt: at(660) }),
    ]), { now: NOW, known: {}, told: {} })
    expect(scan.notices.map(notice => notice.kind)).toEqual(['calendar'])
    expect(scan.notices[0]?.title).toContain('周会')
    expect(scan.known).toEqual({ a: eventSignature(event({ id: 'a', title: '周会', startsAt: at(10), endsAt: at(40) })),
      b: eventSignature(event({ id: 'b', title: '季度评审', startsAt: at(600), endsAt: at(660) })) })
    expect(scan.told).toEqual({ a: ['soon'] })
  })

  it('does not repeat itself on the next tick', async () => {
    const events = [event({ id: 'a', startsAt: at(10), endsAt: at(40) })]
    const first = await scanCalendar(port(events), { now: NOW, known: {}, told: {} })
    const second = await scanCalendar(port(events), { now: NOW, known: first.known, told: first.told })
    expect(first.notices).toHaveLength(1)
    expect(second.notices).toEqual([])
  })

  it('reports a cancellation on the tick it first sees it, then stops', async () => {
    const live = [event({ id: 'a', startsAt: at(10), endsAt: at(40) })]
    const first = await scanCalendar(port(live), { now: NOW, known: {}, told: {} })
    const gone = [event({ id: 'a', startsAt: at(10), endsAt: at(40), cancelled: true })]
    const second = await scanCalendar(port(gone), { now: NOW, known: first.known, told: first.told })
    const third = await scanCalendar(port(gone), { now: NOW, known: second.known, told: second.told })
    expect(second.notices).toHaveLength(1)
    expect(second.notices[0]?.body).toContain('取消')
    expect(third.notices).toEqual([])
  })
})

describe('SOON_MS', () => {
  it('is the quarter hour the issue asked for', () => {
    expect(SOON_MS).toBe(15 * 60_000)
  })
})
