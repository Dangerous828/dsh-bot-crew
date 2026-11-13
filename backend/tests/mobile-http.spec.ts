import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { phoneHandler, registerMobileHttp } from '../src/app/mobile-http.ts'
import type { HttpHost } from '../src/app/http.ts'
import { phoneGate } from '../src/app/phone-gate.ts'

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
    { path: '/api/mobile/read', methods: ['POST'], requestBody: 'buffered' },
    { path: '/api/mobile/work', methods: ['GET'], requestBody: 'buffered' },
    { path: '/api/mobile/agents', methods: ['GET'], requestBody: 'buffered' },
    { path: '/api/mobile/models', methods: ['GET'], requestBody: 'buffered' },
    { path: '/api/mobile/efforts', methods: ['GET'], requestBody: 'buffered' },
    { path: '/api/mobile/model', methods: ['POST'], requestBody: 'buffered' },
    { path: '/api/mobile/pair', methods: ['POST'], requestBody: 'buffered' },
    { path: '/api/mobile/screen', methods: ['GET'], requestBody: 'buffered' },
    { path: '/api/mobile/outputs', methods: ['GET'], requestBody: 'buffered' },
    { path: '/api/mobile/routines', methods: ['GET', 'POST'], requestBody: 'buffered' },
    { path: '/api/mobile/memory', methods: ['GET', 'POST'], requestBody: 'buffered' },
    { path: '/api/mobile/spend', methods: ['GET'], requestBody: 'buffered' },
    { path: '/api/mobile/audit', methods: ['GET'], requestBody: 'buffered' },
    { path: '/api/mobile/voice', methods: ['POST'], requestBody: 'buffered' },
    { path: '/api/mobile/reply-spend', methods: ['GET'], requestBody: 'buffered' },
    { path: '/api/mobile/speak', methods: ['POST'], requestBody: 'buffered' },
    { path: '/api/mobile/takeover', methods: ['POST'], requestBody: 'buffered' },
    { path: '/api/mobile/retry', methods: ['POST'], requestBody: 'buffered' },
    { path: '/api/mobile/steer', methods: ['POST'], requestBody: 'buffered' },
    { path: '/api/mobile/pause', methods: ['POST'], requestBody: 'buffered' },
    { path: '/api/mobile/resume', methods: ['POST'], requestBody: 'buffered' },
    { path: '/api/mobile/bots', methods: ['GET', 'POST'], requestBody: 'buffered' },
    { path: '/api/mobile/sessions', methods: ['GET'], requestBody: 'buffered' },
    { path: '/api/mobile/sessions', methods: ['POST'], requestBody: 'buffered' },
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
  // 逐项断言，别硬编码注册条数：以后每加一条路由都应该由它自己的用例说出来，而不是改一个数字。
  for (const path of ['/api/mobile/timeline', '/api/mobile/send', '/api/mobile/withdraw', '/api/mobile/read',
    '/api/mobile/work', '/api/mobile/agents', '/api/mobile/models', '/api/mobile/efforts', '/api/mobile/model',
    '/api/mobile/pair', '/api/mobile/screen', '/api/mobile/outputs', '/api/mobile/routines', '/api/mobile/memory',
    '/api/mobile/spend', '/api/mobile/audit', '/api/mobile/voice', '/api/mobile/reply-spend', '/api/mobile/speak',
    '/api/mobile/takeover', '/api/mobile/retry', '/api/mobile/steer', '/api/mobile/pause', '/api/mobile/resume',
    '/api/mobile/bots', '/api/mobile/sessions']) {
    expect(registered).toContain(path)
  }
  // sessions 是两条 exact route（GET 与 POST 各一条），不是一条带两个方法。
  expect(registered.filter(path => path === '/api/mobile/sessions')).toHaveLength(2)
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

// 老网关把「没有票号」写成空串而不是干脆不给字段。空串不是已有值，
// 否则那条回话永远补不上票号、结果条也永远不画（code-card 批留下的 nit）。
it('treats an empty ticket_ref as missing and fills it from the decision', async () => {
  const { ticketRefs, withTicketRefs } = await import('../src/app/mobile-http.ts')
  const items = [
    { id: 'r7', role: 'agent', reply_to: 'm6', ticket_ref: '', text: '改好了', at: '2026-11-11T00:00:10.000Z' },
    { id: 'r8', role: 'agent', reply_to: 'm6', ticket_ref: 'tk-gateway-wins', text: '另一个回执', at: '2026-11-11T00:00:11.000Z' },
    { id: 'r9', role: 'agent', reply_to: 'm6', ticket_ref: '   ', text: '空白票号', at: '2026-11-11T00:00:12.000Z' },
  ]
  const decisions = [{ kind: 'accept', threadKey: 'team:main:6', ticketId: 'tk-1', at: '2026-11-11T00:00:05.000Z' }]
  const refs = ticketRefs(items as never, decisions as never)
  expect(refs.get('r7')).toBe('tk-1')
  expect(refs.get('r9')).toBe('tk-1') // 纯空白同样算缺失，结果条不该被挡住。
  expect(refs.has('r8')).toBe(false) // 网关给的真值仍然优先。
  const out = withTicketRefs(items as never, refs) as Record<string, unknown>[]
  expect(out[0]).toMatchObject({ id: 'r7', ticket_ref: 'tk-1' })
  expect(out[1]).toMatchObject({ id: 'r8', ticket_ref: 'tk-gateway-wins' })
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

it('reads the actual speak POST body and returns the generated WAV', async () => {
  const audio = new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 65, 86, 69])
  const speak = vi.fn(async (_text: string) => ({ status: 'ok' as const, audio, seconds: 2, truncated: false }))
  const handler = phoneHandler({ ...controlHost(), speak }, undefined, vi.fn() as unknown as typeof fetch)
  const result = await handler(new Request('http://dsh/api/mobile/speak', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '实际按钮点下来的文字' }) }))
  expect(result.status).toBe(200)
  expect(speak).toHaveBeenCalledWith('实际按钮点下来的文字')
  expect(result.headers.get('content-type')).toBe('audio/wav')
  expect(new Uint8Array(await result.arrayBuffer())).toEqual(audio)
  for (const text of [null, 123, {}, '']) {
    const bad = await handler(new Request('http://dsh/api/mobile/speak', { method: 'POST', body: JSON.stringify({ text }) }))
    expect(bad.status).toBe(400)
  }
  expect(speak).toHaveBeenCalledTimes(1)
})

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

