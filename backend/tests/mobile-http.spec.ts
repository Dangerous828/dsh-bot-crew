import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { phoneHandler, registerMobileHttp } from '../src/app/mobile-http.ts'
import type { HttpHost } from '../src/app/http.ts'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
function host() {
  const stateDir = mkdtempSync(join(tmpdir(), 'phone-api-')); directories.push(stateDir)
  writeFileSync(join(stateDir, 'mobilegw.token'), 'server-only-test-token')
  return { ready: Promise.resolve(), machine: { stateDir }, health: { runtime: { state: 'ready' }, mobile: { state: 'ready' } },
    store: { settings: () => ({ paused: false }), tickets: { list: () => [] } } } as unknown as HttpHost
}
it('uses Connection authenticated exact routes, never raw public web routes', () => {
  const registered: unknown[] = [], dispose = vi.fn(async () => {})
  const child = { get: () => ({ fetch: { register: (route: unknown) => { registered.push(route); return dispose } } }), effect: vi.fn() }
  const ctx = { inject: (dependencies: string[], action: (scope: unknown) => void) => { expect(dependencies).toEqual(['connection']); action(child) } }
  registerMobileHttp(ctx as never, host())
  expect(registered).toMatchObject([
    { path: '/api/mobile/timeline', methods: ['GET'], requestBody: 'buffered' },
    { path: '/api/mobile/send', methods: ['POST'], requestBody: 'buffered' },
    { path: '/api/mobile/work', methods: ['GET'], requestBody: 'buffered' },
    { path: '/api/mobile/agents', methods: ['GET'], requestBody: 'buffered' },
    { path: '/api/mobile/models', methods: ['GET'], requestBody: 'buffered' },
    { path: '/api/mobile/model', methods: ['POST'], requestBody: 'buffered' },
    { path: '/api/mobile/pair', methods: ['POST'], requestBody: 'buffered' },
    { path: '/api/mobile/screen', methods: ['GET'], requestBody: 'buffered' },
    { path: '/api/mobile/takeover', methods: ['POST'], requestBody: 'buffered' },
    { path: '/api/mobile/retry', methods: ['POST'], requestBody: 'buffered' },
    { path: '/api/mobile/pause', methods: ['POST'], requestBody: 'buffered' },
    { path: '/api/mobile/bots', methods: ['GET', 'POST'], requestBody: 'buffered' },
  ])
})
it('injects only the server credential and refuses malformed sends before enqueue', async () => {
  const upstream = vi.fn(async () => Response.json({ ok: true, id: 1 }))
  const handler = phoneHandler(host(), 'http://127.0.0.1:8788', upstream as typeof fetch)
  for (const value of [[], { text: 'ok' }, { text: 42, request_id: 'a' }]) {
    expect((await handler(new Request('http://dsh/api/mobile/send', { method: 'POST', body: JSON.stringify(value) }))).status).toBe(400)
  }
  expect(upstream).not.toHaveBeenCalled()
  const result = await handler(new Request('http://dsh/api/mobile/send', { method: 'POST',
    body: JSON.stringify({ text: 'hello', request_id: 'phone-1', sender: 'other', token: 'client-secret' }) }))
  expect(result.status).toBe(200)
  expect(upstream).toHaveBeenCalledWith('http://127.0.0.1:8788/send', expect.objectContaining({
    body: JSON.stringify({ text: 'hello', request_id: 'phone-1', mentions: [] }), headers: { 'X-GW-Token': 'server-only-test-token', 'Content-Type': 'application/json' },
  }))
})
it('shows actual runtime state and reports transport failures without secrets', async () => {
  const upstream = vi.fn(async () => Response.json({ items: [{ id: 'm1', text: 'hello' }] }))
  const handler = phoneHandler(host(), undefined, upstream as typeof fetch)
  const result = await handler(new Request('http://dsh/api/mobile/timeline'))
  expect(await result.json()).toMatchObject({ items: [{ id: 'm1' }], tasks: [], bots: [], default_bot_id: '',
    status: { runtime: 'ready', mobile: 'ready', paused: false } })
  upstream.mockRejectedValueOnce(new Error('private internal secret'))
  const failed = await handler(new Request('http://dsh/api/mobile/timeline'))
  expect(failed.status).toBe(502)
  expect(await failed.text()).not.toContain('private')
})

