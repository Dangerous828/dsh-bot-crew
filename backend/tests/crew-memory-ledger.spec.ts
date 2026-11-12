import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryLedger } from '../src/app/memory.ts'
import { Store } from '../src/app/store.ts'
import { KV } from '../src/kv.ts'
import type { Fact } from '../src/memory/settle.ts'
import { rank } from '../src/memory/recall.ts'

const fact = (over: Partial<Fact> = {}): Fact => ({
  description: '以后都用 pnpm',
  body: '主人原话：「以后都用 pnpm，不要用 npm」',
  type: 'feedback',
  importance: 5,
  dedupe_key: 'person:以后都用-pnpm',
  ...over,
})

let directory: string
let store: Store
let ledger: MemoryLedger

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'crew-memory-'))
  store = new Store(join(directory, 'orchestrator.sqlite'))
  ledger = new MemoryLedger(store)
})

afterEach(() => {
  store.close()
  rmSync(directory, { recursive: true, force: true })
})

describe('MemoryLedger.settle', () => {
  it('writes one entry under the bot namespace', () => {
    const result = ledger.settle({ bot_id: 'lead', fact: fact(), origin: 'person:owner' })
    expect(result.written).toHaveLength(1)
    expect(result.written[0]).toMatchObject({ bot_id: 'lead', state: 'active', toHub: false, origin: 'person:owner' })
    expect(store.get(KV.memory.entry('bot-lead-person-以后都用-pnpm'))).toBeDefined()
    expect(ledger.ofBot('lead')).toHaveLength(1)
  })

  it('is idempotent for the same fact: retrying a turn does not grow the ledger', () => {
    ledger.settle({ bot_id: 'lead', fact: fact(), origin: 'person:owner' })
    const again = ledger.settle({ bot_id: 'lead', fact: fact(), origin: 'person:owner' })
    expect(again.written).toEqual([])
    expect(ledger.all()).toHaveLength(1)
  })

  it('keeps the created time and moves updated when the fact is restated with a new body', () => {
    const first = ledger.settle({ bot_id: 'lead', fact: fact(), origin: 'person:owner' }).written[0]!
    const second = ledger.settle({ bot_id: 'lead', fact: fact({ body: '主人原话：「以后都用 pnpm，别用 npm」' }), origin: 'person:owner' })
    expect(second.written).toHaveLength(1)
    expect(second.written[0]!.created).toBe(first.created)
    expect(second.written[0]!.updated).toBeGreaterThanOrEqual(first.updated)
  })

  it('supersedes a record the same key lands on under a different name, keeping history', () => {
    // 键一样但 slug 变了（标点不同会落成两个文件名）：新条替掉旧条，旧条翻成 superseded 而不是删掉。
    ledger.settle({ bot_id: 'lead', fact: fact({ dedupe_key: 'person:pin' }), origin: 'person:owner' })
    const first = ledger.all()[0]!
    ledger.settle({ bot_id: 'lead', fact: fact({ dedupe_key: 'person:/pin', body: '新说法' }), origin: 'person:owner' })
    const all = ledger.all()
    // `person:pin` 与 `person:/pin` 去重后 slug 都是 person-pin —— 同一个文件。
    expect(all.filter(entry => entry.state === 'active')).toHaveLength(1)
    expect(all[0]!.created).toBe(first.created)
  })

  it('keeps two different keys as two active records', () => {
    ledger.settle({ bot_id: 'lead', fact: fact({ dedupe_key: 'a', description: '账一' }), origin: 'host' })
    ledger.settle({ bot_id: 'lead', fact: fact({ dedupe_key: 'b', description: '账二' }), origin: 'host' })
    expect(ledger.all().filter(entry => entry.state === 'active')).toHaveLength(2)
  })

  it('separates bots by namespace even when the dedupe key repeats', () => {
    ledger.settle({ bot_id: 'lead', fact: fact(), origin: 'host' })
    ledger.settle({ bot_id: 'writer', fact: fact(), origin: 'host' })
    expect(ledger.ofBot('lead')).toHaveLength(1)
    expect(ledger.ofBot('writer')).toHaveLength(1)
  })
})

