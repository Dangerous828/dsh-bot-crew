/** 中枢探测：TTL 缓存、空地址不探测、可达/不可达切换、工厂选端口。 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { HubProbe, LocalMemory, pickMemoryPort } from '../src/memory/detect.ts'

let directory: string
let store: Store
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'crew-detect-')); store = new Store(join(directory, 'o.sqlite')) })
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

describe('HubProbe', () => {
  it('空地址永不探测、永不可达', async () => {
    let probed = 0
    const probe = new HubProbe({ hub: '', timeoutMs: 500, probe: async () => { probed += 1; return true } })
    expect(await probe.refresh()).toBe(false)
    expect(probe.reachable()).toBe(false)
    expect(probed).toBe(0)
  })

  it('可达后缓存，TTL 内不重复探测', async () => {
    let probed = 0
    const probe = new HubProbe({ hub: 'http://hub', timeoutMs: 500, ttlMs: 30_000, probe: async () => { probed += 1; return true } })
    expect(await probe.refresh(1_000)).toBe(true)
    expect(probe.reachable()).toBe(true)
    expect(await probe.refresh(2_000)).toBe(true)
    expect(probed).toBe(1) // TTL 内不再探
    expect(await probe.refresh(40_000)).toBe(true)
    expect(probed).toBe(2) // TTL 过期再探
  })

  it('探测失败即不可达', async () => {
    const probe = new HubProbe({ hub: 'http://hub', timeoutMs: 500, probe: async () => false })
    expect(await probe.refresh()).toBe(false)
    expect(probe.reachable()).toBe(false)
  })
})

describe('pickMemoryPort', () => {
  it('返回中枢版端口，中枢不可达时它的 recall 走本机', async () => {
    const local = new LocalMemory({ store, bots: () => ['lead'] })
    const probe = new HubProbe({ hub: '', timeoutMs: 500 })
    const port = pickMemoryPort(local, probe)
    const text = await port.recall({ channels: [] } as never, 'x')
    expect(typeof text).toBe('string')
  })
})