// 消息面的每一条都在 Connection 的 Fetch 上注册，鉴权由 Connection 在调用处理器之前完成。
// 插件自己再加一层凭据是没用的：请求根本到不了这里。
// 这条测试钉住「凭据由谁负责」，防止有人误以为能在插件侧绕过 Connection。
it('leaves authentication to Connection instead of inventing a second door', () => {
  const registered: string[] = []
  const ctx = {
    inject: (_deps: string[], run: (child: unknown) => void) => {
      run({
        get: () => ({ fetch: { register: (route: { path: string }) => { registered.push(route.path); return () => {} } } }),
        // 注册完要在 effect 里收尾；这里只要它存在，不需要真的跑。
        effect: () => () => {},
      })
    },
    logger: { warn: () => {} },
  }
  registerMobileHttp(ctx as never, host() as never)
  expect(registered.length).toBe(12)
  // 只注册到 Connection，不额外挂到原始 web 路由上。
  expect(registered.every(path => path.startsWith('/api/mobile/'))).toBe(true)
})

// 左栏「模型」那一项要能选：切之前先得知道有哪些。只回可用的 provider，
// 读不出来的那几家单独列出来，别让人以为它本来就没有模型。
it('lists the models a person can switch to, with the one in use and the providers that failed', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'phone-api-')); directories.push(stateDir)
  const models = vi.fn(async () => ({
    default: { provider: 'dsh', model: 'default' }, routableProviders: ['dsh'],
    groups: [{ id: 'dsh', name: 'DSH', models: [{ id: 'm1', name: 'Model One', description: 'fast' }] }],
    failures: [{ id: 'broken', name: 'Broken', message: 'secret endpoint 10.0.0.1' }],
  }))
  const handler = phoneHandler({ ready: Promise.resolve(), machine: { stateDir }, health: {},
    store: { settings: () => ({ paused: false, executor: { model: { provider: 'dsh', model: 'm1' } } }), tickets: { list: () => [] } },
    models } as unknown as HttpHost, 'http://127.0.0.1:8788', vi.fn() as unknown as typeof fetch)
  const result = await handler(new Request('http://dsh/api/mobile/models'))
  expect(result.status).toBe(200)
  const body = await result.json() as Record<string, unknown>
  expect(body).toMatchObject({ current: { provider: 'dsh', model: 'm1' },
    providers: [{ id: 'dsh', name: 'DSH', models: [{ id: 'm1', name: 'Model One', description: 'fast' }] }],
    failures: [{ id: 'broken', name: 'Broken' }] })
  // 失败原因里可能带内网地址和密钥，不往设备上送。
  expect(JSON.stringify(body)).not.toContain('10.0.0.1')
})

it('forwards to the gateway the state directory owns, not to the first crew on the machine', async () => {
  // A profile that keeps its own stateDir gets its own gateway on a derived port. Using one fixed default
  // sends a second crew's timeline to the first crew's gateway, which answers 401 and reads as a credential
  // problem. The rule has to match scripts/dsh-superagent's state_dir_identity.
  const seen: string[] = []
  const stateDir = mkdtempSync(join(tmpdir(), 'phone-gateway-')); directories.push(stateDir)
  writeFileSync(join(stateDir, 'mobilegw.token'), 'server-only-test-token')
  const runtime = { ready: Promise.resolve(), machine: { stateDir },
    store: { settings: () => ({ paused: false }), tickets: { list: () => [] } } } as unknown as HttpHost
  const answer = phoneHandler(runtime, undefined, async input => {
    seen.push(String(input))
    return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  await answer(new Request('http://dsh/api/mobile/timeline'))
  let digest = 0
  for (const character of stateDir) digest = (digest + character.charCodeAt(0)) % 100
  expect(seen[0]).toContain(`:${18800 + digest}/timeline`)
  expect(seen[0]).not.toContain(':8788/')

  // The default state directory keeps the port it has always had.
  const defaultDir = join(homedir(), '.dsh', 'state', 'superagent')
  writeFileSync(join(stateDir, 'mobilegw.token'), 'server-only-test-token')
  const quiet = phoneHandler({ ...runtime, machine: { stateDir: defaultDir } } as unknown as HttpHost, undefined,
    async input => { seen.push(String(input)); return new Response('{"items":[]}', { status: 200 }) })
  await quiet(new Request('http://dsh/api/mobile/timeline'))
  expect(seen.at(-1)).toContain(':8788/timeline')
})

it('names the messages the crew read and left, so the phone can tell it apart from one still being thought about', async () => {
  const { declinedRequests } = await import('../src/app/mobile-http.ts')
  const items = [
    { id: 'm1', role: 'user', request_id: 'r1', at: '2026-11-10T04:00:00.000Z' },
    { id: 'm2', role: 'user', request_id: 'r2', at: '2026-11-10T04:05:00.000Z' },
    { id: 'm3', role: 'user', request_id: 'r3', at: '2026-11-10T04:10:00.000Z' },
  ]
  const decisions = [
    { kind: 'ignore', threadKey: 'team:main:1', at: '2026-11-10T04:00:20.000Z',
      reason: [{ code: 'said', values: { text: '只是寒暄，不必开票' } }] },
    // A later decision on the same thread replaces the earlier one: a follow-up can turn a refusal into work.
    { kind: 'ignore', threadKey: 'team:main:2', at: '2026-11-10T04:05:20.000Z',
      reason: [{ code: 'said', values: { text: '旧理由' } }] },
    { kind: 'accept', threadKey: 'team:main:2', at: '2026-11-10T04:06:00.000Z' },
    // A decision recorded before its message arrived describes something else, so it explains nothing.
    // A decision on another thread never leaks onto this one either.
  ]
  // Within the queue window: the phone only needs this while a message still looks unanswered.
  const now = Date.parse('2026-11-10T04:00:45.000Z')
  const declined = declinedRequests(items as never, decisions as never, now, 90_000)
  expect(declined).toEqual([{ request_id: 'r1', reason: '只是寒暄，不必开票' }])
})

// 工作区三个控件与花名册。假宿主只给这一条会用到的那部分能力：真 Runtime 上它们都在，
// 但测试不必为了一个 stopTicket 把整个引擎搭起来。
function controlHost(options: { tickets?: Record<string, unknown>; engine?: unknown; settingsControl?: unknown
  storeSettings?: () => unknown; saveSettings?: (value: unknown) => void } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'phone-api-')); directories.push(stateDir)
  writeFileSync(join(stateDir, 'mobilegw.token'), 'server-only-test-token')
  const runtime = {
    ready: Promise.resolve(), machine: { stateDir }, health: {},
    store: {
      settings: options.storeSettings ?? (() => ({ paused: false, sources: {} })),
      tickets: { list: () => [], get: (id: string) => options.tickets?.[id] },
      ...options.saveSettings ? { saveSettings: options.saveSettings } : {},
    },
  } as Record<string, unknown>
  if (options.engine) runtime.engine = options.engine
  if (options.settingsControl) runtime.settings = options.settingsControl
  return runtime as unknown as HttpHost
}