// steer 在宿主侧直答，不走统一转发那道 409 先验。它内部往网关写/认领的两条请求
// 必须同样带会话字段并验能力位，否则 header 形态的非 main steer 会静默按 main 落库。
it('steer carries the declared session into both internal gateway calls', async () => {
  const steer = vi.fn(async () => true)
  const gateway = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    if (new URL(String(input)).pathname.endsWith('/claim')) {
      return Response.json({ ok: true, id: 3, text: '排队的这条', session_api: 1 })
    }
    return Response.json({ ok: true, id: 9, session_api: 1 })
  })
  const handler = phoneHandler(controlHost({ tickets: { t1: { id: 't1', open: true } }, steer }), 'http://gw',
    gateway as unknown as typeof fetch)
  const headers = { 'x-crew-session': 'work' }
  const queued = await handler(new Request('http://dsh/api/mobile/steer', { method: 'POST', headers,
    body: JSON.stringify({ ticket: 't1', request_id: 'r1' }) }))
  expect(queued.status).toBe(200)
  const fresh = await handler(new Request('http://dsh/api/mobile/steer', { method: 'POST', headers,
    body: JSON.stringify({ ticket: 't1', request_id: 's1', text: '先看这一条' }) }))
  expect(fresh.status).toBe(200)
  // 两条内部请求都带 query 与 header，值同为 work。
  expect(gateway.mock.calls.map(call => String(call[0]))).toEqual([
    'http://gw/claim?session_id=work', 'http://gw/send?session_id=work',
  ])
  for (const call of gateway.mock.calls) {
    expect((call[1]?.headers as Record<string, string>)['x-crew-session']).toBe('work')
  }
})

