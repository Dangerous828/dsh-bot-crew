/**
 * 记忆中枢配置的生命周期：**改完设置就生效**，不是等下一次整进程重组。
 *
 * 这一份测的是真实故障（生产验收发现的）：
 * - 地址 / 凭据引用 / 超时在构造期被捕获进 `HubProbe` 与 `HubHttp`，设置保存后行为不变，
 *   必须重启才生效 —— 于是「设置显示新值、记忆还走旧中枢」。
 * - 探测超时（默认 1500ms < 公网 `/health` 实测 0.88–1.86s）后降级本机，而 `health.memory`
 *   仍报 `ready` —— 中枢不可用这件事在健康面上完全看不见。
 *
 * 判据都是外部可观察的：假中枢收到的 URL / header、`/state` 的 health 一行、召回结果来自哪一侧。
 * 全部用假 fetch + 显式推进时钟，不真打网络、不等任何超时。
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { MemoryConfigSchema } from '../src/policy.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

let h: Host | undefined
let dir = ''
afterEach(async () => {
  await h?.stop(); h = undefined
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

const HUB_A = 'http://hub-a.test/v1'
const HUB_B = 'http://hub-b.test/v1'
const TOKEN_OK = 'token-ok-0123456789'
const TOKEN_WRONG = 'token-wrong-999999'

/** 一张属于 `bot` 的票（召回按它的 bot_id 过滤）。 */
const ticket = (bot: string) => ({ channels: [{ address: { bot_id: bot } }] }) as never

/** 0600 的凭据文件（env-file 形状，与生产一致）。 */
function tokenFile(name: string, token: string): string {
  const path = join(dir, name)
  writeFileSync(path, `HUB_TOKEN=${token}\n`)
  chmodSync(path, 0o600)
  return path
}

interface Call { url: string; token?: string }

/**
 * 假中枢：`/health` 免鉴权，`/memory/*` 校验 token（与生产契约 08 一致）。
 * `health` 可以接管某个地址的探测（用来让旧探测悬着不兑现）。
 */
function hubStub(options: { token?: () => string; entries?: unknown[]; health?: (url: string) => Promise<Response> | undefined } = {}) {
  const calls: Call[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url)
    if (!/hub-[ab]\.test/.test(target)) return original(url, init)
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({ url: target, ...headers['x-hub-token'] === undefined ? {} : { token: headers['x-hub-token'] } })
    if (target.endsWith('/health')) return options.health?.(target) ?? new Response('{}', { status: 200 })
    if (options.token && headers['x-hub-token'] !== options.token()) {
      return new Response(JSON.stringify({ detail: 'invalid hub token' }), { status: 401 })
    }
    return new Response(JSON.stringify({ entries: options.entries ?? [{ name: 'bot-lead-a', body: '从中枢来的规矩' }] }), { status: 200 })
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}

/** 存一次 `memory` 块（面板来源）。**不等探测**：这就是生产里的真实路径。 */
async function saveMemory(value: Record<string, unknown>): Promise<void> {
  const runtime = h!.runtime
  await runtime.settings.save('memory', value, runtime.store.blockRevision('memory'), 'panel')
}

it('默认探测超时按公网现实取值，不是 1500ms（线上 /health 实测 0.88–1.86s）', () => {
  expect(MemoryConfigSchema.parse({}).timeoutMs).toBe(8000)
  // 上界仍是 10s：超时预算有限，不是「随便调大」。
  expect(MemoryConfigSchema.safeParse({ timeoutMs: 60_000 }).success).toBe(false)
})

it('换 hub 地址后立刻按新地址检索：整套引用都换了，不用重启', async () => {
  dir = mkdtempSync(join(tmpdir(), 'crew-mem-life-'))
  const stub = hubStub()
  try {
    h = await startRuntime()
    await saveMemory({ hub: HUB_A, timeoutMs: 8000, tokenEnv: '', tokenFile: '' })
    // 保存后**立刻**召回：不等显式 refresh，也不重启 —— 这是生产里真实的顺序。
    expect(await h.runtime.memory.recall(ticket('lead'), '风格')).toContain('从中枢来的规矩')
    expect(stub.calls.filter(call => call.url === `${HUB_A}/memory/search`)).toHaveLength(1)

    await saveMemory({ hub: HUB_B, timeoutMs: 8000, tokenEnv: '', tokenFile: '' })
    expect(await h.runtime.memory.recall(ticket('lead'), '风格')).toContain('从中枢来的规矩')
    const searches = stub.calls.filter(call => call.url.endsWith('/memory/search'))
    expect(searches.at(-1)!.url).toBe(`${HUB_B}/memory/search`)
    // 旧地址不该再被碰：换的是整套（probe + port），不是只换其中一个对象。
    expect(searches.filter(call => call.url.startsWith(HUB_A))).toHaveLength(1)
  } finally { stub.restore() }
})

