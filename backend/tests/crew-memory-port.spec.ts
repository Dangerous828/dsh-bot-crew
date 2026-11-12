/** 记忆端口：本机版与中枢版（第 1 步委托本机）行为一致，且探测/降级不改变现有结论。 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { LocalMemory } from '../src/memory/local.ts'
import { HubMemory } from '../src/memory/hub.ts'
import type { Fact } from '../src/memory/settle.ts'

const fact = (over: Partial<Fact> = {}): Fact => ({
  description: '以后都用 pnpm',
  body: '主人原话：「以后都用 pnpm，不要用 npm」',
  type: 'feedback', importance: 5, dedupe_key: 'person:以后都用-pnpm', ...over,
})

let directory: string
let store: Store
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'crew-port-')); store = new Store(join(directory, 'o.sqlite')) })
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

describe('记忆端口', () => {
  it('本机版：写一条、按 dedupe_key 幂等、能被 all() 与 forget 看到', () => {
    const memory = new LocalMemory({ store, bots: () => ['lead'] })
    const first = memory.upsert('lead', fact(), 'person:ou_a')
    expect(first.written).toHaveLength(1)
    // 同一事重说一遍：不新增。
    expect(memory.upsert('lead', fact(), 'person:ou_a').written).toHaveLength(0)
    expect(memory.all()).toHaveLength(1)
    expect(memory.forget(first.written[0]!.name)).toBe(true)
    expect(memory.all()[0]!.state).toBe('forgotten')
  })

  it('中枢版第 1 步委托本机：写账、召回、治理与本机版结果一致', () => {
    const local = new LocalMemory({ store, bots: () => ['lead'] })
    const hub = new HubMemory({ reachable: () => false, fallback: local })
    expect(hub.upsert('lead', fact(), 'person:ou_a').written).toHaveLength(1)
    expect(hub.all()).toHaveLength(1)
    // 中枢不可达时巩固也走本机（本机无 distill/episodic 配置 → 返回 0，不假装修理过）。
    return expect(hub.consolidate()).resolves.toEqual({ facts: 0, merged: 0, superseded: 0 })
  })

  it('本机版巩固：没配提炼器/日志源时不做任何事，不假装修理过', async () => {
    const memory = new LocalMemory({ store, bots: () => ['lead'] })
    expect(await memory.consolidate()).toEqual({ facts: 0, merged: 0, superseded: 0 })
  })
})