it('steer refuses a legacy gateway for a non-main session instead of writing into main', async () => {
  const steer = vi.fn(async () => true)
  // 老网关：任何响应都不带 session_api。
  const gateway = vi.fn(async () => Response.json({ ok: true, id: 9 }))
  const handler = phoneHandler(controlHost({ tickets: { t1: { id: 't1', open: true } }, steer }), 'http://gw',
    gateway as unknown as typeof fetch)
  const result = await handler(new Request('http://dsh/api/mobile/steer', { method: 'POST',
    headers: { 'x-crew-session': 'work' },
    body: JSON.stringify({ ticket: 't1', request_id: 's1', text: '先看这一条' }) }))
  expect(result.status).toBe(409)
  expect(await result.json()).toEqual({ error: 'unsupported_session' })
  expect(steer).not.toHaveBeenCalled()
  // 老调用（不带会话字段）不受影响，照常插队。
  expect((await handler(new Request('http://dsh/api/mobile/steer', { method: 'POST',
    body: JSON.stringify({ ticket: 't1', request_id: 's2', text: '老调用' }) }))).status).toBe(200)
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

it('resumes the whole executor with no body or an empty object, including repeated calls', async () => {
  const pause = vi.fn(async () => ({ paused: false }))
  const stopTicket = vi.fn()
  const upstream = vi.fn() as unknown as typeof fetch
  const handler = phoneHandler(controlHost({ settingsControl: { pause }, engine: { stopTicket } }), undefined, upstream)
  for (const body of [undefined, '{}', '{}']) {
    const result = await handler(new Request('http://dsh/api/mobile/resume', { method: 'POST', body }))
    expect(result.status).toBe(200)
    expect(await result.json()).toEqual({ ok: true, resumed: true, scope: 'executor' })
  }
  expect(pause.mock.calls).toEqual([[false, 'panel'], [false, 'panel'], [false, 'panel']])
  expect(stopTicket).not.toHaveBeenCalled()
  expect(upstream).not.toHaveBeenCalled()
  expect((await handler(new Request('http://dsh/api/mobile/resume'))).status).toBe(404)
})

it('validates resume bodies before changing executor settings', async () => {
  const pause = vi.fn(async () => ({ paused: false }))
  const handler = phoneHandler(controlHost({ settingsControl: { pause } }), undefined, vi.fn() as unknown as typeof fetch)
  for (const body of ['{', 'null', '[]']) {
    expect((await handler(new Request('http://dsh/api/mobile/resume', { method: 'POST', body }))).status).toBe(400)
  }
  expect((await handler(new Request('http://dsh/api/mobile/resume', { method: 'POST', body: ' '.repeat(8193) }))).status).toBe(413)
  expect(pause).not.toHaveBeenCalled()
})

it('reports missing resume control and a failed change without claiming success', async () => {
  const unavailable = await phoneHandler(controlHost())(new Request('http://dsh/api/mobile/resume', { method: 'POST' }))
  expect(unavailable.status).toBe(503)
  expect(await unavailable.json()).toEqual({ error: '这个后端不支持继续执行' })
  for (const pause of [vi.fn(() => { throw new Error('private failure') }), vi.fn(async () => { throw new Error('private failure') })]) {
    const handler = phoneHandler(controlHost({ settingsControl: { pause } }))
    const result = await handler(new Request('http://dsh/api/mobile/resume', { method: 'POST', body: '{}' }))
    expect(result.status).toBe(500)
    expect(await result.json()).toEqual({ error: '恢复执行没成功，请刷新状态后重试' })
  }
})

it('requires the existing device credentials before dispatching resume', async () => {
  const pause = vi.fn(async () => ({ paused: false }))
  const handler = phoneHandler(controlHost({ settingsControl: { pause } }))
  const devices = { allows: (id: string, token: string) => id === 'phone-1' && token === 'paired-token' }
  const dispatch = (headers: Record<string, string | undefined>) => phoneGate({ pathname: '/api/mobile/resume', method: 'POST', headers, devices })
    ?? handler(new Request('http://dsh/api/mobile/resume', { method: 'POST', body: '{}' }))
  for (const headers of [{}, { 'x-crew-device': 'phone-1', 'x-crew-credential': 'wrong' }]) {
    expect((await dispatch(headers)).status).toBe(401)
  }
  expect(pause).not.toHaveBeenCalled()
  expect((await dispatch({ 'x-crew-device': 'phone-1', 'x-crew-credential': 'paired-token' })).status).toBe(200)
  expect(pause).toHaveBeenCalledWith(false, 'panel')
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

it('writes a routine through POST and refuses a bad action or missing field', async () => {
  const fetchless = vi.fn() as unknown as typeof fetch
  const requested: Array<{ action: string; input: Record<string, unknown> }> = []
  const wired = { ...host(), writeRoutine: (action: string, input: Record<string, unknown>) => {
    requested.push({ action, input })
    if (action === 'create' && !input.title) return { ok: false, reason: 'title is required' }
    return { ok: true, record: { id: 'rt-1', title: String(input.title ?? ''), cycle: 'daily', enabled: true } }
  } } as unknown as HttpHost
  const post = (body: string) => phoneHandler(wired, undefined, fetchless)(new Request('http://dsh/api/mobile/routines',
    { method: 'POST', body }))
  const created = await post(JSON.stringify({ action: 'create', title: '每天站会', cycle: 'daily', bot_id: 'lead' }))
  expect(created.status).toBe(200)
  expect(await created.json()).toMatchObject({ ok: true, record: { id: 'rt-1', title: '每天站会' } })
  expect(requested[0]).toMatchObject({ action: 'create', input: { title: '每天站会', cycle: 'daily', bot_id: 'lead' } })
  // 非法 action：400，不落到 writeRoutine。
  const bad = await post(JSON.stringify({ action: 'nuke' }))
  expect(bad.status).toBe(400)
  // 规则校验失败：400 带原因。
  const empty = await post(JSON.stringify({ action: 'create' }))
  expect(empty.status).toBe(400)
  // 宿主没接写侧：503。
  const bare = await phoneHandler(host(), undefined, fetchless)(new Request('http://dsh/api/mobile/routines',
    { method: 'POST', body: JSON.stringify({ action: 'create', title: 'x', cycle: 'daily' }) }))
  expect(bare.status).toBe(503)
})

// ─────────────────────────────────────────────────────────────────────────────
// S1 多会话消息面（契约 §1 / §2 / §4）：老调用逐字不变、能力位回显、显式非 main 绝不静默回落。
// ─────────────────────────────────────────────────────────────────────────────
/** 会话测试用的假宿主：KV 用内存 Map 顶替，get / set / keys 与真 Store 同形。 */
function sessionHost(options: { decisions?: unknown[]; tickets?: unknown[] } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'phone-session-')); directories.push(stateDir)
  writeFileSync(join(stateDir, 'mobilegw.token'), 'server-only-test-token')
  const kv = new Map<string, unknown>()
  const runtime = { ready: Promise.resolve(), machine: { stateDir },
    health: { runtime: { state: 'ready' }, mobile: { state: 'ready' } },
    store: {
      settings: () => ({ paused: false }),
      tickets: { list: () => options.tickets ?? [] },
      read: { recentDecisions: () => options.decisions ?? [] },
      get: (key: string) => kv.get(key),
      set: (key: string, value: unknown) => { kv.set(key, value) },
      keys: (target: string | { prefix: string }) => {
        const prefix = typeof target === 'string' ? target : target.prefix
        return [...kv.keys()].filter(key => key.startsWith(prefix))
      },
    } } as unknown as HttpHost
  return { runtime, kv }
}

it('lists sessions from the host KV family without forwarding to the gateway', async () => {
  const { runtime } = sessionHost()
  const upstream = vi.fn() as unknown as typeof fetch
  const result = await phoneHandler(runtime, 'http://gw', upstream)(new Request('http://dsh/api/mobile/sessions'))
  expect(result.status).toBe(200)
  expect(await result.json()).toEqual({ sessions: ['main'], default_session_id: 'main', session_api: 1 })
  expect(upstream).not.toHaveBeenCalled()
})

it('registers a session id, keeps main first, and is idempotent', async () => {
  const { runtime } = sessionHost()
  const handler = phoneHandler(runtime, 'http://gw', vi.fn() as unknown as typeof fetch)
  const post = (id: unknown) => new Request('http://dsh/api/mobile/sessions', { method: 'POST', body: JSON.stringify({ id }) })
  // 与网关的 fullmatch 同一形状：首字符限 [a-z0-9]、尾部连字符合法、最多 32 位。
  for (const bad of ['Work', 'has space', '', 'x'.repeat(33), '-lead', 'a_b', 'work\n', 7, undefined]) {
    expect((await handler(post(bad))).status).toBe(400)
  }
  const first = await handler(post('work'))
  expect(first.status).toBe(200)
  expect(await first.json()).toEqual({ id: 'work', sessions: ['main', 'work'], session_api: 1 })
  // 重复 id 幂等：还是 200、同一份名单。登记效果一律通过公开接口 GET 验证，不锁内部键名。
  const again = await handler(post('work'))
  expect(again.status).toBe(200)
  expect(await again.json()).toEqual({ id: 'work', sessions: ['main', 'work'], session_api: 1 })
  expect(await (await handler(new Request('http://dsh/api/mobile/sessions'))).json())
    .toEqual({ sessions: ['main', 'work'], default_session_id: 'main', session_api: 1 })
  // 尾部连字符与 32 位上限都是合法 id；main 恒在首位、不重复，登记它也只是幂等返回。
  expect((await handler(post('trail-'))).status).toBe(200)
  expect((await handler(post('x'.repeat(32)))).status).toBe(200)
  expect((await handler(post('main'))).status).toBe(200)
  const listed = await (await handler(new Request('http://dsh/api/mobile/sessions'))).json() as { sessions: string[] }
  expect(listed.sessions[0]).toBe('main')
  expect(new Set(listed.sessions).size).toBe(listed.sessions.length)
  expect(listed.sessions).toEqual(expect.arrayContaining(['work', 'trail-', 'x'.repeat(32)]))
})

it('refuses an invalid session_id before it reaches the gateway', async () => {
  const { runtime } = sessionHost()
  const upstream = vi.fn(async () => Response.json({ items: [], session_api: 1 })) as unknown as typeof fetch
  const handler = phoneHandler(runtime, 'http://gw', upstream)
  for (const bad of ['Work', 'a b', '', 'x'.repeat(33), '-bad', 'a_b', 'bad!']) {
    const result = await handler(new Request(`http://dsh/api/mobile/timeline?session_id=${encodeURIComponent(bad)}`))
    expect(result.status).toBe(400)
    expect(await result.json()).toEqual({ error: 'invalid_session' })
  }
  expect(upstream).not.toHaveBeenCalled()
})

it('echoes the session capability bits and keeps a legacy timeline unchanged', async () => {
  const { runtime } = sessionHost()
  const seen: string[] = []
  // 老网关：响应里没有 session_id / session_api，能力位由消息面补齐（expand 的那一半）。
  const upstream = vi.fn(async (input: string | URL | Request) => {
    seen.push(String(input))
    return Response.json({ items: [] })
  })
  const handler = phoneHandler(runtime, 'http://gw', upstream as unknown as typeof fetch)
  const legacy = await (await handler(new Request('http://dsh/api/mobile/timeline'))).json() as Record<string, unknown>
  expect(legacy).toMatchObject({ session_id: 'main', session_api: 1, sessions: ['main'], default_session_id: 'main' })
  // 除这四个能力位字段外，老响应逐字不变。groups 是 S4 加的只读投影（增量字段，
  // 与会话无关），同样按白名单剔除后单独断言形状。
  const { session_id: _sid, session_api: _api, sessions: _list, default_session_id: _def,
    groups, ...rest } = legacy
  expect(rest).toEqual({ items: [], tasks: [], queued: [], declined: [], bots: [], default_bot_id: '',
    unread: { count: 0, state: 'live' },
    unread_replies: { count: null, state: 'unknown', reason: expect.any(String) },
    status: { runtime: 'ready', mobile: 'ready', paused: false } })
  // 群组只读投影：main 恒在首位（契约 §10「组集合只由会话名单 + main 兜底决定」），
  // 所以即使没有别的会话也是 live，不是 empty。
  expect(groups).toMatchObject({ state: 'live' })
  expect((groups as { groups: { id: string }[] }).groups[0]).toMatchObject({ id: 'main', sessions: ['main'], bots: [], ticket_count: 0 })
  // 老调用的转发 URL 逐字不变：网关自己缺省 main。
  expect(seen[0]).toBe('http://gw/timeline')
  // 显式 session 才追加 query；有 ticket 时用 & 接在已有 query 后面。
  const shown = await handler(new Request('http://dsh/api/mobile/timeline?session_id=main'))
  expect((await shown.json() as { session_id: string }).session_id).toBe('main')
  expect(seen[1]).toBe('http://gw/timeline?session_id=main')
  await handler(new Request('http://dsh/api/mobile/send?ticket=t1&session_id=work', { method: 'POST',
    body: JSON.stringify({ text: 'hi', request_id: 'r1' }) }))
  expect(seen.at(-1)).toBe('http://gw/send?ticket=t1&session_id=work')
})

it('refuses a non-main session against a gateway without session_api', async () => {
  const { runtime } = sessionHost()
  const upstream = vi.fn(async (_input: string | URL | Request) => Response.json({ items: [{ id: 'm1', role: 'user', text: 'main only' }] }))
  const handler = phoneHandler(runtime, 'http://gw', upstream as unknown as typeof fetch)
  const result = await handler(new Request('http://dsh/api/mobile/timeline?session_id=work'))
  expect(result.status).toBe(409)
  expect(await result.json()).toEqual({ error: 'unsupported_session' })
  // 老网关被问的是 work，不是 main：绝不静默回落。
  expect(String(upstream.mock.calls[0]?.[0])).toBe('http://gw/timeline?session_id=work')
  // 老调用与显式 main 遇老网关照常工作（老调用兼容）。
  expect((await handler(new Request('http://dsh/api/mobile/timeline'))).status).toBe(200)
  expect((await handler(new Request('http://dsh/api/mobile/timeline?session_id=main'))).status).toBe(200)
})

it('refuses a straight send to a non-main session when the gateway has no session_api', async () => {
  const { runtime } = sessionHost()
  // 老网关：任何 operation 的响应都不带能力位，且会按 main 落库。客户端没先取 timeline
  // 就直发 send 时，消息面也必须挡住 —— 否则这条 work 消息被静默写进 main。
  const upstream = vi.fn(async (_input: string | URL | Request) => Response.json({ ok: true, id: 1, request_id: 'r1' }))
  const handler = phoneHandler(runtime, 'http://gw', upstream as unknown as typeof fetch)
  const result = await handler(new Request('http://dsh/api/mobile/send?session_id=work', { method: 'POST',
    body: JSON.stringify({ text: 'hi', request_id: 'r1' }) }))
  expect(result.status).toBe(409)
  expect(await result.json()).toEqual({ error: 'unsupported_session' })
  expect(String(upstream.mock.calls[0]?.[0])).toBe('http://gw/send?session_id=work')
  // 老调用（不带 session_id）与显式 main 照常放行。
  expect((await handler(new Request('http://dsh/api/mobile/send', { method: 'POST',
    body: JSON.stringify({ text: 'hi', request_id: 'r2' }) }))).status).toBe(200)
  expect((await handler(new Request('http://dsh/api/mobile/send?session_id=main', { method: 'POST',
    body: JSON.stringify({ text: 'hi', request_id: 'r3' }) }))).status).toBe(200)
})

it('accepts a straight send once the gateway echoes session_api', async () => {
  const { runtime } = sessionHost()
  const upstream = vi.fn(async (_input: string | URL | Request) =>
    Response.json({ ok: true, id: 1, request_id: 'r1', session_id: 'work', session_api: 1 }))
  const handler = phoneHandler(runtime, 'http://gw', upstream as unknown as typeof fetch)
  await handler(new Request('http://dsh/api/mobile/sessions', { method: 'POST', body: '{"id":"work"}' }))
  const result = await handler(new Request('http://dsh/api/mobile/send?session_id=work', { method: 'POST',
    body: JSON.stringify({ text: 'hi', request_id: 'r1' }) }))
  expect(result.status).toBe(200)
})

it('counts every session’s tickets in the group projection, not just the one being viewed', async () => {
  const when = new Date().toISOString()
  const { runtime } = sessionHost({ tickets: [
    { id: 't-main', title: 'main work', channels: [{ source: 'team', address: { conversation: 'main' } }],
      createdAt: when, updatedAt: when, assignments: [], inputs: [] },
    { id: 't-work', title: 'work work', channels: [{ source: 'team', address: { conversation: 'work' } }],
      createdAt: when, updatedAt: when, assignments: [], inputs: [] },
  ] })
  const upstream = vi.fn(async () => Response.json({ items: [], session_api: 1 }))
  const handler = phoneHandler(runtime, 'http://gw', upstream as unknown as typeof fetch)
  // 先登记 work 会话：群组只由「已登记的会话 + main 兜底」决定，未登记的会话不成组
  // （契约 §10）。登记之后 work 才是独立的组，才谈得上它的票数。
  await handler(new Request('http://dsh/api/mobile/sessions', { method: 'POST', body: '{"id":"work"}' }))
  const body = await (await handler(new Request('http://dsh/api/mobile/timeline'))).json() as {
    groups: { groups: { id: string; ticket_count: number }[] } }
  const byId = new Map(body.groups.groups.map(group => [group.id, group.ticket_count]))
  // 看 main 时 work 组的票数也必须是真数：投影是只读事实，不是「当前这段会话能看到的」。
  // 传过滤后（且被 slice(0,30) 截断）的 tickets 会让别的组恒显示 0 张 —— 那是向人显示错事实。
  expect(byId.get('main')).toBe(1)
  expect(byId.get('work')).toBe(1)
})

it('says the group projection is unavailable instead of failing the whole timeline', async () => {
  const { runtime } = sessionHost()
  // 让 tickets.list() 抛错：群组投影该说「读不到」，而不是把整条时间线变成 502。
  ;(runtime.store.tickets as unknown as { list: () => unknown }).list = () => { throw new Error('store offline') }
  const upstream = vi.fn(async () => Response.json({ items: [], session_api: 1 }))
  const handler = phoneHandler(runtime, 'http://gw', upstream as unknown as typeof fetch)
  const result = await handler(new Request('http://dsh/api/mobile/timeline'))
  expect(result.status).toBe(200)
  const body = await result.json() as { groups: { state: string; reason?: string } }
  expect(body.groups.state).toBe('unavailable')
  expect(body.groups.reason).toContain('读不出来')
})

it('serves an explicit non-main session once the gateway echoes session_api', async () => {
  const { runtime } = sessionHost()
  const upstream = vi.fn(async (_input: string | URL | Request) => Response.json({ items: [], session_id: 'work', session_api: 1 }))
  const handler = phoneHandler(runtime, 'http://gw', upstream as unknown as typeof fetch)
  await handler(new Request('http://dsh/api/mobile/sessions', { method: 'POST', body: '{"id":"work"}' }))
  const result = await handler(new Request('http://dsh/api/mobile/timeline?session_id=work'))
  expect(result.status).toBe(200)
  expect(await result.json()).toMatchObject({ session_id: 'work', session_api: 1,
    sessions: ['main', 'work'], default_session_id: 'main' })
  expect(String(upstream.mock.calls[0]?.[0])).toBe('http://gw/timeline?session_id=work')
})

it('keeps the read cursor per session, with the legacy key as main', async () => {
  const { runtime, kv } = sessionHost()
  const handler = phoneHandler(runtime, 'http://gw', vi.fn() as unknown as typeof fetch)
  const read = (url: string, last: string) => new Request(url, { method: 'POST', body: JSON.stringify({ last_read_id: last }) })
  expect((await handler(read('http://dsh/api/mobile/read', 'r1'))).status).toBe(200)
  expect(kv.get('mobile-read-cursor')).toBe('r1')          // 老键就是 main 那一份
  expect((await handler(read('http://dsh/api/mobile/read?session_id=work', 'r9'))).status).toBe(200)
  expect(kv.get('mobile-read-cursor:work')).toBe('r9')
  expect(kv.get('mobile-read-cursor')).toBe('r1')          // 写 work 不动 main
  const upstream = vi.fn(async () => Response.json({ items: [
    { id: 'r1', role: 'agent', at: '2026-11-11T10:01:00+0800' },
    { id: 'r2', role: 'agent', at: '2026-11-11T10:02:00+0800' } ], session_api: 1 }))
  const timeline = phoneHandler(runtime, 'http://gw', upstream as unknown as typeof fetch)
  const main = await (await timeline(new Request('http://dsh/api/mobile/timeline'))).json() as { unread_replies: { count: number | null } }
  expect(main.unread_replies.count).toBe(1)
  const work = await (await timeline(new Request('http://dsh/api/mobile/timeline?session_id=work'))).json() as { unread_replies: { count: number | null; state: string } }
  // work 的水位 r9 不在这份时间线里 → unknown，绝不拿 main 的 r1 顶替。
  expect(work.unread_replies).toMatchObject({ count: null, state: 'unknown' })
})

it('keeps tasks, queued, unread and declined scoped to the requested session', async () => {
  const at = new Date().toISOString()
  const { runtime } = sessionHost({
    tickets: [
      { id: 't-main', title: 'main work', channels: [{ source: 'team', address: { conversation: 'main' } }], createdAt: at, updatedAt: at, assignments: [], inputs: [] },
      { id: 't-work', title: 'work work', channels: [{ source: 'team', address: { conversation: 'work' } }], createdAt: at, updatedAt: at, assignments: [], inputs: [] },
      // 老工单没有 address.conversation：只在 main 显示。
      { id: 't-legacy', title: 'old', channels: [{ source: 'team' }], createdAt: at, updatedAt: at, assignments: [], inputs: [] },
    ],
    decisions: [
      { kind: 'ignore', threadKey: 'team:main:1', at, reason: [{ code: 'said', values: { text: 'main 的寒暄' } }] },
      { kind: 'ignore', threadKey: 'team:work:2', at, reason: [{ code: 'said', values: { text: 'work 的寒暄' } }] },
    ],
  })
  // 上游给了一份混合时间线（模拟未按会话分片），消息面必须按行号把外会话条目剔掉。
  const items = [
    { id: 'm1', role: 'user', request_id: 'r1', at, read_at: '' },
    { id: 'm2', role: 'user', request_id: 'r2', at, read_at: '' },
  ]
  const upstream = vi.fn(async () => Response.json({ items, session_api: 1 }))
  const handler = phoneHandler(runtime, 'http://gw', upstream as unknown as typeof fetch)
  type Body = { tasks: { id: string }[]; queued: string[]; unread: { count: number | null; state: string }
    declined: { request_id: string; reason: string }[]; items: { id: string }[] }
  const main = await (await handler(new Request('http://dsh/api/mobile/timeline'))).json() as Body
  expect(main.tasks.map(task => task.id)).toEqual(['t-main', 't-legacy'])
  expect(main.queued).toEqual(['r1'])
  expect(main.unread).toEqual({ count: 1, state: 'live' })
  expect(main.declined).toEqual([{ request_id: 'r1', reason: 'main 的寒暄' }])
  expect(main.items.map(item => item.id)).toEqual(['m1'])

  const work = await (await handler(new Request('http://dsh/api/mobile/timeline?session_id=work'))).json() as Body & Record<string, unknown>
  expect(work.tasks.map(task => task.id)).toEqual(['t-work'])
  expect(work.queued).toEqual(['r2'])
  expect(work.unread).toEqual({ count: 1, state: 'live' })
  expect(work.declined).toEqual([{ request_id: 'r2', reason: 'work 的寒暄' }])
  expect(work.items.map(item => item.id)).toEqual(['m2'])
  // status / bots / default_bot_id 与会话无关，全量下发。
  expect(work).toMatchObject({ bots: [], default_bot_id: '', status: { runtime: 'ready', mobile: 'ready' } })
})

it('does not attach another session ticket id to this session replies', async () => {
  const at = new Date().toISOString()
  const { runtime } = sessionHost({ decisions: [
    { kind: 'accept', threadKey: 'team:main:1', ticketId: 'tk-main', at },
    { kind: 'accept', threadKey: 'team:work:2', ticketId: 'tk-work', at },
  ] })
  const items = [
    { id: 'm1', role: 'user', request_id: 'r1', at, read_at: '' },
    { id: 'r1', role: 'agent', reply_to: 'm1', at },
    { id: 'm2', role: 'user', request_id: 'r2', at, read_at: '' },
    { id: 'r2', role: 'agent', reply_to: 'm2', at },
  ]
  const upstream = vi.fn(async () => Response.json({ items, session_api: 1 }))
  const handler = phoneHandler(runtime, 'http://gw', upstream as unknown as typeof fetch)
  type Body = { items: { id: string; ticket_ref?: string }[] }
  const main = await (await handler(new Request('http://dsh/api/mobile/timeline'))).json() as Body
  expect(main.items.map(item => item.id)).toEqual(['m1', 'r1'])
  expect(main.items.find(item => item.id === 'r1')?.ticket_ref).toBe('tk-main')
  const work = await (await handler(new Request('http://dsh/api/mobile/timeline?session_id=work'))).json() as Body
  expect(work.items.map(item => item.id)).toEqual(['m2', 'r2'])
  expect(work.items.find(item => item.id === 'r2')?.ticket_ref).toBe('tk-work')
})

it('attributes a multi-channel ticket by any channel that names the session', async () => {
  const at = new Date().toISOString()
  const { runtime } = sessionHost({ tickets: [
    // 两个 channel 分别标了 main 与 work：只取首个会把这张票从 work 里弄丢。
    { id: 't-multi', title: 'multi', channels: [
      { source: 'team', address: { conversation: 'main' } },
      { source: 'team', address: { conversation: 'work' } }],
      createdAt: at, updatedAt: at, assignments: [], inputs: [] },
  ] })
  const upstream = vi.fn(async () => Response.json({ items: [], session_api: 1 }))
  const handler = phoneHandler(runtime, 'http://gw', upstream as unknown as typeof fetch)
  const main = await (await handler(new Request('http://dsh/api/mobile/timeline'))).json() as { tasks: { id: string }[] }
  expect(main.tasks.map(task => task.id)).toEqual(['t-multi'])
  // 任一 channel 命中即可：旧实现只认首个 channel，会把这张票从 work 里漏掉。
  const work = await (await handler(new Request('http://dsh/api/mobile/timeline?session_id=work'))).json() as { tasks: { id: string }[] }
  expect(work.tasks.map(task => task.id)).toEqual(['t-multi'])
})

it('does not let a decision from another conversation leak into main', async () => {
  const at = new Date().toISOString()
  const { runtime } = sessionHost({ decisions: [
    // 历史 conversation 未必落在 session_id 形状内，但尾号是数字、会被 declined 消费：
    // 若把这种 threadKey 当「认不出会话的老形态」放回 main，外会话的理由就串进来了。
    { kind: 'ignore', threadKey: 'team:oc_x:1', at, reason: [{ code: 'said', values: { text: '别的会话的寒暄' } }] },
  ] })
  const items = [{ id: 'm1', role: 'user', request_id: 'r1', at, read_at: '' }]
  const upstream = vi.fn(async () => Response.json({ items, session_api: 1 }))
  const handler = phoneHandler(runtime, 'http://gw', upstream as unknown as typeof fetch)
  const main = await (await handler(new Request('http://dsh/api/mobile/timeline'))).json() as { declined: unknown[] }
  expect(main.declined).toEqual([])
})

// ─────────────────────────────────────────────────────────────────────────────
// #14 第 2 项：header 形态 session_id（契约 §1 裁决）。
// query 优先 / header 兜底 / 冲突 400 不许猜 / 非法 400 / 老调用逐字不变 /
// header 请求转发时 query 与 header 双写且值相同 / 老网关不认 header 时 409 不静默。
// 反向验证目标：去掉 incoming.headers.get(SESSION_HEADER) 或去掉冲突判定，
// 下面这一整块用例应当成片变红。
// ─────────────────────────────────────────────────────────────────────────────
const SESSION_HEADER = 'x-crew-session'

/** 带 header 形态会话的请求；init.headers 仍是普通对象，避免测试自己造出歧义。 */
function withHeader(url: string, session: string, init: RequestInit = {}): Request {
  return new Request(url, { ...init,
    headers: { ...(init.headers as Record<string, string> | undefined ?? {}), [SESSION_HEADER]: session } })
}

/** 记下转发给网关的 URL 与 headers，用来验证双写与老调用逐字不变。 */
function recordingUpstream(body: unknown = { items: [], session_id: 'work', session_api: 1 }) {
  const seen: { url: string; headers: Record<string, string> }[] = []
  const upstream = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), headers: { ...(init?.headers as Record<string, string> | undefined ?? {}) } })
    return Response.json(body)
  })
  return { seen, upstream }
}

