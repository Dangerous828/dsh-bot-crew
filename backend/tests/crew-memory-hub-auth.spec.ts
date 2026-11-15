/**
 * 中枢凭据通道：引用式配置、401/403 可观察、/v1 路径、脱敏。
 *
 * 这一份测的是**契约**，不是实现细节：
 * - 没配 token → 不带 header（免鉴权中枢仍能用），且状态如实说「没有凭据引用」；
 * - token 错 → 401 被单独识别，hub 标 rejected，日志明确否定，不出现「reached」式假成功；
 * - token 对 → header 带上了、条目进注入、状态回 ok；
 * - base 含 `/v1` → 请求落在 `/v1/memory/*`，探测落在 `/v1/health`；
 * - token 值不出现在任何日志、health、错误消息与设置视图里。
 */
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { MemoryConfigSchema } from '../src/policy.ts'
import { envFileValue, hubHealthOf, HubAuth, readHubToken, redactToken } from '../src/memory/auth.ts'
import { HubProbe, LocalMemory, pickMemoryPort } from '../src/memory/detect.ts'
import { HubAuthError, hubBots, HubHttp, isHubAuthError } from '../src/memory/hub-client.ts'
import { HubMemory } from '../src/memory/hub.ts'

const HUB = 'https://jarvis.example.top/v1'
const TOKEN = 'hub-token-abcdef0123456789'
const WRONG = 'hub-token-wrong-999999999999'

