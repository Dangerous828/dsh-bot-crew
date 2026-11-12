/** 睡眠期提炼与巩固：规则提炼器、原始料窗口、端到端「拉日志→提炼→入库→淘汰」。 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { LocalMemory } from '../src/memory/local.ts'
import { RuleDistiller, makeLlmDistiller } from '../src/memory/distill.ts'

let directory: string
let store: Store
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'crew-distill-')); store = new Store(join(directory, 'o.sqlite')) })
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

describe('RuleDistiller', () => {
  it('只提炼「像规矩」的句子，闲聊丢掉', async () => {
    const facts = await new RuleDistiller().distill('今天天气不错。以后都用 pnpm，不要用 npm。哈哈。', 1000)
    expect(facts).toHaveLength(1)
    expect(facts[0]!.body).toContain('以后都用 pnpm')
  })

  it('一段里同一话题只留一条', async () => {
    const facts = await new RuleDistiller().distill('以后先说结论。以后先说结论！', 1000)
    expect(facts).toHaveLength(1)
  })
})

describe('makeLlmDistiller', () => {
  it('解析模型返回的 JSON；坏 JSON 返回空，不污染账本', async () => {
    const good = makeLlmDistiller(async () => JSON.stringify({ facts: [{ description: '用 pnpm', body: '原话', type: 'feedback', importance: 5, dedupe_key: 'person:pnpm' }] }))
    expect(await good.distill('x', 1000)).toHaveLength(1)
    const bad = makeLlmDistiller(async () => 'not json')
    expect(await bad.distill('x', 1000)).toEqual([])
    const boom = makeLlmDistiller(async () => { throw new Error('model down') })
    expect(await boom.distill('x', 1000)).toEqual([])
  })
})

describe('睡眠期巩固端到端', () => {
  it('从原始日志提炼出规矩并入库，无相关日志时不写', async () => {
    const memory = new LocalMemory({ store, bots: () => ['lead'],
      distill: (text, at) => new RuleDistiller().distill(text, at),
      episodic: () => [{ text: '随便聊了几句今天的事，然后明确交代一句：以后都先说结论，再展开细节。', at: 1000 }] })
    const done = await memory.consolidate({})
    expect(done.facts).toBe(1)
    expect(memory.all().some(entry => entry.body.includes('先说结论'))).toBe(true)

    const empty = new LocalMemory({ store: new Store(join(directory, 'second.sqlite')), bots: () => ['lead'], episodic: () => [] })
    expect((await empty.consolidate({})).facts).toBe(0)
  })
})