it('accepts a session from the header and forwards query + header with the same value', async () => {
  const { runtime } = sessionHost()
  const { seen, upstream } = recordingUpstream()
  const handler = phoneHandler(runtime, 'http://gw', upstream as unknown as typeof fetch)
  const result = await handler(withHeader('http://dsh/api/mobile/timeline', 'work'))
  expect(result.status).toBe(200)
  expect(await result.json()).toMatchObject({ session_id: 'work', session_api: 1 })
  // 等价转成 query（只认 query 的 S1 网关读得到）+ 原样透传 header（认 header 的新网关
  // 也读得到），两者值恒相同，网关绝不会判成冲突。
  expect(seen[0]?.url).toBe('http://gw/timeline?session_id=work')
  expect(seen[0]?.headers[SESSION_HEADER]).toBe('work')
})

it('takes the query over an equal header, and refuses a conflicting pair with 400', async () => {
  const { runtime } = sessionHost()
  const { seen, upstream } = recordingUpstream()
  const handler = phoneHandler(runtime, 'http://gw', upstream as unknown as typeof fetch)
  // 两者都给且值相同：query 优先，正常服务。
  const agreed = await handler(withHeader('http://dsh/api/mobile/timeline?session_id=work', 'work'))
  expect(agreed.status).toBe(200)
  expect(seen[0]?.url).toBe('http://gw/timeline?session_id=work')
  expect(seen[0]?.headers[SESSION_HEADER]).toBe('work')
  // 两者都给且值不一致 -> 400 invalid_session，不许猜哪个算数，一个请求都不转发。
  upstream.mockClear()
  const conflict = await handler(withHeader('http://dsh/api/mobile/timeline?session_id=work', 'other'))
  expect(conflict.status).toBe(400)
  expect(await conflict.json()).toEqual({ error: 'invalid_session' })
  expect(upstream).not.toHaveBeenCalled()
  // main 也不是「缺省值优先」的偷偷放行口。
  expect((await handler(withHeader('http://dsh/api/mobile/timeline?session_id=main', 'work'))).status).toBe(400)
})

