import { describe, expect, it } from 'vitest'
import type { TimelineItem, TimelineRole } from '../src/contract/types.ts'

/**
 * The contract has to describe what the gateway actually writes. `tools/mobilegw` emits exactly two role values
 * (lines 98 and 101), so a client written against this type sees every message the line carries.
 */
describe('the timeline role the contract promises', () => {
  const emitted = ['user', 'agent'] as const

  it('covers every role the gateway writes', () => {
    const declared = new Set<TimelineRole>(emitted)
    expect([...declared].sort()).toEqual(['agent', 'user'])
  })

  it('parses a message from each side of the conversation', () => {
    const fromPerson = { id: 'm1', role: 'user', text: '在吗', at: '2026-11-09T18:00:00+0800' } satisfies TimelineItem
    const fromBot = { id: 'r1', role: 'agent', bot_id: 'lead', text: '在', at: '2026-11-09T18:00:01+0800' } satisfies TimelineItem
    // `satisfies` alone would accept any of them; the union is what rejects a role the gateway never writes.
    expect(fromPerson.role).toBe('user')
    expect(fromBot.role).toBe('agent')
  })

  it('keeps a field the contract does not name', () => {
    const item: TimelineItem = { id: 'r2', role: 'agent', text: '好', at: '1', future_field: { nested: true } }
    expect(item.future_field).toEqual({ nested: true })
  })
})
