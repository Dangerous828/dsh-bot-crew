import { describe, expect, it } from 'vitest'
import { advance, dueOf, routineMessage, TICK_MS, type DueTask } from '../src/app/routine-runner.ts'

const NOW = Date.parse('2026-11-11T12:00:00.000Z')

const task = (over: Partial<DueTask> = {}): DueTask => ({
  id: 'daily-standup',
  title: '每天站会',
  cycle: 'daily',
  bot_id: 'lead',
  enabled: true,
  created_at: '2026-11-01T09:00:00.000Z',
  last_run: '2026-11-10T09:00:00.000Z',
  next_run: '2026-11-11T09:00:00.000Z',
  overdue: true,
  ...over,
})

describe('dueOf', () => {
  it('picks only enabled tasks whose next run has passed', () => {
    expect(dueOf([task()], NOW).map(item => item.id)).toEqual(['daily-standup'])
    expect(dueOf([task({ enabled: false })], NOW)).toEqual([])
    expect(dueOf([task({ next_run: '2026-11-12T09:00:00.000Z', overdue: false })], NOW)).toEqual([])
  })

  it('orders by how long it has been due, not by ledger order', () => {
    const older = task({ id: 'older', next_run: '2026-11-09T09:00:00.000Z' })
    const newer = task({ id: 'newer', next_run: '2026-11-11T11:00:00.000Z' })
    expect(dueOf([newer, older], NOW).map(item => item.id)).toEqual(['older', 'newer'])
  })
})

describe('routineMessage', () => {
  it('says it is a scheduled task, with its cycle and the last run', () => {
    const text = routineMessage(task(), new Date(NOW))
    expect(text).toContain('【常规任务】每天站会')
    expect(text).toContain('周期：每天')
    expect(text).toContain('上次跑是 2026-11-10T09:00:00.000Z')
    expect(text).toContain('2026-11-11T12:00:00.000Z')
    expect(text).toContain('自动派给你的')
  })

  it('says "first run" whenever no run was recorded, never a made-up date', () => {
    expect(routineMessage({ title: 'x', cycle: 'hourly' }, new Date(NOW))).toContain('这是第一次跑')
  })

  it('names every cycle', () => {
    expect(routineMessage({ title: 'x', cycle: 'hourly' }, new Date(NOW))).toContain('每小时')
    expect(routineMessage({ title: 'x', cycle: 'weekly' }, new Date(NOW))).toContain('每周')
  })
})

describe('advance', () => {
  it('records this run and moves next_run one cycle on', () => {
    const next = advance(task(), NOW)
    expect(next.last_run).toBe(new Date(NOW).toISOString())
    expect(next.next_run).toBe('2026-11-12T09:00:00.000Z')
  })

  it('never lands next_run in the past after a long stop', () => {
    // 停机两天：不是补两天，而是今天这一轮。
    const stalled = task({ last_run: '2026-11-08T09:00:00.000Z', next_run: '2026-11-09T09:00:00.000Z' })
    const next = advance(stalled, NOW)
    expect(Date.parse(next.next_run)).toBeGreaterThan(NOW)
    expect(next.next_run).toBe('2026-11-12T09:00:00.000Z')
  })

  it('starts from created_at for a task that never ran', () => {
    const never = task({ last_run: undefined, created_at: '2026-11-01T09:00:00.000Z' })
    const next = advance(never, NOW)
    expect(next.last_run).toBe(new Date(NOW).toISOString())
    expect(next.next_run).toBe('2026-11-12T09:00:00.000Z')
  })

  it('always moves the next run past now, whatever the cycle', () => {
    for (const cycle of ['hourly', 'daily', 'weekly'] as const) {
      const next = advance(task({ cycle, last_run: '2026-01-01T00:00:00.000Z' }), NOW)
      expect(Date.parse(next.next_run)).toBeGreaterThan(NOW)
    }
  })

  it('treats an unreadable anchor as now instead of throwing', () => {
    const broken = task({ last_run: 'not a date' })
    const next = advance(broken, NOW)
    expect(Date.parse(next.next_run)).toBeGreaterThan(NOW)
  })
})

describe('tick', () => {
  it('checks the ledger about once a minute', () => {
    expect(TICK_MS).toBe(60_000)
  })
})
