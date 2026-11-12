import { describe, expect, it } from 'vitest'
import { countRoutines, parseCycle, routineItemOf, routinesView } from '../src/app/routines.ts'

const NOW = Date.parse('2026-11-11T12:00:00.000Z')
const record = (over: Record<string, unknown> = {}) => ({
  id: 'daily-standup', title: '每天站会', cycle: 'daily', bot_id: 'lead', enabled: true,
  created_at: '2026-11-11T09:00:00.000Z', ...over,
})

describe('routineItemOf', () => {
  it('counts the next run from the last run and keeps the record fields as they are', () => {
    const item = routineItemOf(record({ last_run: '2026-11-11T09:30:00.000Z' }), NOW)
    expect(item).toMatchObject({ id: 'daily-standup', title: '每天站会', cycle: 'daily', bot_id: 'lead',
      enabled: true, last_run: '2026-11-11T09:30:00.000Z', next_run: '2026-11-12T09:30:00.000Z', overdue: false })
  })

  it('falls back to the creation time when nothing was ever run, and says nothing about a last run', () => {
    const item = routineItemOf(record(), NOW)
    // 没跑过就没有 last_run，也不编一个「上次」出来。
    expect(item).not.toHaveProperty('last_run')
    expect(item).toMatchObject({ next_run: '2026-11-12T09:00:00.000Z', overdue: false })
  })

  it('marks a passed next run as overdue instead of rolling it forward', () => {
    // 后端没有调度器：过了点就该如实说「逾期」，不能假装下一轮已经排好。
    const item = routineItemOf(record({ cycle: 'hourly', last_run: '2026-11-11T09:00:00.000Z' }), NOW)
    expect(item).toMatchObject({ next_run: '2026-11-11T10:00:00.000Z', overdue: true })
  })

  it('skips records it cannot read whole rather than assembling half a row', () => {
    for (const bad of [undefined, null, 'x', [], {}, { id: 'a' }, { id: 'a', title: 'b' },
      { id: 'a', title: 'b', cycle: 'every-5-minutes' }, { title: 'b', cycle: 'daily' }]) {
      expect(routineItemOf(bad, NOW)).toBeUndefined()
    }
  })

  it('drops an unreadable last run instead of writing an invalid date on screen', () => {
    const item = routineItemOf(record({ last_run: '昨天' }), NOW)
    expect(item).not.toHaveProperty('last_run')
    // 读不懂的时间不能拿来当参照：退回建账时间。
    expect(item?.next_run).toBe('2026-11-12T09:00:00.000Z')
  })

  it('keeps the title readable and defaults an unstated switch to on', () => {
    const item = routineItemOf(record({ title: 'x'.repeat(300), enabled: undefined }), NOW)
    expect(item?.title).toHaveLength(100)
    expect(item?.enabled).toBe(true)
    expect(routineItemOf(record({ enabled: false }), NOW)?.enabled).toBe(false)
    expect(routineItemOf(record({ bot_id: '  ' }), NOW)).not.toHaveProperty('bot_id')
  })
})

describe('parseCycle', () => {
  it('accepts only the three cycles it can really count', () => {
    expect(['hourly', 'daily', 'weekly'].map(parseCycle)).toEqual(['hourly', 'daily', 'weekly'])
    for (const value of ['', 'minute', 'DAILY', '@daily', 1, undefined]) expect(parseCycle(value)).toBeUndefined()
  })
})

describe('countRoutines', () => {
  it('counts open and switched-off routines apart', () => {
    const items = [routineItemOf(record(), NOW)!, routineItemOf(record({ id: 'b', enabled: false }), NOW)!]
    expect(countRoutines(items)).toEqual({ enabled: 1, paused: 1 })
    expect(countRoutines([])).toEqual({ enabled: 0, paused: 0 })
  })
})

describe('routinesView', () => {
  it('says live and puts open routines before switched-off ones', async () => {
    const view = await routinesView(() => [record({ id: 'off', enabled: false }), record({ id: 'on' })], NOW)
    expect(view.state).toBe('live')
    expect(view.items.map(item => item.id)).toEqual(['on', 'off'])
    expect(view.counts).toEqual({ enabled: 1, paused: 1 })
    // 这一栏还不能真的按点跑：runner 是 none，客户端据此不画「已排好」。
    expect(view.runner).toBe('none')
  })

  it('says empty only when the ledger was readable and holds nothing', async () => {
    const view = await routinesView(() => [], NOW)
    expect(view).toMatchObject({ state: 'empty', items: [], counts: { enabled: 0, paused: 0 }, runner: 'none' })
    expect(view.reason).toContain('还没有常规任务')
    // 一条认不出来的记录不算「有账」：整栏仍是空，不拿半个字段凑一行。
    expect((await routinesView(() => [{ id: 'x' }], NOW)).state).toBe('empty')
  })

  it('says unavailable when the ledger could not be read', async () => {
    const view = await routinesView(() => { throw new Error('disk gone') }, NOW)
    expect(view).toMatchObject({ state: 'unavailable', items: [], runner: 'none' })
    expect(view.reason).toContain('读不出来')
    // 「读不到」绝不能借用空态那两句话。
    expect(view.reason).not.toContain('还没有')
  })

  it('caps what it hands to the phone', async () => {
    const many = Array.from({ length: 140 }, (_, index) => record({ id: `r${index}` }))
    expect((await routinesView(() => many, NOW)).items).toHaveLength(100)
  })
})

describe('写侧：buildRoutine / editRoutine', () => {
  it('builds a valid record and rejects missing title, bad cycle and bad bot_id', async () => {
    const { buildRoutine } = await import('../src/app/routines.ts')
    const good = buildRoutine({ title: '每周复盘', cycle: 'weekly', bot_id: 'lead' }, 'rt-1', NOW)
    expect(good.ok).toBe(true)
    if (good.ok) expect(good.record).toMatchObject({ id: 'rt-1', title: '每周复盘', cycle: 'weekly', bot_id: 'lead', enabled: true })
    expect(buildRoutine({ title: '  ', cycle: 'daily' }, 'rt-2', NOW)).toMatchObject({ ok: false })
    expect(buildRoutine({ title: 'x', cycle: '每5分钟' }, 'rt-3', NOW)).toMatchObject({ ok: false })
    expect(buildRoutine({ title: 'x', cycle: 'daily', bot_id: 'Bad' }, 'rt-4', NOW)).toMatchObject({ ok: false })
  })

  it('edits in place, keeping created_at and last_run', async () => {
    const { editRoutine } = await import('../src/app/routines.ts')
    const current = { id: 'r1', title: 'old', cycle: 'daily' as const, bot_id: 'lead', enabled: true,
      created_at: '2026-11-01T00:00:00.000Z', last_run: '2026-11-10T00:00:00.000Z' }
    const edited = editRoutine(current, { title: 'new', enabled: false })
    expect(edited.ok).toBe(true)
    if (edited.ok) expect(edited.record).toMatchObject({ id: 'r1', title: 'new', cycle: 'daily', bot_id: 'lead', enabled: false,
      created_at: '2026-11-01T00:00:00.000Z', last_run: '2026-11-10T00:00:00.000Z' })
    // 清掉 bot_id：回「谁有空谁接」。
    const cleared = editRoutine(current, { bot_id: '' })
    if (cleared.ok) expect(cleared.record.bot_id).toBeUndefined()
  })
})
