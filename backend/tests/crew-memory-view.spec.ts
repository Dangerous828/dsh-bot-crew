import { describe, expect, it } from 'vitest'
import { memoryItemOf, memoryView, MEMORY_PAGE } from '../src/app/views/memory.ts'

const entry = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'bot-lead-report-style',
  bot_id: 'lead',
  description: '先说结论',
  body: '他习惯先看 error 数量。',
  type: 'feedback',
  importance: 5,
  state: 'active',
  created: 1_794_000_000,
  updated: 1_794_000_000,
  toHub: false,
  ...over,
})

describe('memoryItemOf', () => {
  it('maps a stored record to the shape the phone and desktop read', () => {
    expect(memoryItemOf(entry({ origin: 'person:owner', source: { ticket_id: 't1' } }))).toMatchObject({
      name: 'bot-lead-report-style', bot_id: 'lead', state: 'active', importance: 5, to_hub: false,
      origin: 'person:owner', source: { ticket_id: 't1' },
    })
  })

  it('skips a row without a name or without a body', () => {
    expect(memoryItemOf(entry({ name: '' }))).toBeUndefined()
    expect(memoryItemOf(entry({ body: '   ' }))).toBeUndefined()
    expect(memoryItemOf(null)).toBeUndefined()
    expect(memoryItemOf([])).toBeUndefined()
  })

  it('defaults an unknown state to active and a missing importance to 4', () => {
    expect(memoryItemOf(entry({ state: 'weird', importance: undefined }))).toMatchObject({ state: 'active', importance: 4 })
  })

  it('treats a broken timestamp as absent rather than inventing one', () => {
    expect(memoryItemOf(entry({ created: Number.NaN }))!.created).toBe(0)
  })
})

describe('memoryView', () => {
  it('keeps "nothing yet" apart from "could not read"', async () => {
    expect(await memoryView([])).toMatchObject({ state: 'empty' })
    expect(await memoryView(() => { throw new Error('db gone') })).toMatchObject({ state: 'unavailable' })
  })

  it('lists active records first and counts every state across the whole ledger', async () => {
    const view = await memoryView([
      entry({ name: 'a-old', state: 'forgotten', updated: 1_794_000_100 }),
      entry({ name: 'b-active', state: 'active', updated: 1_794_000_000 }),
      entry({ name: 'c-superseded', state: 'superseded' }),
    ])
    expect(view.state).toBe('live')
    expect(view.items.map(item => item.name)).toEqual(['b-active', 'a-old', 'c-superseded'])
    expect(view.counts).toEqual({ active: 1, forgotten: 1, superseded: 1 })
  })

  it('filters by bot without hiding the ledger-wide counts', async () => {
    const view = await memoryView([entry({ name: 'a', bot_id: 'lead' }), entry({ name: 'b', bot_id: 'writer' })], { bot: 'writer' })
    expect(view.items.map(item => item.name)).toEqual(['b'])
    expect(view.counts.active).toBe(2)
    expect(await memoryView([entry({ bot_id: 'lead' })], { bot: 'nobody' })).toMatchObject({ state: 'empty' })
  })

  it('caps the page and drops a row it cannot recognise without failing the column', async () => {
    const many = Array.from({ length: MEMORY_PAGE + 5 }, (_, index) => entry({ name: `m${index}` }))
    const view = await memoryView([...many, { junk: true }])
    expect(view.items).toHaveLength(MEMORY_PAGE)
    expect(view.state).toBe('live')
  })
})
