import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import type { TimelineItem, TimelineRole } from '../src/contract/types.ts'

/**
 * The contract has to describe what the gateway actually writes. The expected values come from `tools/mobilegw`
 * itself, not from the contract: a version of this test built out of the contract's own union passed unchanged
 * when the union was widened to include `'bot' | 'system'`, so it proved nothing about the wire.
 */
async function gatewayRoles(): Promise<string[]> {
  const source = await readFile(new URL('../tools/mobilegw', import.meta.url), 'utf8')
  // The two points that stamp a role on an entry: one for a person's message, one for a Bot's reply.
  const stamped = [...source.matchAll(/'role':\s*'([a-z]+)'/g)].map(match => match[1]!)
  return [...new Set(stamped)].sort()
}

describe('the timeline role the gateway promises', () => {
  it('declares exactly the roles the gateway writes', async () => {
    const written = await gatewayRoles()
    // A guard against the regex silently matching nothing and the test passing vacuously.
    expect(written.length).toBeGreaterThan(0)
    // The set the contract's union admits is checked by tsc, not here: see `tests/contract-narrow.ts`.
    expect(written).toEqual(['agent', 'user'])
  })

  it('parses a message from each side of the conversation', () => {
    const fromPerson = { id: 'm1', role: 'user', text: '在吗', at: '2026-11-09T18:00:00+0800' } satisfies TimelineItem
    const fromBot = { id: 'r1', role: 'agent', bot_id: 'lead', text: '在', at: '2026-11-09T18:00:01+0800' } satisfies TimelineItem
    expect(fromPerson.role).toBe('user')
    expect(fromBot.role).toBe('agent')
  })

  it('keeps a field the contract does not name', () => {
    const item: TimelineItem = { id: 'r2', role: 'agent', text: '好', at: '1', future_field: { nested: true } }
    expect(item.future_field).toEqual({ nested: true })
  })
})

// hook probe
