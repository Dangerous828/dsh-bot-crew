import { describe, expect, it } from 'vitest'
import { defaultBot } from '../src/crew/directory.ts'
import { compose, freshness, grams, injectText, line, rank, relevance, score, usable, type MemoryEntry }
  from '../src/memory/recall.ts'
import { factOfFinishedTicket, factOfPersonMessage, looksDurable } from '../src/memory/settle.ts'

const NOW = 1_794_000_000
const entry = (over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  name: 'bot-lead-report-style',
  description: '报告先说结论，再给证据',
  body: '他习惯先看一眼 error 数量，再决定要不要展开。\n\n次段不进注入片段。',
  type: 'feedback',
  toHub: true,
  dedupe_key: 'lead-report-style',
  created: NOW,
  updated: NOW,
  bot_id: 'lead',
  state: 'active',
  importance: 5,
  ...over,
})

describe('grams', () => {
  it('splits Chinese into character pairs without punctuation', () => {
    expect(grams('先给结论，')).toEqual(['先给', '给结', '结论'])
  })

  it('keeps a single character query as itself and drops empties', () => {
    expect(grams('好')).toEqual(['好'])
    expect(grams('，。！')).toEqual([])
  })
})

describe('relevance', () => {
  it('finds a record by the words a person would use, not the exact wording', () => {
    // 「先说结论」与「先说结论」措辞不同但仍应命中。
    expect(relevance('报告先说结论', entry())).toBeGreaterThan(0)
    expect(relevance('结论 证据', entry())).toBeGreaterThan(0)
  })

  it('scores zero for an unrelated query', () => {
    expect(relevance('今天的天气怎么样', entry())).toBe(0)
  })

  it('scores zero for an empty query', () => {
    expect(relevance('，。', entry())).toBe(0)
  })
})

describe('rank', () => {
  it('keeps only active, relevant records', () => {
    const rows = [
      entry({ name: 'a', dedupe_key: 'a' }),
      entry({ name: 'b', dedupe_key: 'b', state: 'forgotten' }),
      entry({ name: 'c', dedupe_key: 'c', state: 'superseded' }),
      entry({ name: 'd', dedupe_key: 'd', description: '今天天气不错', body: '无关' }),
    ]
    expect(rank(rows, '先说结论')).toEqual([expect.objectContaining({ entry: expect.objectContaining({ name: 'a' }) })])
  })

  it('filters by bot namespace when asked', () => {
    const rows = [entry({ name: 'lead-note', bot_id: 'lead' }), entry({ name: 'writer-note', bot_id: 'writer' })]
    expect(rank(rows, '先说结论', { bots: ['writer'] }).map(hit => hit.entry.name)).toEqual(['writer-note'])
  })

  it('orders ties deterministically by recency then name', () => {
    const older = entry({ name: 'older', updated: NOW - 10 })
    const newer = entry({ name: 'newer', updated: NOW })
    const same = entry({ name: 'same', updated: NOW })
    const sorted = rank([older, newer, same], '结论', { now: NOW }).map(hit => hit.entry.name)
    expect(sorted[0]).toBe('newer')
    expect(sorted[1]).toBe('same')
  })

  it('lets a fresher record outrank a stale one of equal relevance', () => {
    // `updated` 是秒，NOW 是毫秒：120 天 = 120 * 86400 秒。
    const stale = entry({ name: 'stale', updated: NOW - 86_400 * 120 })
    const fresh = entry({ name: 'fresh', updated: NOW })
    expect(score('结论', fresh, NOW)).toBeGreaterThan(score('结论', stale, NOW))
    expect(freshness(fresh, NOW)).toBeGreaterThan(freshness(stale, NOW))
  })
})

describe('compose', () => {
  it('drops a whole line rather than cutting it, and reports what fitted', () => {
    const hits = rank([entry()], '结论', { now: NOW })
    const one = [...line(entry())].length
    const tight = compose(hits, one)
    expect(tight.taken).toHaveLength(1)
    const tooTight = compose(hits, one - 1)
    expect(tooTight.text).toBe('')
    expect(tooTight.taken).toHaveLength(0)
    expect(tooTight.chars).toBe(0)
  })

  it('only injects the first paragraph of the body', () => {
    expect(line(entry())).not.toContain('次段')
    expect(line(entry())).toContain('他习惯先看一眼')
  })

  it('wraps the fragment so a worker knows it is context, not the request', () => {
    const text = injectText(compose(rank([entry()], '结论', { now: NOW }), 2000))
    expect(text).toContain('不是这次的要求')
    expect(text).toContain('先说结论')
    expect(injectText({ text: '' })).toBe('')
  })
})

describe('usable', () => {
  it('accepts active records and refuses the rest', () => {
    expect(usable({ state: 'active' })).toBe(true)
    expect(usable({ state: 'active' }, { disabled: true })).toBe(false)
    expect(usable({ state: 'forgotten' })).toBe(false)
    expect(usable({ state: 'superseded' })).toBe(false)
  })
})

describe('settle: which sentences are durable', () => {
  it('recognises a standing rule stated in different ways', () => {
    expect(looksDurable('以后都用 pnpm，不要用 npm')).toBe(true)
    expect(looksDurable('记住：提交前跑一遍测试')).toBe(true)
    expect(looksDurable('我习惯先看 error 数量')).toBe(true)
    expect(looksDurable('从今以后别动 launchd 那个任务')).toBe(true)
  })

  it('treats ordinary chatter as not worth remembering', () => {
    expect(looksDurable('今天天气不错')).toBe(false)
    expect(looksDurable('好')).toBe(false)
    expect(looksDurable('帮我看看这个文件')).toBe(false)
  })

  it('builds a fact with a single-line description and a stable dedupe key', () => {
    const fact = factOfPersonMessage('以后都用 pnpm，不要用 npm。\n换行也不行', NOW)
    expect(fact).toBeDefined()
    expect(fact!.description).not.toContain('\n')
    expect(fact!.dedupe_key.startsWith('person:')).toBe(true)
    // 同一句原话重说一遍，键得一样（重试不能长出第二条）。
    expect(factOfPersonMessage('以后都用 pnpm，不要用 npm', NOW)!.dedupe_key)
      .toBe(factOfPersonMessage('以后都用 pnpm，不要用 npm', NOW)!.dedupe_key)
  })

  it('does not turn chatter into a fact', () => {
    expect(factOfPersonMessage('今天天气不错', NOW)).toBeUndefined()
  })
})

describe('settle: ticket conclusions', () => {
  it('records a finished or dropped ticket under its id', () => {
    const ready = factOfFinishedTicket({ id: 't1', title: '修卡顿', bot_id: lead() }, { state: 'ready', summary: '合进主分支' }, NOW)
    expect(ready).toBeDefined()
    expect(ready!.dedupe_key).toBe('ticket:t1')
    expect(ready!.description).toContain('已办完')
    expect(factOfFinishedTicket({ id: 't1' }, { state: 'dropped', summary: '范围太大' }, NOW)!.description).toContain('已放弃')
  })

  it('skips progress and empty summaries', () => {
    expect(factOfFinishedTicket({ id: 't1' }, { state: 'progress', summary: '做了一半' }, NOW)).toBeUndefined()
    expect(factOfFinishedTicket({ id: 't1' }, { state: 'ready', summary: '  ' }, NOW)).toBeUndefined()
  })
})

function lead(): string {
  return defaultBot({ bots: [{ bot_id: 'lead', name: 'Lead', role: 'default', memory_namespace: 'bot/lead' }], default_bot_id: 'lead' }).bot_id
}