it('says the screen source is missing instead of pretending there is one', async () => {
  const handler = phoneHandler(controlHost(), undefined, vi.fn() as unknown as typeof fetch)
  const result = await handler(new Request('http://dsh/api/mobile/screen?ticket=t1'))
  expect(result.status).toBe(200)
  expect(await result.json()).toEqual({ state: 'unavailable', reason: '后端还没有画面源，worker 不跑浏览器' })
})

it('takes over exactly the ticket it names, and refuses an unknown one', async () => {
  const engine = { stopTicket: vi.fn() }
  const handler = phoneHandler(controlHost({ tickets: { t1: { id: 't1' } }, engine }), undefined,
    vi.fn() as unknown as typeof fetch)
  const taken = await handler(new Request('http://dsh/api/mobile/takeover', { method: 'POST', body: '{"ticket":"t1"}' }))
  expect(taken.status).toBe(200)
  expect(await taken.json()).toEqual({ ok: true, stopped: true })
  expect(engine.stopTicket).toHaveBeenCalledWith('t1')
  const missing = await handler(new Request('http://dsh/api/mobile/takeover', { method: 'POST', body: '{"ticket":"t9"}' }))
  expect(missing.status).toBe(404)
  expect(await missing.json()).toEqual({ error: 'No such ticket' })
  expect(engine.stopTicket).toHaveBeenCalledTimes(1)
})

it('pauses the executor and says so, because no per-ticket pause exists', async () => {
  const pauseControl = { pause: vi.fn(async () => ({ paused: true })) }
  const handler = phoneHandler(controlHost({ tickets: { t1: { id: 't1' } }, settingsControl: pauseControl }), undefined,
    vi.fn() as unknown as typeof fetch)
  const paused = await handler(new Request('http://dsh/api/mobile/pause', { method: 'POST', body: '{"ticket":"t1"}' }))
  expect(paused.status).toBe(200)
  // scope 说「executor」而不是「ticket」：停的是整台执行器，手机界面据此去解释恢复在哪。
  expect(await paused.json()).toEqual({ ok: true, scope: 'executor' })
  expect(pauseControl.pause).toHaveBeenCalledWith(true, 'panel')
  const missing = await handler(new Request('http://dsh/api/mobile/pause', { method: 'POST', body: '{"ticket":"t9"}' }))
  expect(missing.status).toBe(404)
  expect(pauseControl.pause).toHaveBeenCalledTimes(1)
})

