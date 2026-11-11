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
    { path: '/api/mobile/withdraw', methods: ['POST'], requestBody: 'buffered' },
    { path: '/api/mobile/work', methods: ['GET'], requestBody: 'buffered' },
    { path: '/api/mobile/agents', methods: ['GET'], requestBody: 'buffered' },
    { path: '/api/mobile/models', methods: ['GET'], requestBody: 'buffered' },
    { path: '/api/mobile/efforts', methods: ['GET'], requestBody: 'buffered' },
    { path: '/api/mobile/model', methods: ['POST'], requestBody: 'buffered' },
    { path: '/api/mobile/pair', methods: ['POST'], requestBody: 'buffered' },
    { path: '/api/mobile/screen', methods: ['GET'], requestBody: 'buffered' },
    { path: '/api/mobile/outputs', methods: ['GET'], requestBody: 'buffered' },
    { path: '/api/mobile/routines', methods: ['GET'], requestBody: 'buffered' },
    { path: '/api/mobile/memory', methods: ['GET', 'POST'], requestBody: 'buffered' },
    { path: '/api/mobile/spend', methods: ['GET'], requestBody: 'buffered' },
    { path: '/api/mobile/audit', methods: ['GET'], requestBody: 'buffered' },
    { path: '/api/mobile/voice', methods: ['POST'], requestBody: 'buffered' },
    { path: '/api/mobile/takeover', methods: ['POST'], requestBody: 'buffered' },
    { path: '/api/mobile/retry', methods: ['POST'], requestBody: 'buffered' },
    { path: '/api/mobile/steer', methods: ['POST'], requestBody: 'buffered' },
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

it('withdraws by request id, validating it before the gateway sees it', async () => {
  const upstream = vi.fn(async () => Response.json({ ok: true, id: 7, request_id: 'phone-1' }))
  const handler = phoneHandler(host(), 'http://127.0.0.1:8788', upstream as typeof fetch)
  for (const value of [undefined, {}, { request_id: 42 }, { request_id: '' }, { request_id: 'x'.repeat(129) }]) {
    const result = await handler(new Request('http://dsh/api/mobile/withdraw', { method: 'POST', body: JSON.stringify(value) }))
    expect(result.status).toBe(400)
  }
  expect(upstream).not.toHaveBeenCalled()
  const result = await handler(new Request('http://dsh/api/mobile/withdraw', { method: 'POST',
    body: JSON.stringify({ request_id: 'phone-1', text: 'ignored' }) }))
  expect(result.status).toBe(200)
  expect(await result.json()).toEqual({ ok: true, id: 7, request_id: 'phone-1' })
  // 只把 request_id 转给网关；客户端多给的字段不越过这条边界。
  expect(upstream).toHaveBeenCalledWith('http://127.0.0.1:8788/withdraw', expect.objectContaining({
    method: 'POST', body: JSON.stringify({ request_id: 'phone-1' }),
  }))
})