it('rejects an invalid or ambiguous header session before it reaches the gateway', async () => {
  const { runtime } = sessionHost()
  const { upstream } = recordingUpstream()
  const handler = phoneHandler(runtime, 'http://gw', upstream as unknown as typeof fetch)
  for (const bad of ['Work', 'a b', '', 'x'.repeat(33), '-bad', 'a_b', 'bad!', 'main%0A']) {
    const result = await handler(withHeader('http://dsh/api/mobile/timeline', bad))
    expect(result.status).toBe(400)
    expect(await result.json()).toEqual({ error: 'invalid_session' })
  }
  // 头存在但值为空同样不是「老调用」：显式的空值必须报错，不能静默按 main。
  const empty = new Request('http://dsh/api/mobile/timeline', { headers: { [SESSION_HEADER]: '' } })
  expect((await handler(empty)).status).toBe(400)
  // 多个同名 header 拼成带 ', ' 的值，也不许猜取第一个。
  const doubled = new Request('http://dsh/api/mobile/timeline')
  doubled.headers.append(SESSION_HEADER, 'work')
  doubled.headers.append(SESSION_HEADER, 'other')
  expect((await handler(doubled)).status).toBe(400)
  expect(upstream).not.toHaveBeenCalled()
})

it('keeps a legacy call with neither query nor header byte-for-byte unchanged', async () => {
  const { runtime } = sessionHost()
  const { seen, upstream } = recordingUpstream({ ok: true, id: 1, request_id: 'r1' })
  const handler = phoneHandler(runtime, 'http://gw', upstream as unknown as typeof fetch)
  const result = await handler(new Request('http://dsh/api/mobile/send', { method: 'POST',
    body: JSON.stringify({ text: 'hi', request_id: 'r1' }) }))
  expect(result.status).toBe(200)
  // 老调用一个会话字段都不加：转发 URL 无 query、转发 headers 无 x-crew-session，
  // 响应也原样透传（能力位是网关 _send 才注入，老调用连它都不加）。
  expect(seen[0]?.url).toBe('http://gw/send')
  expect(seen[0]?.headers).toEqual({ 'X-GW-Token': 'server-only-test-token', 'Content-Type': 'application/json' })
  expect(await result.json()).toEqual({ ok: true, id: 1, request_id: 'r1' })
})