it('reads the crew roster and adds a bot under the same rules the directory enforces', async () => {
  const saved: unknown[] = []
  // 一份真实的花名册：恰好一个 default，其余 member。
  const store = () => ({ paused: false, sources: { team: { enabled: true, config: {
    bots: [{ bot_id: 'scribe', name: '写手', role: 'default', memory_namespace: 'bot/scribe' }], default_bot_id: 'scribe' } } } })
  const handler = phoneHandler(controlHost({ storeSettings: store, saveSettings: value => { saved.push(value) } }), undefined,
    vi.fn() as unknown as typeof fetch)
  const list = await handler(new Request('http://dsh/api/mobile/bots'))
  expect(await list.json()).toEqual({ bots: [{ bot_id: 'scribe', name: '写手', role: 'default' }] })

  const added = await handler(new Request('http://dsh/api/mobile/bots', { method: 'POST',
    body: JSON.stringify({ bot_id: 'coder_1', name: '码农', persona: '写代码' }) }))
  expect(added.status).toBe(200)
  expect(await added.json()).toEqual({ ok: true })
  expect(saved[0]).toMatchObject({ sources: { team: { config: { bots: [
    { bot_id: 'scribe' },
    { bot_id: 'coder_1', name: '码农', role: 'member', persona: '写代码', memory_namespace: 'bot/coder_1' },
  ], default_bot_id: 'scribe' } } } })

  const duplicate = await handler(new Request('http://dsh/api/mobile/bots', { method: 'POST',
    body: JSON.stringify({ bot_id: 'scribe', name: '另一个' }) }))
  expect(duplicate.status).toBe(400)
  expect(await duplicate.json()).toEqual({ error: 'Bot already exists' })
  const bad = await handler(new Request('http://dsh/api/mobile/bots', { method: 'POST',
    body: JSON.stringify({ bot_id: 'Bad Id', name: 'x' }) }))
  expect(bad.status).toBe(400)
  expect(await bad.json()).toEqual({ error: 'Invalid bot id' })
  expect(saved).toHaveLength(1)
})

it('adds a bot without flipping a team Source the owner turned off', async () => {
  const saved: unknown[] = []
  const handler = phoneHandler(controlHost({
    storeSettings: () => ({ paused: false, sources: { team: { enabled: false, config: { bots: [
      { bot_id: 'lead', name: '大哥', role: 'default', memory_namespace: 'bot/lead' }], default_bot_id: 'lead' } } } }),
    saveSettings: value => { saved.push(value) },
  }), undefined, vi.fn() as unknown as typeof fetch)
  const added = await handler(new Request('http://dsh/api/mobile/bots', { method: 'POST',
    body: JSON.stringify({ bot_id: 'coder', name: '码农' }) }))
  expect(added.status).toBe(200)
  // 只改 config：停用的来源不该因为手机加了一个人而重新开始工作。
  expect(saved[0]).toMatchObject({ sources: { team: { enabled: false } } })
})

it('promotes the new bot when the crew has none default, so a broken roster can heal', async () => {
  const saved: unknown[] = []
  const handler = phoneHandler(controlHost({
    storeSettings: () => ({ paused: false, sources: { team: { enabled: true, config: { bots: [
      { bot_id: 'ghost', name: '幽灵', role: 'member', memory_namespace: 'bot/ghost' }], default_bot_id: 'ghost' } } } }),
    saveSettings: value => { saved.push(value) },
  }), undefined, vi.fn() as unknown as typeof fetch)
  const added = await handler(new Request('http://dsh/api/mobile/bots', { method: 'POST',
    body: JSON.stringify({ bot_id: 'lead', name: '大哥' }) }))
  expect(added.status).toBe(200)
  expect(saved[0]).toMatchObject({ sources: { team: { config: { bots: [
    { bot_id: 'ghost' }, { bot_id: 'lead', role: 'default' }], default_bot_id: 'lead' } } } })
})

it('makes the first bot the default one, since a directory without a default cannot be read back', async () => {
  const saved: unknown[] = []
  const handler = phoneHandler(controlHost({ saveSettings: value => { saved.push(value) } }), undefined,
    vi.fn() as unknown as typeof fetch)
  const added = await handler(new Request('http://dsh/api/mobile/bots', { method: 'POST',
    body: JSON.stringify({ bot_id: 'lead', name: '大哥' }) }))
  expect(added.status).toBe(200)
  expect(saved[0]).toMatchObject({ sources: { team: { config: {
    bots: [{ bot_id: 'lead', name: '大哥', role: 'default', memory_namespace: 'bot/lead' }], default_bot_id: 'lead' } } } })
})