/** 假 fetch：按 header 里的 token 决定回 200 还是 401（模拟真实中枢的 require_token）。 */
function hubFetch(options: { token?: string; entries?: unknown[]; consolidate?: unknown } = {}) {
  const calls: { url: string; headers: Record<string, string>; body: unknown }[] = []
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({ url: String(url), headers, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const supplied = headers['x-hub-token']
    if (options.token !== undefined && supplied !== options.token) {
      return new Response(JSON.stringify({ detail: 'invalid hub token' }), { status: 401, headers: { 'content-type': 'application/json' } })
    }
    if (String(url).endsWith('/memory/search')) {
      return new Response(JSON.stringify({ entries: options.entries ?? [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify(options.consolidate ?? { facts: 0, merged: 0, superseded: 0 }), { status: 200,
      headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'crew-hub-auth-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

describe('凭据引用解析', () => {
  it('两项都空 → 没有 token，也没问题可报', () => {
    const read = readHubToken({}, { env: () => undefined })
    expect(read).toEqual({ token: '', source: 'none' })
  })

  it('环境变量优先于文件', () => {
    const file = join(directory, 'env')
    writeFileSync(file, 'HUB_TOKEN=from-file\n')
    chmodSync(file, 0o600)
    const read = readHubToken({ env: 'HUB_TOKEN', file }, { env: () => 'from-env' })
    expect(read.token).toBe('from-env')
    expect(read.source).toBe('env')
  })

  it('环境里没有时读文件里的同名键（env-file 形状）', () => {
    const file = join(directory, 'env')
    writeFileSync(file, '# comment\nset -a\nexport HUB_TOKEN="from-file"\nOTHER=1\n')
    chmodSync(file, 0o600)
    const read = readHubToken({ env: 'HUB_TOKEN', file }, { env: () => undefined })
    expect(read).toEqual({ token: 'from-file', source: 'file' })
  })

  it('只给文件时整份内容就是 token', () => {
    const file = join(directory, 'token')
    writeFileSync(file, `${TOKEN}\n`)
    chmodSync(file, 0o600)
    expect(readHubToken({ file }, { env: () => undefined })).toEqual({ token: TOKEN, source: 'file' })
  })

  it('文件读不出来 / 键不存在 / 空值 → 如实报问题，不返回半个 token', () => {
    const missing = readHubToken({ file: join(directory, 'nope') }, { env: () => undefined })
    expect(missing.token).toBe('')
    expect(missing.problem).toContain('读不出来')

    const file = join(directory, 'env')
    writeFileSync(file, 'OTHER=1\n')
    chmodSync(file, 0o600)
    const noKey = readHubToken({ env: 'HUB_TOKEN', file }, { env: () => undefined })
    expect(noKey.token).toBe('')
    expect(noKey.problem).toContain('没有 HUB_TOKEN')

    writeFileSync(file, 'HUB_TOKEN=\n')
    const blank = readHubToken({ env: 'HUB_TOKEN', file }, { env: () => undefined })
    expect(blank.token).toBe('')
    expect(blank.problem).toContain('空值')
  })

  it('权限过宽仍然可用，但把问题说出来（不静默）', () => {
    const file = join(directory, 'env')
    writeFileSync(file, `HUB_TOKEN=${TOKEN}\n`)
    chmodSync(file, 0o644)
    const read = readHubToken({ env: 'HUB_TOKEN', file }, { env: () => undefined })
    expect(read.token).toBe(TOKEN)
    expect(read.problem).toContain('权限过宽')
  })

  it('含空白/换行的值不当 token 用', () => {
    const read = readHubToken({ env: 'HUB_TOKEN' }, { env: () => 'two words' })
    expect(read.token).toBe('')
    expect(read.problem).toContain('空白')
  })

  it('env-file 解析认 export、注释、引号，且同键取第一条', () => {
    const text = '# x\nexport A="1"\nB=2\nA=3\n'
    expect(envFileValue(text, 'A')).toBe('1')
    expect(envFileValue(text, 'B')).toBe('2')
    expect(envFileValue(text, 'C')).toBeUndefined()
  })

  it('脱敏：token 值被替换成 ***，空 token 不动文本', () => {
    expect(redactToken(`bad ${TOKEN} here`, TOKEN)).toBe('bad *** here')
    expect(redactToken('plain', '')).toBe('plain')
  })
})

describe('HTTP 客户端：header 与路径', () => {
  it('有 token 时发 X-Hub-Token；base 含 /v1 时落在 /v1/memory/search', async () => {
    const { fetchImpl, calls } = hubFetch({ token: TOKEN, entries: [{ name: 'bot-lead-a', body: '回复先给结论' }] })
    const hub = new HubHttp({ base: `${HUB}/`, fetchImpl, token: () => TOKEN })
    await hub.search({ query: '风格', limit: 6 })
    expect(calls[0]!.url).toBe('https://jarvis.example.top/v1/memory/search')
    expect(calls[0]!.headers['x-hub-token']).toBe(TOKEN)
    expect(calls[0]!.headers['content-type']).toBe('application/json')
  })

  it('没有 token 时不带 header（不发明空 header）', async () => {
    const { fetchImpl, calls } = hubFetch({ entries: [] })
    await new HubHttp({ base: HUB, fetchImpl, token: () => '' }).search({ query: 'x' })
    expect('x-hub-token' in calls[0]!.headers).toBe(false)
  })

  it('每次请求现读 token：换对了不用重建客户端', async () => {
    const { fetchImpl, calls } = hubFetch({ token: TOKEN, entries: [] })
    let current = ''
    const hub = new HubHttp({ base: HUB, fetchImpl, token: () => current })
    // 第一次没 token：中枢回 401（如实抛），但客户端本身仍可用。
    await expect(hub.search({ query: 'a' })).rejects.toBeInstanceOf(HubAuthError)
    current = TOKEN
    await hub.search({ query: 'b' })
    expect(calls[0]!.headers['x-hub-token']).toBeUndefined()
    expect(calls[1]!.headers['x-hub-token']).toBe(TOKEN)
  })

  it('401 抛 HubAuthError（不是普通 Error），403 同样归为鉴权', async () => {
    for (const status of [401, 403]) {
      const fetchImpl = (async () => new Response(JSON.stringify({ detail: 'invalid hub token' }), { status })) as unknown as typeof fetch
      const error = await new HubHttp({ base: HUB, fetchImpl, token: () => WRONG }).search({ query: 'x' }).catch(e => e)
      expect(isHubAuthError(error)).toBe(true)
      expect((error as HubAuthError).status).toBe(status)
    }
  })

  it('5xx 不是鉴权错误（分开归类，别把网络故障说成凭据问题）', async () => {
    const fetchImpl = (async () => new Response('boom', { status: 502 })) as unknown as typeof fetch
    const error = await new HubHttp({ base: HUB, fetchImpl, token: () => TOKEN }).search({ query: 'x' }).catch(e => e)
    expect(isHubAuthError(error)).toBe(false)
    expect(String(error)).toContain('502')
  })

  it('巩固：dry-run 的 merged 不被当成「执行过、合并了 0 条」', async () => {
    const { fetchImpl, calls } = hubFetch({ token: TOKEN, consolidate: { facts: 0, merged: 0, superseded: 0, dryRun: true, candidateMerges: 3 } })
    const done = await new HubHttp({ base: HUB, fetchImpl, token: () => TOKEN }).consolidate({ since: 1, until: 2 })
    expect(done).toEqual({ facts: 0, merged: 0, superseded: 0, dryRun: true, candidates: 3 })
    // 契约：客户端不传 apply，让中枢保持 dry-run。
    expect(calls[0]!.body).toEqual({ since: 1, until: 2 })
  })

  it('巩固：中枢真写了（无 dryRun）时不编造 dryRun 字段', async () => {
    const { fetchImpl } = hubFetch({ token: TOKEN, consolidate: { facts: 2, merged: 1, superseded: 0 } })
    expect(await new HubHttp({ base: HUB, fetchImpl, token: () => TOKEN }).consolidate({})).toEqual({ facts: 2, merged: 1, superseded: 0 })
  })

  it('鉴权错误消息里不含 token 值', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ detail: 'invalid hub token' }), { status: 401 })) as unknown as typeof fetch
    const error = await new HubHttp({ base: HUB, fetchImpl, token: () => TOKEN }).search({ query: 'x' }).catch(e => e)
    expect(String(error)).not.toContain(TOKEN)
  })
})

describe('探测 + 端口：三种凭据状态', () => {
  const ticket = { channels: [{ address: { bot_id: 'lead' } }] } as never

  it('token 缺失：探测通（免鉴权 /v1/health），但状态是 anonymous、不带 header', async () => {
    const logs: string[] = []
    const { fetchImpl, calls } = hubFetch({ token: TOKEN })
    const probe = new HubProbe({ hub: HUB, timeoutMs: 500, probe: async () => true, log: line => logs.push(line),
      token: {}, tokenIo: { env: () => undefined } })
    expect(await probe.refresh()).toBe(true)
    expect(probe.authState().state).toBe('anonymous')
    const local = new LocalMemory({ store: new Store(join(directory, 'a.sqlite')), bots: () => ['lead'] })
    const original = globalThis.fetch
    globalThis.fetch = fetchImpl
    try {
      const port = pickMemoryPort(local, probe)
      // 真的发了一次请求：中枢回 401 → 状态转 rejected，日志明确否定。
      await port.recall(ticket, '风格')
    } finally { globalThis.fetch = original }
    expect(calls[0]!.headers['x-hub-token']).toBeUndefined()
    expect(probe.authState()).toMatchObject({ state: 'rejected', status: 401 })
    expect(probe.usable()).toBe(false)
    expect(logs.join('\n')).toContain('鉴权被拒')
    // 关键：不能只有「reached」而没有任何否定说法。
    expect(logs.join('\n')).toMatch(/hub 未启用/)
  })

  it('token 错：401 → rejected，后续召回不再打网络（直接本机），health 是 error', async () => {
    const { fetchImpl, calls } = hubFetch({ token: TOKEN })
    const probe = new HubProbe({ hub: HUB, timeoutMs: 500, probe: async () => true, token: { env: 'HUB_TOKEN' },
      tokenIo: { env: () => WRONG } })
    await probe.refresh()
    expect(probe.authState().state).toBe('ok')
    const original = globalThis.fetch
    globalThis.fetch = fetchImpl
    try {
      const store = new Store(join(directory, 'b.sqlite'))
      store.settings()
      const port = pickMemoryPort(new LocalMemory({ store, bots: () => ['lead'] }), probe)
      expect(await port.recall(ticket, '风格')).toBe('')
      expect(calls).toHaveLength(1)
      // 被拒后不再打网络：省一次 3s 超时，也让日志不刷屏。
      await port.recall(ticket, '风格')
      expect(calls).toHaveLength(1)
      expect(hubHealthOf(HUB, probe.authState(), 'up')).toMatchObject({ state: 'error' })
      store.close()
    } finally { globalThis.fetch = original }
  })

  it('token 对：命中条目进注入，状态回 ok，health 是 ready', async () => {
    const { fetchImpl, calls } = hubFetch({ token: TOKEN, entries: [{ name: 'bot-lead-a', body: '回复先给结论' }] })
    const probe = new HubProbe({ hub: HUB, timeoutMs: 500, probe: async () => true, token: { env: 'HUB_TOKEN' },
      tokenIo: { env: () => TOKEN } })
    await probe.refresh()
    const store = new Store(join(directory, 'c.sqlite'))
    const original = globalThis.fetch
    globalThis.fetch = fetchImpl
    try {
      const port = pickMemoryPort(new LocalMemory({ store, bots: () => ['lead'] }), probe)
      const text = await port.recall(ticket, '风格')
      expect(text).toContain('回复先给结论')
      expect(calls[0]!.url).toBe(`${HUB}/memory/search`)
      expect(calls[0]!.headers['x-hub-token']).toBe(TOKEN)
      // 召回必须带本票的 bot_id：中枢的隔离只到 crew 命名空间，不带就是全队混用。
      expect(calls[0]!.body).toEqual({ query: '风格', bots: ['lead'], limit: 6 })
      expect(probe.authState().state).toBe('ok')
      expect(hubHealthOf(HUB, probe.authState(), 'up').state).toBe('ready')
      store.close()
    } finally { globalThis.fetch = original }
  })

  it('换对了 token 后下一轮重探自动恢复（不必重启）', async () => {
    let token = WRONG
    const { fetchImpl } = hubFetch({ token: TOKEN, entries: [{ name: 'bot-lead-a', body: 'x' }] })
    const probe = new HubProbe({ hub: HUB, timeoutMs: 500, ttlMs: 1_000, probe: async () => true, token: { env: 'HUB_TOKEN' },
      tokenIo: { env: () => token } })
    // 时间基必须与真实时钟同一域：`recall` 内部的保鲜用的是 `Date.now()`。
    const t0 = Date.now()
    await probe.refresh(t0)
    const store = new Store(join(directory, 'd.sqlite'))
    const original = globalThis.fetch
    globalThis.fetch = fetchImpl
    try {
      const port = pickMemoryPort(new LocalMemory({ store, bots: () => ['lead'] }), probe)
      await port.recall(ticket, 'x')
      expect(probe.authState().state).toBe('rejected')
      token = TOKEN
      await probe.refresh(t0 + 5_000) // TTL 过期 → 重探 + 重读凭据
      expect(probe.authState().state).toBe('ok')
      expect(await port.recall(ticket, 'x')).toContain('x')
      store.close()
    } finally { globalThis.fetch = original }
  })

  it('探测通但凭据被拒：日志同时说清 reached 与 NOT usable，不留下假成功', async () => {
    const logs: string[] = []
    const probe = new HubProbe({ hub: HUB, timeoutMs: 500, probe: async () => true, token: { env: 'HUB_TOKEN' },
      tokenIo: { env: () => WRONG }, log: line => logs.push(line) })
    await probe.refresh()
    // 首次 refresh 只是读凭据（ok）+ 可达；被拒要等真请求。这里模拟调用侧拿到 401。
    probe.rejectAuth(401, 'invalid hub token')
    const joined = logs.join('\n')
    expect(joined).toContain('鉴权被拒')
    expect(joined).toContain('hub 未启用')
  })

  it('health 四态：没配中枢 / 无凭据引用 / 就绪 / 被拒', () => {
    expect(hubHealthOf('', { state: 'unconfigured', source: 'none' })).toEqual({ state: 'ready', detail: '没有中枢：记忆全在本机' })
    // 配了地址但还没探过 → starting（刚启动不该挂一条假故障）。
    expect(hubHealthOf(HUB, { state: 'ok', source: 'env' }).state).toBe('starting')
    // 探测不通 → error，且说清是网络/地址/超时那一侧。
    expect(hubHealthOf(HUB, { state: 'ok', source: 'env' }, 'down')).toMatchObject({ state: 'error' })
    expect(hubHealthOf(HUB, { state: 'ok', source: 'env' }, 'down').detail).toContain('不可达')
    expect(hubHealthOf(HUB, { state: 'anonymous', source: 'none' }, 'up').state).toBe('paused')
    expect(hubHealthOf(HUB, { state: 'ok', source: 'env' }, 'up')).toMatchObject({ state: 'ready' })
    expect(hubHealthOf(HUB, { state: 'rejected', source: 'env', status: 401 }, 'up')).toMatchObject({ state: 'error' })
    expect(hubHealthOf(HUB, { state: 'rejected', source: 'env', status: 401 }, 'up').detail).toContain('hub 未启用')
  })
})

describe('HubAuth 状态机', () => {
  it('状态变化才写日志，同一句话不重复刷', () => {
    const logs: string[] = []
    const auth = new HubAuth({ env: 'HUB_TOKEN' }, { env: () => TOKEN, log: line => logs.push(line) })
    auth.refresh()
    auth.refresh()
    auth.refresh()
    expect(logs.filter(line => line.includes('鉴权就绪'))).toHaveLength(1)
  })

  it('被拒后 usable() 为 false，accept() 后恢复', () => {
    const auth = new HubAuth({ env: 'HUB_TOKEN' }, { env: () => TOKEN })
    auth.refresh()
    expect(auth.usable()).toBe(true)
    auth.reject(401, 'invalid hub token')
    expect(auth.usable()).toBe(false)
    expect(auth.snapshot()).toMatchObject({ state: 'rejected', status: 401 })
    auth.accept()
    expect(auth.usable()).toBe(true)
    expect(auth.snapshot().state).toBe('ok')
  })

  it('token 值不进 snapshot / 不进日志', () => {
    const logs: string[] = []
    const auth = new HubAuth({ env: 'HUB_TOKEN' }, { env: () => TOKEN, log: line => logs.push(line) })
    auth.refresh()
    auth.reject(401, 'invalid hub token')
    expect(JSON.stringify(auth.snapshot())).not.toContain(TOKEN)
    expect(logs.join('\n')).not.toContain(TOKEN)
  })
})

describe('中枢版端口的降级语义', () => {
  const ticket = { channels: [{ address: { bot_id: 'lead' } }] } as never

  it('凭据被拒后不再打网络：recall/consolidate 都直接本机，且不假报合并', async () => {
    const store = new Store(join(directory, 'e.sqlite'))
    const local = new LocalMemory({ store, bots: () => ['lead'] })
    let calls = 0
    const hub = new HubMemory({ reachable: () => true, fallback: local,
      auth: { usable: () => false, state: () => ({ state: 'rejected', source: 'env', status: 401 }),
        reject: () => undefined, accept: () => undefined },
      search: async () => { calls += 1; return [] },
      consolidate: async () => { calls += 1; return { facts: 9, merged: 9, superseded: 9 } } })
    expect(await hub.recall(ticket, 'x')).toBe('')
    // 本机无 distill/episodic → 0/0/0，不冒充中枢那组假计数。
    await expect(hub.consolidate({})).resolves.toEqual({ facts: 0, merged: 0, superseded: 0 })
    expect(calls).toBe(0)
    store.close()
  })

  it('中枢回 dry-run：返回值明确标 dryRun，且中枢那份读数单列在 hubPlan 里', async () => {
    const store = new Store(join(directory, 'f.sqlite'))
    const local = new LocalMemory({ store, bots: () => ['lead'] })
    const hub = new HubMemory({ reachable: () => true, fallback: local,
      consolidate: async () => ({ facts: 0, merged: 0, superseded: 0, dryRun: true, candidates: 4 }) })
    await expect(hub.consolidate({})).resolves.toEqual({ facts: 0, merged: 0, superseded: 0, dryRun: true, candidates: 4,
      hubPlan: { facts: 0, merged: 0, superseded: 0, dryRun: true, candidates: 4 } })
    store.close()
  })
})

describe('TTL 单飞与离线恢复', () => {
  it('TTL 内不重探；过期后并发 refresh 只探一次（单飞）', async () => {
    let probes = 0
    let release: (up: boolean) => void = () => undefined
    const probe = new HubProbe({ hub: HUB, timeoutMs: 500, ttlMs: 1_000,
      probe: async () => { probes += 1; return new Promise<boolean>(resolve => { release = resolve }) } })
    const first = probe.refresh(1_000)
    release(true)
    expect(await first).toBe(true)
    expect(probes).toBe(1)
    // TTL 内：直接回缓存。
    expect(await probe.refresh(1_500)).toBe(true)
    expect(probes).toBe(1)
    // 过期后并发三次：只起一次探测，三个调用共用同一个结果。
    const a = probe.refresh(5_000)
    const b = probe.refresh(5_000)
    const c = probe.refresh(5_000)
    release(true)
    expect(await Promise.all([a, b, c])).toEqual([true, true, true])
    expect(probes).toBe(2)
  })

  it('ensureFresh：过期才起探测、不阻塞、并发不叠加', async () => {
    let probes = 0
    let release: (up: boolean) => void = () => undefined
    const probe = new HubProbe({ hub: HUB, timeoutMs: 500, ttlMs: 1_000,
      probe: async () => { probes += 1; return new Promise<boolean>(resolve => { release = resolve }) } })
    // 从没探过 → 起一次。
    probe.ensureFresh(1_000)
    probe.ensureFresh(1_000)
    probe.ensureFresh(1_000)
    expect(probes).toBe(1)
    release(true)
    await Promise.resolve()
    // 刚探过（TTL 内）→ 不再起。
    probe.ensureFresh(1_200)
    expect(probes).toBe(1)
  })

  it('中枢掉线再回来：TTL 过期后 ensureFresh 重探并把 usable 拉回 true', async () => {
    let up = false
    const probe = new HubProbe({ hub: HUB, timeoutMs: 500, ttlMs: 1_000, probe: async () => up,
      token: { env: 'HUB_TOKEN' }, tokenIo: { env: () => TOKEN } })
    const t0 = Date.now()
    await probe.refresh(t0)
    expect(probe.usable()).toBe(false)
    up = true
    // 过期 → 现探一次恢复（不重启）。
    expect(await probe.refresh(t0 + 5_000)).toBe(true)
    expect(probe.usable()).toBe(true)
  })

  it('被 401 拒绝后，TTL 过期重探会清掉 rejected（token 换对即恢复）', async () => {
    let token = WRONG
    const probe = new HubProbe({ hub: HUB, timeoutMs: 500, ttlMs: 1_000, probe: async () => true,
      token: { env: 'HUB_TOKEN' }, tokenIo: { env: () => token } })
    const t0 = Date.now()
    await probe.refresh(t0)
    probe.rejectAuth(401, 'invalid hub token')
    expect(probe.usable()).toBe(false)
    token = TOKEN
    await probe.refresh(t0 + 5_000)
    expect(probe.authState().state).toBe('ok')
    expect(probe.usable()).toBe(true)
  })
})

describe('巩固：计划与实际写入分开', () => {
  const ticket = { channels: [{ address: { bot_id: 'lead' } }] } as never

  it('中枢回 dryRun 时仍然跑本机真实巩固（本机是唯一写入者）', async () => {
    const store = new Store(join(directory, 'g.sqlite'))
    let distilled = 0
    const local = new LocalMemory({ store, bots: () => ['lead'],
      // 有 distill + episodic 才会真提炼；这里数它被调了几次。
      distill: async () => { distilled += 1; return [{ description: '以后都用 pnpm', body: '以后都用 pnpm',
        type: 'feedback' as const, importance: 5, dedupe_key: 'pnpm' }] },
      episodic: () => [{ text: '主人说以后都用 pnpm，不要用 npm，这条要记住。', at: Math.floor(Date.now() / 1000) }] })
    const hub = new HubMemory({ reachable: () => true, fallback: local,
      consolidate: async () => ({ facts: 7, merged: 0, superseded: 0, dryRun: true, candidates: 2 }) })
    const done = await hub.consolidate({})
    // 本机真的提炼并落账了：facts 是 1（本机写的），不是中枢那份 7。
    expect(distilled).toBe(1)
    expect(done.facts).toBe(1)
    expect(local.all()).toHaveLength(1)
    // 中枢那份读数原样放在 hubPlan 里，且标记 dryRun。
    expect(done.hubPlan).toEqual({ facts: 7, merged: 0, superseded: 0, dryRun: true, candidates: 2 })
    expect(done.dryRun).toBe(true)
    expect(done.candidates).toBe(2)
    store.close()
  })

  it('中枢报错时不影响本机写入（降级仍真写）', async () => {
    const store = new Store(join(directory, 'h.sqlite'))
    const local = new LocalMemory({ store, bots: () => ['lead'],
      distill: async () => [{ description: 'd', body: 'b', type: 'feedback' as const, importance: 3, dedupe_key: 'k' }],
      episodic: () => [{ text: '一段够长的原始记录，用来触发提炼，长度超过十六个字。', at: Math.floor(Date.now() / 1000) }] })
    const hub = new HubMemory({ reachable: () => true, fallback: local,
      consolidate: async () => { throw new Error('502') } })
    const done = await hub.consolidate({})
    expect(done.facts).toBe(1)
    expect(done.hubPlan).toBeUndefined()
    store.close()
  })

  it('中枢没给 consolidate 能力时：本机照跑，不报假成功', async () => {
    const store = new Store(join(directory, 'i.sqlite'))
    const local = new LocalMemory({ store, bots: () => ['lead'] })
    const hub = new HubMemory({ reachable: () => true, fallback: local })
    await expect(hub.consolidate({})).resolves.toEqual({ facts: 0, merged: 0, superseded: 0 })
    store.close()
  })

  it('召回前会保鲜（ensureFresh 被调到），但不会因为 TTL 未到就多打网络', async () => {
    let fresh = 0
    const store = new Store(join(directory, 'j.sqlite'))
    const hub = new HubMemory({ reachable: () => true, fallback: new LocalMemory({ store, bots: () => ['lead'] }),
      ensureFresh: () => { fresh += 1 }, search: async () => [] })
    await hub.recall(ticket, 'x')
    expect(fresh).toBe(1)
    store.close()
  })
})

describe('bot_id 口径：按服务端契约过滤，不让一次 422 打掉整轮召回', () => {
  const ticket = (bot: string) => ({ channels: [{ address: { bot_id: bot } }] }) as never

  it('宿主机合法但中枢不认的 id（_lead / 超长）被过滤掉，不发给中枢', async () => {
    const { fetchImpl, calls } = hubFetch({ token: TOKEN, entries: [{ name: 'bot-lead-a', body: 'x' }] })
    const probe = new HubProbe({ hub: HUB, timeoutMs: 500, probe: async () => true, token: { env: 'HUB_TOKEN' },
      tokenIo: { env: () => TOKEN } })
    await probe.refresh()
    const store = new Store(join(directory, 'k.sqlite'))
    const original = globalThis.fetch
    globalThis.fetch = fetchImpl
    try {
      const port = pickMemoryPort(new LocalMemory({ store, bots: () => ['lead'] }), probe)
      await port.recall(ticket('_lead'), 'x')
      // 不合规的 id 不发给中枢；也不退化成「不带 bots」的宽查询，而是降级本机。
      expect(calls).toHaveLength(0)
      store.close()
    } finally { globalThis.fetch = original }
  })

  it('合规 id 原样发；合规与不合规混在一组时只发合规的', async () => {
    expect(hubBots(['lead', '_lead', 'coder'])).toEqual(['lead', 'coder'])
    expect(hubBots(['a'.repeat(64)])).toHaveLength(1)
    expect(hubBots(['a'.repeat(65)])).toEqual([])
  })

  it('一个 id 都不认时降级本机，不发明「不带 bots」的宽查询', async () => {
    const { fetchImpl, calls } = hubFetch({ token: TOKEN, entries: [{ name: 'bot-lead-a', body: '别人的记忆' }] })
    const probe = new HubProbe({ hub: HUB, timeoutMs: 500, probe: async () => true, token: { env: 'HUB_TOKEN' },
      tokenIo: { env: () => TOKEN } })
    await probe.refresh()
    const store = new Store(join(directory, 'l.sqlite'))
    const original = globalThis.fetch
    globalThis.fetch = fetchImpl
    try {
      const port = pickMemoryPort(new LocalMemory({ store, bots: () => ['lead'] }), probe)
      const text = await port.recall(ticket('_bad'), 'x')
      expect(text).toBe('')
      expect(calls).toHaveLength(0)
      store.close()
    } finally { globalThis.fetch = original }
  })
})

describe('health 面的接线', () => {
  it('onAuthChange 在状态变化时被调用（/state.health.memory 的更新来源）', async () => {
    const seen: { state: string; status?: number }[] = []
    const probe = new HubProbe({ hub: HUB, timeoutMs: 500, probe: async () => true, token: { env: 'HUB_TOKEN' },
      tokenIo: { env: () => TOKEN }, onAuthChange: snapshot => seen.push({ state: snapshot.state, ...snapshot.status === undefined ? {} : { status: snapshot.status } }) })
    await probe.refresh()
    expect(seen.at(-1)).toEqual({ state: 'ok' })
    probe.rejectAuth(401, 'invalid hub token')
    expect(seen.at(-1)).toEqual({ state: 'rejected', status: 401 })
    // 被拒时翻成 error，会进 overview 的 problems（不是静默降级）。
    expect(hubHealthOf(HUB, probe.authState(), 'up').state).toBe('error')
    probe.acceptAuth()
    expect(hubHealthOf(HUB, probe.authState(), 'up').state).toBe('ready')
  })

  it('凭据文件权限过宽时 health 是 paused 并带原因（仍可用，但不装作没问题）', async () => {
    const file = join(directory, 'env')
    writeFileSync(file, `HUB_TOKEN=${TOKEN}\n`)
    chmodSync(file, 0o644)
    const probe = new HubProbe({ hub: HUB, timeoutMs: 500, probe: async () => true, token: { env: 'HUB_TOKEN', file },
      tokenIo: { env: () => undefined } })
    await probe.refresh()
    const health = hubHealthOf(HUB, probe.authState(), 'up')
    expect(health.state).toBe('paused')
    expect(health.detail).toContain('权限过宽')
    // 但仍然带上了 token：链路要能通，问题只是被说出来。
    expect(probe.token()).toBe(TOKEN)
  })
})

describe('明文 token 没有落脚点', () => {
  it('设置块是 strict 的：往里塞 token 字段直接拒绝（不给「顺手存值」留口子）', () => {
    expect(() => MemoryConfigSchema.parse({ hub: HUB, tokenEnv: '', tokenFile: '', token: TOKEN })).toThrow()
    expect(() => MemoryConfigSchema.parse({ hub: HUB, tokenEnv: 'HUB_TOKEN', tokenFile: '' })).not.toThrow()
  })

  it('设置里只可能是引用：解析出来的对象里没有任何 64 位凭据值', () => {
    const parsed = MemoryConfigSchema.parse({ hub: HUB, tokenEnv: 'HUB_TOKEN', tokenFile: '/Users/x/.config/hub.env' })
    const text = JSON.stringify(parsed)
    expect(text).toContain('HUB_TOKEN')
    expect(text).toContain('/Users/x/.config/hub.env')
    expect(text).not.toContain(TOKEN)
  })

  it('tokenEnv 必须是变量名、tokenFile 必须是绝对路径（相对路径会被当成「就地取文件」而读错）', () => {
    expect(() => MemoryConfigSchema.parse({ hub: HUB, tokenEnv: 'not a name', tokenFile: '' })).toThrow()
    expect(() => MemoryConfigSchema.parse({ hub: HUB, tokenEnv: '', tokenFile: 'relative/env' })).toThrow()
  })
})