it('换超时后新预算立刻生效（探测与请求用同一个已校验的预算）', async () => {
  dir = mkdtempSync(join(tmpdir(), 'crew-mem-life-'))
  const stub = hubStub()
  try {
    h = await startRuntime()
    await saveMemory({ hub: HUB_A, timeoutMs: 8000, tokenEnv: '', tokenFile: '' })
    expect(h.runtime.memoryProbe!.timeoutMs()).toBe(8000)
    await saveMemory({ hub: HUB_A, timeoutMs: 3000, tokenEnv: '', tokenFile: '' })
    expect(h.runtime.memoryProbe!.timeoutMs()).toBe(3000)
  } finally { stub.restore() }
})

it('换凭据引用后立刻生效：错 token 是 error，改对引用当场恢复 ready', async () => {
  dir = mkdtempSync(join(tmpdir(), 'crew-mem-life-'))
  const wrong = tokenFile('wrong.env', TOKEN_WRONG)
  const right = tokenFile('right.env', TOKEN_OK)
  const stub = hubStub({ token: () => TOKEN_OK })
  try {
    h = await startRuntime()
    await saveMemory({ hub: HUB_A, timeoutMs: 8000, tokenEnv: 'HUB_TOKEN', tokenFile: wrong })
    // 真打一次检索：中枢 401 → 状态被拒，健康面是 error（不是「配好了就 ready」）。
    await h.runtime.memory.recall(ticket('lead'), '风格')
    expect(h.runtime.health['memory']).toMatchObject({ state: 'error' })
    expect(String(h.runtime.health['memory']!.detail)).toContain('hub 未启用')

    // 只改引用、不重启：下一次配置生效后立刻能用真 token 检索。
    await saveMemory({ hub: HUB_A, timeoutMs: 8000, tokenEnv: 'HUB_TOKEN', tokenFile: right })
    expect(h.runtime.health['memory']).toMatchObject({ state: 'ready' })
    expect(await h.runtime.memory.recall(ticket('lead'), '风格')).toContain('从中枢来的规矩')
    expect(stub.calls.filter(call => call.url.endsWith('/memory/search')).at(-1)!.token).toBe(TOKEN_OK)
  } finally { stub.restore() }
})

it('旧探测迟到的结果不覆盖新配置', async () => {
  dir = mkdtempSync(join(tmpdir(), 'crew-mem-life-'))
  const token = tokenFile('ok.env', TOKEN_OK)
  let release!: (response: Response) => void
  const stub = hubStub({ token: () => TOKEN_OK,
    health: url => url.startsWith(HUB_A) ? new Promise<Response>(resolve => { release = resolve }) : undefined })
  try {
    h = await startRuntime()
    // 旧中枢的探测悬着不兑现，紧接着换成新中枢并让它探测成功。
    await h.runtime.settings.save('memory', { hub: HUB_A, timeoutMs: 8000, tokenEnv: 'HUB_TOKEN', tokenFile: token },
      h.runtime.store.blockRevision('memory'), 'panel')
    await saveMemory({ hub: HUB_B, timeoutMs: 8000, tokenEnv: 'HUB_TOKEN', tokenFile: token })
    expect(h.runtime.health['memory']).toMatchObject({ state: 'ready' })

    // 旧探测现在才失败：配置已经换了，它不许把健康面改成「中枢不可达」。
    release(new Response('', { status: 502 }))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(h.runtime.health['memory']).toMatchObject({ state: 'ready' })
    expect(h.runtime.memoryProbe!.base()).toBe(HUB_B)
  } finally { stub.restore() }
})

it('没配中枢：全在本机，健康面不许报 error，也不打网络', async () => {
  dir = mkdtempSync(join(tmpdir(), 'crew-mem-life-'))
  const stub = hubStub()
  try {
    h = await startRuntime()
    await saveMemory({ hub: '', timeoutMs: 8000, tokenEnv: '', tokenFile: '' })
    expect(h.runtime.health['memory']).toMatchObject({ state: 'ready', detail: '没有中枢：记忆全在本机' })
    // 本机账本空 → 召回空串（这是「没有相关记忆」，不是故障）。
    expect(await h.runtime.memory.recall(ticket('lead'), '风格')).toBe('')
    expect(stub.calls).toHaveLength(0)
  } finally { stub.restore() }
})