describe('MemoryLedger.forget / edit', () => {
  it('forgets by flipping state, never by deleting the row', () => {
    const [entry] = ledger.settle({ bot_id: 'lead', fact: fact(), origin: 'host' }).written
    expect(ledger.forget(entry!.name)).toBe(true)
    const kept = store.get(KV.memory.entry(entry!.name))
    expect(kept).toMatchObject({ state: 'forgotten' })
    // 被忘掉的条目不再参与召回。
    expect(rank(ledger.all(), 'pnpm')).toEqual([])
  })

  it('reports a miss for a name that does not exist', () => {
    expect(ledger.forget('bot-lead-nope')).toBe(false)
    expect(ledger.edit('bot-lead-nope', { body: 'x' })).toBe(false)
  })

  it('evicts a forgotten entry only after 30 days without a later recall', () => {
    const [entry] = ledger.settle({ bot_id: 'lead', fact: fact(), origin: 'host' }).written
    const forgottenAt = Math.floor(Date.now() / 1000)
    ledger.forget(entry!.name)
    // 刚进遗忘区：不删。
    expect(ledger.evict(forgottenAt + 60)).toEqual([])
    expect(store.get(KV.memory.entry(entry!.name))).toBeDefined()
    // 过了 30 天、期间没被调起：真删。
    const later = forgottenAt + 31 * 24 * 60 * 60
    expect(ledger.evict(later)).toEqual([entry!.name])
    expect(store.get(KV.memory.entry(entry!.name))).toBeUndefined()
  })

  it('keeps a forgotten entry that was recalled again after being forgotten', () => {
    const [entry] = ledger.settle({ bot_id: 'lead', fact: fact(), origin: 'host' }).written
    const forgottenAt = Math.floor(Date.now() / 1000)
    ledger.forget(entry!.name)
    // 遗忘后又"被调起"（lastUsedAt 晚于 forgottenAt）：即便过了 30 天也不淘汰。
    ledger.touch([entry!.name], forgottenAt + 100)
    expect(ledger.evict(forgottenAt + 31 * 24 * 60 * 60)).toEqual([])
    expect(store.get(KV.memory.entry(entry!.name))).toBeDefined()
  })

  it('edits description and body, and refuses what the renderer would refuse', () => {
    const [entry] = ledger.settle({ bot_id: 'lead', fact: fact(), origin: 'host' }).written
    expect(ledger.edit(entry!.name, { description: '改用 pnpm', body: '改过的正文' })).toBe(true)
    expect(ledger.all()[0]).toMatchObject({ description: '改用 pnpm', body: '改过的正文' })
    expect(() => ledger.edit(entry!.name, { description: 'a\nb' })).toThrow(/single line/)
    expect(() => ledger.edit(entry!.name, { body: '   ' })).toThrow(/must not be empty/)
  })
})

describe('MemoryLedger rendering', () => {
  it('renders the plugin frontmatter and plans a path under the bot namespace', () => {
    const [entry] = ledger.settle({ bot_id: 'lead', fact: fact(), origin: 'host' }).written
    const text = ledger.render(entry!)
    expect(text.startsWith('---\n')).toBe(true)
    expect(text).toContain('dedupe_key:')
    const plan = ledger.plan('/mem', entry!)
    expect(plan.path.startsWith('/mem/bot/lead/bot-lead-')).toBe(true)
  })

  it('survives a corrupt row instead of failing the whole ledger', () => {
    store.set(KV.memory.entry('bot-lead-broken'), { garbage: true } as never)
    ledger.settle({ bot_id: 'lead', fact: fact(), origin: 'host' })
    expect(ledger.all()).toHaveLength(2)
    expect(ledger.all().filter(entry => entry.state === 'active')).toHaveLength(1)
  })
})