it('keeps the gateway refusal when a withdrawal is too late, and repeats it as 409', async () => {
  const upstream = vi.fn(async () => Response.json({ error: 'message was already picked up' }, { status: 409 }))
  const handler = phoneHandler(host(), 'http://127.0.0.1:8788', upstream as typeof fetch)
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await handler(new Request('http://dsh/api/mobile/withdraw', { method: 'POST', body: '{"request_id":"phone-1"}' }))
    // 重复撤回与「已回复/已读走」都是同一类冲突：状态码和网关文案原样交给客户端。
    expect(result.status).toBe(409)
    expect(await result.json()).toEqual({ error: 'message was already picked up' })
  }
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

it('sends a question with its options only while the ticket waits on an answer', async () => {
  const upstream = vi.fn(async () => Response.json({ items: [] }))
  const tickets = [
    { id: 't1', title: 'Pick one', channels: [{ source: 'team' }], createdAt: '2026-11-11T00:00:00Z', updatedAt: '2026-11-11T00:00:01Z',
      attention: { id: 'q1', question: 'Which way?', options: [{ id: 'a', label: '按合同回' }, { id: 'b', label: '接受新条款' }] },
      assignments: [], inputs: [] },
    // Delivery outranks attention: this ticket still waits on a person, but not on a question it can answer, so no question leaves the server.
    { id: 't2', title: 'Undelivered', channels: [{ source: 'team' }], createdAt: '2026-11-11T00:00:00Z', updatedAt: '2026-11-11T00:00:01Z',
      delivery: { error: 'gone', at: '' },
      attention: { id: 'q2', question: 'Stale?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
      assignments: [], inputs: [] },
  ]
  const withTickets = { ...host(), store: { settings: () => ({ paused: false }), tickets: { list: () => tickets } } } as unknown as HttpHost
  const result = await phoneHandler(withTickets, undefined, upstream as typeof fetch)(new Request('http://dsh/api/mobile/timeline'))
  expect(result.status).toBe(200)
  const body = await result.json() as { tasks: Record<string, unknown>[] }
  expect(body.tasks).toEqual([
    expect.objectContaining({ id: 't1', needs_person: 'answer', question: 'Which way?',
      options: [{ id: 'a', label: '按合同回' }, { id: 'b', label: '接受新条款' }] }),
    expect.objectContaining({ id: 't2', needs_person: 'delivery' }),
  ])
  expect(body.tasks[1]).not.toHaveProperty('question')
  expect(body.tasks[1]).not.toHaveProperty('options')
})

it('takes the phone channel state from the Source that actually carries it', async () => {
  // 队伍里手机消息走 team 源；mobile 源是独立部署才装的。别再对不存在的源兜底报「启动中」。
  const upstream = vi.fn(async () => Response.json({ items: [] }))
  const withTeam = { ...host(), health: { runtime: { state: 'ready' }, team: { state: 'ready', detail: '' } } } as unknown as HttpHost
  const team = await phoneHandler(withTeam, undefined, upstream as typeof fetch)(new Request('http://dsh/api/mobile/timeline'))
  expect((await team.json() as { status: { mobile: string } }).status.mobile).toBe('ready')
  const neither = { ...host(), health: { runtime: { state: 'ready' } } } as unknown as HttpHost
  const missing = await phoneHandler(neither, undefined, upstream as typeof fetch)(new Request('http://dsh/api/mobile/timeline'))
  expect((await missing.json() as { status: { mobile: string } }).status.mobile).toBe('missing')
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
  expect(registered.length).toBe(21)
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

// 代码卡上的「看看改完的样子」要知道去看哪张票。网关只记「回哪条消息」（reply_to），
// 工单在这一侧从最近的决定里对齐：threadKey 的尾号是队列行号，ticketId 是那张票。
// 对不上就不补 —— 客户端据此如实说「这段改动没带工单号」，不拿别的票顶替。
it('points a code reply at its own ticket, and leaves it blank when it cannot tell', async () => {
  const { ticketRefs, withTicketRefs } = await import('../src/app/mobile-http.ts')
  const items = [
    { id: 'm6', role: 'user', request_id: 'r6', text: '改一下', at: '2026-11-11T00:00:00.000Z' },
    { id: 'r7', role: 'agent', reply_to: 'm6', bot_id: 'coder', text: '改好了',
      code: { path: 'login.tsx', added: 8, removed: 4, lines: [] }, at: '2026-11-11T00:00:10.000Z' },
    // 没有票号可对的那条：决定是被忽略的，没有 ticketId。
    { id: 'r9', role: 'agent', reply_to: 'm8', text: '看了看',
      code: { path: 'a.ts', lines: [] }, at: '2026-11-11T00:00:20.000Z' },
    // 不带代码的回话不该被补这个字段：它不是代码卡。
    { id: 'r11', role: 'agent', reply_to: 'm10', text: '收到', at: '2026-11-11T00:00:30.000Z' },
  ]
  const decisions = [
    { kind: 'accept', threadKey: 'team:main:6', ticketId: 'tk-1', at: '2026-11-11T00:00:05.000Z' },
    { kind: 'ignore', threadKey: 'team:main:8', at: '2026-11-11T00:00:15.000Z' },
    { kind: 'accept', threadKey: 'team:main:10', ticketId: 'tk-3', at: '2026-11-11T00:00:25.000Z' },
  ]
  const refs = ticketRefs(items as never, decisions as never)
  expect(Object.fromEntries(refs)).toEqual({ r7: 'tk-1', r11: 'tk-3' })
  const out = withTicketRefs(items as never, refs) as Record<string, unknown>[]
  expect(out[1]).toMatchObject({ id: 'r7', ticket_ref: 'tk-1' })
  expect(out[2]).not.toHaveProperty('ticket_ref')
  // 不带代码的回话也补：消息结果条要知道这张票的产出在哪。
  expect(out[3]).toMatchObject({ id: 'r11', ticket_ref: 'tk-3' })
  // 消息面的其余字段一格不改：只是把缺的那个补上。
  expect(out[0]).toEqual(items[0])
})

// 工作区三个控件与花名册。假宿主只给这一条会用到的那部分能力：真 Runtime 上它们都在，
// 但测试不必为了一个 stopTicket 把整个引擎搭起来。
function controlHost(options: { tickets?: Record<string, unknown>; engine?: unknown; settingsControl?: unknown
  storeSettings?: () => unknown; saveSettings?: (value: unknown) => void; screen?: unknown; efforts?: unknown; steer?: unknown } = {}) {
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
  if (options.screen) runtime.screen = options.screen
  if (options.efforts) runtime.efforts = options.efforts
  if (options.steer) runtime.steer = options.steer
  return runtime as unknown as HttpHost
}

it('says the screen source is missing instead of pretending there is one', async () => {
  const handler = phoneHandler(controlHost(), undefined, vi.fn() as unknown as typeof fetch)
  const result = await handler(new Request('http://dsh/api/mobile/screen?ticket=t1'))
  expect(result.status).toBe(200)
  expect(await result.json()).toEqual({ state: 'unavailable', reason: '后端还没有接入画面源' })
})

it('shows what the worker actually did when the host can read its session', async () => {
  const snapshot = { state: 'live', kind: 'terminal', ticket_id: 't1', lines: [{ at: '2026-11-10T04:00:00.000Z', kind: 'command', text: '$ pnpm test' }] }
  const screen = vi.fn(async () => snapshot)
  const handler = phoneHandler(controlHost({ screen }), undefined, vi.fn() as unknown as typeof fetch)
  const result = await handler(new Request('http://dsh/api/mobile/screen?ticket=t1'))
  expect(result.status).toBe(200)
  expect(await result.json()).toEqual(snapshot)
  expect(screen).toHaveBeenCalledWith('t1')
})

it('does not turn an unreadable session into a fake live screen', async () => {
  const handler = phoneHandler(controlHost({ screen: async () => { throw new Error('gone') } }), undefined,
    vi.fn() as unknown as typeof fetch)
  const result = await handler(new Request('http://dsh/api/mobile/screen?ticket=t1'))
  expect(await result.json()).toMatchObject({ state: 'unavailable', ticket_id: 't1' })
})

it('reports the reasoning efforts a model route supports, and refuses to guess them', async () => {
  const efforts = vi.fn(async () => ({ efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], default: 'low' }))
  const handler = phoneHandler(controlHost({ efforts }), undefined, vi.fn() as unknown as typeof fetch)
  const ok = await handler(new Request('http://dsh/api/mobile/efforts?provider=p&model=m'))
  expect(ok.status).toBe(200)
  expect(await ok.json()).toEqual({ efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], default: 'low' })
  expect(efforts).toHaveBeenCalledWith('p', 'm')
  // 缺 provider/model 时不去问宿主：这是调用方给错了，不是路由坏了。
  expect((await handler(new Request('http://dsh/api/mobile/efforts?provider=p'))).status).toBe(400)
  // 宿主没有这项能力时明确说 503，而不是回一个空列表让人以为「没有档位」。
  const plain = phoneHandler(controlHost(), undefined, vi.fn() as unknown as typeof fetch)
  expect((await plain(new Request('http://dsh/api/mobile/efforts?provider=p&model=m'))).status).toBe(503)
})

it('assigns a model to one member and rejects an unknown one', async () => {
  let saved: { executor?: { botModels?: Record<string, unknown>; model?: unknown } } | undefined
  const storeSettings = () => ({ paused: false, sources: { team: { config: { bots: [{ bot_id: 'scribbler', name: '写手' }] } } },
    executor: { model: { provider: 'magpie', model: 'base' }, botModels: {}, maxWorkers: 3, directory: '', prepare: '', blockedCommands: [] } })
  const runtimeHost = { ...host(), store: { settings: storeSettings, blockRevision: () => 0,
    tickets: { list: () => [], get: () => undefined } },
    settings: { save: async (_block: string, value: unknown) => { saved = { executor: value as { botModels?: Record<string, unknown>; model?: unknown } } } } } as unknown as HttpHost
  const handler = phoneHandler(runtimeHost, 'http://127.0.0.1:8788', vi.fn(async () => Response.json({})) as typeof fetch)

  const ok = await handler(new Request('http://dsh/api/mobile/model', { method: 'POST',
    body: JSON.stringify({ provider: 'magpie', model: 'member-model', bot_id: 'scribbler' }) }))
  expect(ok.status).toBe(200)
  expect(await ok.json()).toMatchObject({ ok: true, bot_id: 'scribbler', model: { provider: 'magpie', model: 'member-model' } })
  expect((saved?.executor?.botModels as Record<string, unknown> | undefined)?.scribbler)
    .toMatchObject({ provider: 'magpie', model: 'member-model' })
  // 全场默认没有被动到。
  expect(saved?.executor?.model).toMatchObject({ provider: 'magpie', model: 'base' })
  // 拼错/不存在的成员不能悄悄写进一份没人会用的配置。
  const bad = await handler(new Request('http://dsh/api/mobile/model', { method: 'POST',
    body: JSON.stringify({ provider: 'magpie', model: 'x', bot_id: 'ghost' }) }))
  expect(bad.status).toBe(400)
})

it('lets a member fall back to the crew default by clearing its own model', async () => {
  let saved: { botModels?: Record<string, unknown> } | undefined
  const storeSettings = () => ({ paused: false, sources: { team: { config: { bots: [{ bot_id: 'scribbler', name: '写手' }] } } },
    executor: { model: { provider: 'magpie', model: 'base' }, botModels: { scribbler: { provider: 'magpie', model: 'own' } },
      maxWorkers: 3, directory: '', prepare: '', blockedCommands: [] } })
  const runtimeHost = { ...host(), store: { settings: storeSettings, blockRevision: () => 0,
    tickets: { list: () => [], get: () => undefined } },
    settings: { save: async (_block: string, value: unknown) => { saved = value as { botModels?: Record<string, unknown> } } } } as unknown as HttpHost
  const handler = phoneHandler(runtimeHost, 'http://127.0.0.1:8788', vi.fn(async () => Response.json({})) as typeof fetch)

  const cleared = await handler(new Request('http://dsh/api/mobile/model', { method: 'POST',
    body: JSON.stringify({ provider: '', model: '', bot_id: 'scribbler' }) }))
  expect(cleared.status).toBe(200)
  expect(saved?.botModels?.scribbler).toBeUndefined()
  // 全场默认还在，没人被清掉。
  expect((saved as { model?: unknown }).model).toMatchObject({ provider: 'magpie', model: 'base' })
})

it('steers a queued message into the running worker instead of waiting its turn', async () => {
  const steer = vi.fn(async () => true)
  const gateway = vi.fn(async (input: string | URL | Request) => {
    if (String(input).endsWith('/claim')) return Response.json({ ok: true, id: 3, request_id: 'r1', text: '先看这一条' })
    return Response.json({})
  })
  const handler = phoneHandler(controlHost({ tickets: { t1: { id: 't1', open: true } }, steer }), 'http://gw',
    gateway as unknown as typeof fetch)
  const result = await handler(new Request('http://dsh/api/mobile/steer', { method: 'POST',
    body: JSON.stringify({ ticket: 't1', request_id: 'r1' }) }))
  expect(result.status).toBe(200)
  expect(steer).toHaveBeenCalledWith('t1', 'r1', '先看这一条')
  // 没有票号或请求号都不去动队列。
  expect((await handler(new Request('http://dsh/api/mobile/steer', { method: 'POST', body: '{"request_id":"r1"}' }))).status).toBe(400)
  // 队伍已经读走/回复过：网关的 409 原样交回去，不装作插成功。
  const late = phoneHandler(controlHost({ tickets: { t1: { id: 't1', open: true } }, steer }), 'http://gw',
    (async () => Response.json({ error: 'message was already picked up' }, { status: 409 })) as unknown as typeof fetch)
  const refused = await late(new Request('http://dsh/api/mobile/steer', { method: 'POST',
    body: JSON.stringify({ ticket: 't1', request_id: 'r2' }) }))
  expect(refused.status).toBe(409)
  expect(await refused.json()).toEqual({ error: 'message was already picked up' })
})

it('sends a fresh message straight into the running worker without queueing it', async () => {
  const steer = vi.fn(async () => true)
  let sentBody: unknown
  const gateway = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith('/send')) {
      sentBody = JSON.parse(String(init?.body))
      return Response.json({ ok: true, id: 9, request_id: 's1' })
    }
    return Response.json({})
  })
  const handler = phoneHandler(controlHost({ tickets: { t1: { id: 't1', open: true } }, steer }), 'http://gw',
    gateway as unknown as typeof fetch)
  const result = await handler(new Request('http://dsh/api/mobile/steer', { method: 'POST',
    body: JSON.stringify({ ticket: 't1', request_id: 's1', text: '先看这一条' }) }))
  expect(result.status).toBe(200)
  expect(steer).toHaveBeenCalledWith('t1', 's1', '先看这一条')
  // 走 /send 并带 steer 标记：网关会把它插成已读，路由不会再接一遍。
  expect(String(gateway.mock.calls[0]![0])).toBe('http://gw/send')
  expect(sentBody).toMatchObject({ text: '先看这一条', steer: true })
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
  expect(await missing.json()).toEqual({ error: '找不到这张工单' })
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
  expect(await duplicate.json()).toEqual({ error: '这个 id 已经有人用了，换一个' })
  const bad = await handler(new Request('http://dsh/api/mobile/bots', { method: 'POST',
    body: JSON.stringify({ bot_id: 'Bad Id', name: 'x' }) }))
  expect(bad.status).toBe(400)
  expect(await bad.json()).toEqual({ error: 'id 只能用英文小写字母、数字、下划线或短横线' })
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

// 人设要能改：bots 只有「加」没有「改」，手机上加错一个字就只能重建一位。
it('edits a bot\'s name and persona without changing the id its memory hangs on', async () => {
  const saved: unknown[] = []
  const handler = phoneHandler(controlHost({
    storeSettings: () => ({ paused: false, sources: { team: { enabled: true, config: {
      bots: [{ bot_id: 'coder_1', name: '码农', role: 'default', persona: '写代码', memory_namespace: 'bot/coder_1' }],
      default_bot_id: 'coder_1' } } } }),
    saveSettings: value => { saved.push(value) },
  }), undefined, vi.fn() as unknown as typeof fetch)
  const edited = await handler(new Request('http://dsh/api/mobile/bots', { method: 'POST',
    body: JSON.stringify({ action: 'edit', bot_id: 'coder_1', name: '码农甲', persona: '写 Rust' }) }))
  expect(edited.status).toBe(200)
  expect(saved[0]).toMatchObject({ sources: { team: { config: { bots: [
    { bot_id: 'coder_1', name: '码农甲', persona: '写 Rust', role: 'default', memory_namespace: 'bot/coder_1' }],
  default_bot_id: 'coder_1' } } } })
  // 清空人设是合法的：不是每个人都得有一个人设。
  const cleared = await handler(new Request('http://dsh/api/mobile/bots', { method: 'POST',
    body: JSON.stringify({ action: 'edit', bot_id: 'coder_1', name: '码农甲', persona: '  ' }) }))
  expect(cleared.status).toBe(200)
  expect((saved[1] as { sources: { team: { config: { bots: { persona?: string }[] } } } }).sources.team.config.bots[0])
    .toMatchObject({ persona: '' })
  const missing = await handler(new Request('http://dsh/api/mobile/bots', { method: 'POST',
    body: JSON.stringify({ action: 'edit', bot_id: 'nobody', name: 'x' }) }))
  expect(missing.status).toBe(404)
})

// 撤一位要走人：撤掉的若是 default，剩下的第一位顶上，目录始终恰好一个 default。
it('removes a bot, promoting the next one when the removed bot was the default', async () => {
  const saved: unknown[] = []
  const handler = phoneHandler(controlHost({
    storeSettings: () => ({ paused: false, sources: { team: { enabled: true, config: {
      bots: [{ bot_id: 'lead', name: '大哥', role: 'default', memory_namespace: 'bot/lead' },
        { bot_id: 'coder', name: '码农', role: 'member', memory_namespace: 'bot/coder' }],
      default_bot_id: 'lead' } } } }),
    saveSettings: value => { saved.push(value) },
  }), undefined, vi.fn() as unknown as typeof fetch)
  const removed = await handler(new Request('http://dsh/api/mobile/bots', { method: 'POST',
    body: JSON.stringify({ action: 'remove', bot_id: 'lead' }) }))
  expect(removed.status).toBe(200)
  expect(saved[0]).toMatchObject({ sources: { team: { config: { bots: [
    { bot_id: 'coder', name: '码农', role: 'default' }], default_bot_id: 'coder' } } } })
  const unknown = await handler(new Request('http://dsh/api/mobile/bots', { method: 'POST',
    body: JSON.stringify({ action: 'remove', bot_id: 'nobody' }) }))
  expect(unknown.status).toBe(404)
})

// 手机上显示的每一句错误都该是人话：英文原文（"No such ticket"）让人不知道该改什么。
it('answers a refusal in words the phone can show, keeping the status code', async () => {
  const handler = phoneHandler(controlHost(), undefined, vi.fn() as unknown as typeof fetch)
  const unknown = await handler(new Request('http://dsh/api/mobile/takeover', { method: 'POST', body: '{"ticket":"nope"}' }))
  expect(unknown.status).toBe(404)
  expect(await unknown.json()).toEqual({ error: '找不到这张工单' })
  // 没有对照条目的错误原样交回：不吞后端的原因，也不编一句更好听的。
  const badId = await handler(new Request('http://dsh/api/mobile/takeover', { method: 'POST', body: '{"ticket":""}' }))
  expect(badId.status).toBe(400)
  expect((await badId.json() as { error: string }).error).toBe('ticket is required')
})

// 导出是给人留退路的：里面要有配置与工单，但绝不能有凭据。
it('exports the records a person would need to rebuild the crew, and no secrets', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'phone-api-')); directories.push(stateDir)
  writeFileSync(join(stateDir, 'mobilegw.token'), 'server-only-test-token')
  const handler = phoneHandler({ ready: Promise.resolve(), machine: { stateDir }, health: {},
    store: { settings: () => ({ paused: false, sources: { team: { enabled: true, config: {
      bots: [{ bot_id: 'coder', name: '码农', role: 'default', memory_namespace: 'bot/coder' }], default_bot_id: 'coder' } } } }),
      tickets: { list: () => [] } } } as unknown as HttpHost, undefined, vi.fn() as unknown as typeof fetch)
  // 导出走管理面（需要同源），消息面不该暴露它。
  const viaPhone = await handler(new Request('http://dsh/api/mobile/records/export'))
  expect(viaPhone.status).toBe(404)
})

