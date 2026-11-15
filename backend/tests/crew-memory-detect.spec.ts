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

  it('中枢可达时，检索真打 POST <hub>/memory/search，命中条目进注入', async () => {
    const calls: string[] = []
    const probe = new HubProbe({ hub: 'http://hub.local:8642', timeoutMs: 500, probe: async () => true })
    await probe.refresh()
    const local = new LocalMemory({ store, bots: () => ['lead'] })
    // 注入假 fetch：必须先于构造端口生效，HubHttp 在构造时就抓住了 fetch。
    const original = globalThis.fetch
    globalThis.fetch = (async (url: string | URL | Request) => {
      calls.push(String(url))
      return new Response(JSON.stringify({ entries: [{ name: 'bot-lead-a', body: '回复先给结论' }] }), { status: 200 })
    }) as typeof fetch
    try {
      const port = pickMemoryPort(local, probe)
      const text = await port.recall({ channels: [{ address: { bot_id: 'lead' } }] } as never, '风格')
      expect(calls[0]).toBe('http://hub.local:8642/memory/search')
      expect(text).toContain('回复先给结论')
    } finally { globalThis.fetch = original }
  })
})

describe('HubProbe.retarget（配置热生效）', () => {
  it('换地址后整套引用都换：base / hub / 探测 URL 一起走新值', async () => {
    const probed: string[] = []
    const probe = new HubProbe({ hub: 'http://old.hub/v1', timeoutMs: 1_000, ttlMs: 30_000,
      probe: async url => { probed.push(url); return true } })
    await probe.refresh()
    expect(probe.base()).toBe('http://old.hub/v1')
    probe.retarget({ hub: 'http://new.hub/v1/', timeoutMs: 4_000, token: {} })
    await probe.refresh()
    expect(probe.base()).toBe('http://new.hub/v1')
    expect(probe.hub()).toBe('http://new.hub/v1/')
    expect(probe.timeoutMs()).toBe(4_000)
    expect(probed.at(-1)).toBe('http://new.hub/v1/health')
    expect(probe.reachable()).toBe(true)
  })

  it('换配置时丢弃缓存结论：不沿用上一个中枢的可达性', async () => {
    let up = true
    const probe = new HubProbe({ hub: 'http://a/v1', timeoutMs: 500, ttlMs: 30_000, probe: async () => up })
    await probe.refresh()
    expect(probe.reachable()).toBe(true)
    up = false
    // 同一 TTL 内换配置：必须重探，不能把「上一个中枢可达」当成新中枢的结论。
    probe.retarget({ hub: 'http://b/v1', timeoutMs: 500, token: {} })
    await probe.refresh()
    expect(probe.reachable()).toBe(false)
  })

  it('地址与超时都没变、只换凭据引用时也重探（新 token 不必等下一个 TTL）', async () => {
    let token = ''
    let probed = 0
    const probe = new HubProbe({ hub: 'http://a/v1', timeoutMs: 500, ttlMs: 30_000,
      probe: async () => { probed += 1; return true }, token: { env: 'T' }, tokenIo: { env: () => token } })
    await probe.refresh()
    expect(probed).toBe(1)
    token = 'fresh'
    probe.retarget({ hub: 'http://a/v1', timeoutMs: 500, token: { env: 'T' } })
    await probe.refresh()
    expect(probed).toBe(2)
    expect(probe.token()).toBe('fresh')
  })

  it('换配置后「被拒」结论一并作废（否则新引用会继承旧结论）', async () => {
    const probe = new HubProbe({ hub: 'http://a/v1', timeoutMs: 500, probe: async () => true, token: { env: 'T' },
      tokenIo: { env: () => 'tok' } })
    await probe.refresh()
    probe.rejectAuth(401, 'invalid hub token')
    expect(probe.authState().state).toBe('rejected')
    probe.retarget({ hub: 'http://a/v1', timeoutMs: 500, token: { env: 'T2' } })
    // 状态在 retarget 里当场重算（不等网络）；可达性由随后那次探测兑现。
    expect(probe.authState().state).toBe('ok')
    await probe.ensureSettled()
    expect(probe.usable()).toBe(true)
  })

  it('空 hub 时 retarget 不探测、直接不可达', async () => {
    let probed = 0
    const probe = new HubProbe({ hub: 'http://a/v1', timeoutMs: 500, probe: async () => { probed += 1; return true } })
    await probe.refresh()
    probe.retarget({ hub: '', timeoutMs: 500, token: {} })
    await probe.refresh()
    expect(probed).toBe(1)
    expect(probe.reachable()).toBe(false)
  })

  it('配置代数：迟到的旧探测结果不改可达性、也不写日志', async () => {
    const logs: string[] = []
    let release!: (up: boolean) => void
    const probe = new HubProbe({ hub: 'http://old/v1', timeoutMs: 500, log: line => logs.push(line),
      probe: url => url.startsWith('http://old/')
        ? new Promise<boolean>(resolve => { release = resolve })
        : Promise.resolve(true) })
    const stale = probe.refresh()               // 旧中枢的探测悬着
    expect(probe.reachable()).toBe(false)
    probe.retarget({ hub: 'http://new/v1', timeoutMs: 500, token: {} })
    await probe.ensureSettled()                 // 新中枢探通
    expect(probe.reachable()).toBe(true)
    const logged = logs.length
    // 旧探测现在才回 false：配置已换，结论必须被丢弃（可达性仍是 true、也不写一行日志）。
    release(false)
    await stale
    expect(probe.reachable()).toBe(true)
    expect(logs).toHaveLength(logged)
  })
})