it('中枢连不上时健康面说「不可达」而不是 ready，恢复后自己回到 ready', async () => {
  dir = mkdtempSync(join(tmpdir(), 'crew-mem-life-'))
  const token = tokenFile('ok.env', TOKEN_OK)
  let down = true
  const stub = hubStub({ token: () => TOKEN_OK,
    health: () => Promise.resolve(down ? new Response('', { status: 502 }) : new Response('{}', { status: 200 })) })
  try {
    h = await startRuntime()
    await saveMemory({ hub: HUB_A, timeoutMs: 8000, tokenEnv: 'HUB_TOKEN', tokenFile: token })
    // 保存后一次召回就会等到那次已在飞的探测 —— 健康面据此变成「不可达」，而不是留着 ready。
    await h.runtime.memory.recall(ticket('lead'), '风格')
    expect(h.runtime.health['memory']).toMatchObject({ state: 'error' })
    expect(String(h.runtime.health['memory']!.detail)).toContain('不可达')

    down = false
    // TTL 过期后重探（显式推进时钟，不等真实时间）。
    await h.runtime.memoryProbe!.refresh(Date.now() + 31_000)
    expect(h.runtime.health['memory']).toMatchObject({ state: 'ready' })
    expect(await h.runtime.memory.recall(ticket('lead'), '风格')).toContain('从中枢来的规矩')
  } finally { stub.restore() }
})

it('同一 TTL 内多次召回只探一次 /health（不每请求多探测）', async () => {
  dir = mkdtempSync(join(tmpdir(), 'crew-mem-life-'))
  const stub = hubStub()
  try {
    h = await startRuntime()
    await saveMemory({ hub: HUB_A, timeoutMs: 8000, tokenEnv: '', tokenFile: '' })
    for (const query of ['一', '二', '三']) await h.runtime.memory.recall(ticket('lead'), query)
    expect(stub.calls.filter(call => call.url === `${HUB_A}/health`)).toHaveLength(1)
    expect(stub.calls.filter(call => call.url === `${HUB_A}/memory/search`)).toHaveLength(3)
  } finally { stub.restore() }
})

it('中枢被黑洞（丢包不拒连）时召回不被探测拖住：等待有上限，探测仍在后台跑完', async () => {
  dir = mkdtempSync(join(tmpdir(), 'crew-mem-life-'))
  const original = globalThis.fetch
  // 永不兑现的探测（模拟丢包不拒连），但检索请求照常失败 —— 这一次召回必须很快返回。
  globalThis.fetch = ((url: string | URL | Request) => String(url).includes('black.hole')
    ? new Promise<Response>(() => {}) : Promise.reject(new Error('offline'))) as typeof fetch
  try {
    h = await startRuntime()
    await h.runtime.settings.save('memory', { hub: 'http://black.hole/v1', timeoutMs: 8000, tokenEnv: '', tokenFile: '' },
      h.runtime.store.blockRevision('memory'), 'panel')
    const started = Date.now()
    expect(await h.runtime.memory.recall(ticket('lead'), '风格')).toBe('')
    // 上限是 1s（不是 8s）：中枢慢不该变成开工慢。
    expect(Date.now() - started).toBeLessThan(2_000)
  } finally { globalThis.fetch = original }
})

it('配置没变时重复保存不重复探测（不因保存动作刷日志/加压）', async () => {
  dir = mkdtempSync(join(tmpdir(), 'crew-mem-life-'))
  const stub = hubStub()
  try {
    h = await startRuntime()
    await saveMemory({ hub: HUB_A, timeoutMs: 8000, tokenEnv: '', tokenFile: '' })
    await h.runtime.memory.recall(ticket('lead'), '风格')
    const healths = () => stub.calls.filter(call => call.url === `${HUB_A}/health`).length
    const before = healths()
    // 内容完全相同的保存是 no-op（Store 不产生新 revision），不该再探一次。
    await saveMemory({ hub: HUB_A, timeoutMs: 8000, tokenEnv: '', tokenFile: '' })
    expect(healths()).toBe(before)
  } finally { stub.restore() }
})