it('refuses a header-only non-main session against a gateway without session_api (409, no silent main)', async () => {
  const { runtime } = sessionHost()
  // 老网关：不认 x-crew-session，也不回能力位，会把 work 的消息静默按 main 落库。
  // #14 字面「header 未被识别时按缺省 main，不得报错」按字面做就是这个 C4 串线组合。
  const { seen, upstream } = recordingUpstream({ ok: true, id: 1, request_id: 'r1' })
  const handler = phoneHandler(runtime, 'http://gw', upstream as unknown as typeof fetch)
  const result = await handler(withHeader('http://dsh/api/mobile/send', 'work', { method: 'POST',
    body: JSON.stringify({ text: 'hi', request_id: 'r1' }) }))
  expect(result.status).toBe(409)
  expect(await result.json()).toEqual({ error: 'unsupported_session' })
  // 被问的仍然是 work，不是 main：绝不静默回落。header 也透传下去了。
  expect(seen[0]?.url).toBe('http://gw/send?session_id=work')
  expect(seen[0]?.headers[SESSION_HEADER]).toBe('work')
  // 老调用与显式 main 照常服务（main 本来就是 main，老网关能服务）。
  expect((await handler(new Request('http://dsh/api/mobile/send', { method: 'POST',
    body: JSON.stringify({ text: 'hi', request_id: 'r2' }) }))).status).toBe(200)
  expect((await handler(withHeader('http://dsh/api/mobile/send', 'main', { method: 'POST',
    body: JSON.stringify({ text: 'hi', request_id: 'r3' }) }))).status).toBe(200)
})

