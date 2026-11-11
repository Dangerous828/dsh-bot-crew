import { describe, expect, it } from 'vitest'
import { MAX_SUMMARY_CHARS, MIN_SUMMARY_CHARS, summaryFact, worthRemembering } from '../src/app/compact-memory.ts'

const long = (chars: number): string => '会'.repeat(chars)

describe('worthRemembering', () => {
  it('takes a real compaction summary', () => {
    expect(worthRemembering({ type: 'compaction/summary', summary: long(MIN_SUMMARY_CHARS) })).toBe(true)
  })

  it('drops anything else: not that event, blank, or too short to carry facts', () => {
    expect(worthRemembering(undefined)).toBe(false)
    expect(worthRemembering({ type: 'user/message', summary: long(500) })).toBe(false)
    expect(worthRemembering({ type: 'compaction/summary', summary: '   ' })).toBe(false)
    expect(worthRemembering({ type: 'compaction/summary', summary: long(MIN_SUMMARY_CHARS - 1) })).toBe(false)
  })
})

describe('summaryFact', () => {
  it('marks the fact as a folded summary, not as something the owner said', () => {
    const fact = summaryFact({ type: 'compaction/summary', summary: long(200), replaced: 42, compactionId: 'c1' },
      '2026-11-12T00:00:00.000Z')
    expect(fact.description).toBe('这段会话的摘要')
    expect(fact.body).toContain('折于 2026-11-12T00:00:00.000Z')
    expect(fact.body).toContain('折掉 42 条')
  })

  it('keys on the compaction so a retried write stays idempotent', () => {
    const one = summaryFact({ type: 'compaction/summary', summary: long(200), compactionId: 'c1' })
    const two = summaryFact({ type: 'compaction/summary', summary: long(200), compactionId: 'c1' })
    expect(one.dedupe_key).toBe(two.dedupe_key)
    expect(one.dedupe_key).toBe('compact:c1')
  })

  it('falls back to a content fingerprint when there is no compaction id', () => {
    const one = summaryFact({ type: 'compaction/summary', summary: long(200) })
    const two = summaryFact({ type: 'compaction/summary', summary: long(200) })
    const other = summaryFact({ type: 'compaction/summary', summary: long(201) })
    expect(one.dedupe_key).toBe(two.dedupe_key)
    expect(one.dedupe_key).not.toBe(other.dedupe_key)
  })

  it('clips an over-long summary and says there is more', () => {
    const fact = summaryFact({ type: 'compaction/summary', summary: long(MAX_SUMMARY_CHARS + 500) })
    expect(fact.body).toContain('后面还有，已折叠')
    expect(fact.body.length).toBeLessThan(MAX_SUMMARY_CHARS + 200)
  })

  it('leaves a short summary whole', () => {
    const fact = summaryFact({ type: 'compaction/summary', summary: long(200) })
    expect(fact.body).not.toContain('后面还有')
  })
})