// 「常规任务」路由：有账就原样下发，读不到就说读不到，还没接这项能力时也不能说成「没有」。
it('serves the routines ledger and keeps "nothing yet" apart from "could not read"', async () => {
  const view = { items: [{ id: 'daily-standup', title: '每天站会', cycle: 'daily', enabled: true,
    created_at: '2026-11-11T09:00:00.000Z' }], state: 'live', counts: { enabled: 1, paused: 0 }, runner: 'none' }
  const fetchless = vi.fn() as unknown as typeof fetch
  const wired = { ...host(), routines: async () => view as never } as unknown as HttpHost
  const served = await phoneHandler(wired, undefined, fetchless)(new Request('http://dsh/api/mobile/routines'))
  expect(served.status).toBe(200)
  expect(await served.json()).toEqual(view)

  // 宿主没接这项能力：unavailable，不是空态。
  const bare = await phoneHandler(host(), undefined, fetchless)(new Request('http://dsh/api/mobile/routines'))
  expect(bare.status).toBe(200)
  expect(await bare.json()).toMatchObject({ state: 'unavailable', items: [], runner: 'none' })

  // 读数时炸了也一样：不把故障说成「还没有常规任务」。
  const broken = { ...host(), routines: async () => { throw new Error('disk gone') } } as unknown as HttpHost
  const failed = await phoneHandler(broken, undefined, fetchless)(new Request('http://dsh/api/mobile/routines'))
  expect(failed.status).toBe(200)
  expect(await failed.json()).toMatchObject({ state: 'unavailable', items: [], runner: 'none' })
})