it('serves a header-only session once the gateway echoes session_api', async () => {
  const { runtime } = sessionHost()
  const { upstream } = recordingUpstream()
  const handler = phoneHandler(runtime, 'http://gw', upstream as unknown as typeof fetch)
  await handler(new Request('http://dsh/api/mobile/sessions', { method: 'POST', body: '{"id":"work"}' }))
  const result = await handler(withHeader('http://dsh/api/mobile/timeline', 'work'))
  expect(result.status).toBe(200)
  expect(await result.json()).toMatchObject({ session_id: 'work', session_api: 1,
    sessions: ['main', 'work'], default_session_id: 'main' })
})

it('echoes session_id + session_api on every response of a header-declared request', async () => {
  const { runtime } = sessionHost()
  // 网关 _send 一处逻辑：显式带 header 的请求，所有响应都回显能力位。消息面把
  // 转发 operation 的 data 原样交回，timeline 自己算的会话也以 header 为准。
  const { upstream } = recordingUpstream({ ok: true, id: 1, request_id: 'r1', session_id: 'work', session_api: 1 })
  const handler = phoneHandler(runtime, 'http://gw', upstream as unknown as typeof fetch)
  for (const path of ['/api/mobile/send', '/api/mobile/withdraw']) {
    const result = await handler(withHeader(`http://dsh${path}`, 'work', { method: 'POST',
      body: JSON.stringify({ text: 'hi', request_id: 'r1' }) }))
    expect(result.status).toBe(200)
    expect(await result.json()).toMatchObject({ session_id: 'work', session_api: 1 })
  }
  const timeline = await handler(withHeader('http://dsh/api/mobile/timeline', 'work'))
  expect(await timeline.json()).toMatchObject({ session_id: 'work', session_api: 1 })
})
