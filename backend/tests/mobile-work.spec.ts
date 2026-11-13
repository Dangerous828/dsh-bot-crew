import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { phoneHandler, queuedRequests, registerMobileHttp, unreadOf } from '../src/app/mobile-http.ts'
import { planFrom, planOf, workOf } from '../src/app/work.ts'
import { DeviceStore, issuePairingCode } from '../src/app/remote.ts'
import { SettingsConflict } from '../src/app/settings.ts'
import type { HttpHost } from '../src/app/http.ts'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

/** One ticket of a crew, shaped the way the store hands it out. */
const ticket = (over: Record<string, unknown> = {}) => ({
  id: 'tk1', title: '调开登录页间距', createdAt: '2026-11-09T10:00:00.000Z', updatedAt: '2026-11-09T10:03:00.000Z',
  channels: [{ source: 'team' }], execution: { name: 'fix-spacing', session_id: 'worker-tk1' },
  ended: undefined, ...over,
})

function host(over: { tickets?: { id?: string }[]; bots?: unknown[] } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'phone-api-')); directories.push(stateDir)
  writeFileSync(join(stateDir, 'mobilegw.token'), 'server-only-test-token')
  return {
    ready: Promise.resolve(), machine: { stateDir },
    health: { runtime: { state: 'ready' }, mobile: { state: 'ready' } },
    store: {
      settings: () => ({ paused: false, sources: { team: { config: { bots: over.bots ?? [] } } } }),
      tickets: {
        list: () => over.tickets ?? [ticket()],
        get: (id: string) => (over.tickets ?? [ticket()]).find(entry => entry.id === id),
      },
    },
  } as unknown as HttpHost
}

it('registers the work routes on the same authenticated carrier as the rest', () => {
  const registered: { path?: string; methods?: string[] }[] = []
  const child = { get: () => ({ fetch: { register: (route: unknown) => { registered.push(route as never); return vi.fn(async () => {}) } } }), effect: vi.fn() }
  const ctx = { inject: (_deps: string[], action: (scope: unknown) => void) => action(child) }
  registerMobileHttp(ctx as never, host())
  const paths = registered.map(route => route.path)
  // 逐项断言而不是硬编码整张表：新增一条路由不该让这条例行测试整片变红。
  // 这里的意图是「工单那几条和其它接口仍走同一道已鉴权的 carrier」，不是「路由总数恰好 N」。
  for (const expected of [
    '/api/mobile/timeline', '/api/mobile/send', '/api/mobile/withdraw', '/api/mobile/read', '/api/mobile/work', '/api/mobile/agents', '/api/mobile/models', '/api/mobile/efforts',
    '/api/mobile/model', '/api/mobile/pair', '/api/mobile/screen', '/api/mobile/outputs', '/api/mobile/routines', '/api/mobile/memory', '/api/mobile/spend', '/api/mobile/audit', '/api/mobile/voice', '/api/mobile/reply-spend', '/api/mobile/speak', '/api/mobile/takeover', '/api/mobile/retry', '/api/mobile/steer',
    '/api/mobile/pause', '/api/mobile/resume', '/api/mobile/bots',
  ]) expect(paths).toContain(expected)
  // 会话列表/新建：GET 与 POST 各注册一条 exact route（同一 path 出现两次），S1 新增。
  expect(paths.filter(path => path === '/api/mobile/sessions')).toHaveLength(2)
  expect(registered.filter(route => route.path === '/api/mobile/sessions').map(route => route.methods)).toEqual([['GET'], ['POST']])
})

it('retries a ticket through the phone surface', async () => {
  const retried: string[] = []
  const runtimeHost = { ...host(), engine: { stopTicket: () => {}, retryTicket: (id: string) => { retried.push(id) } } } as unknown as HttpHost
  const handler = phoneHandler(runtimeHost, 'http://127.0.0.1:8788', vi.fn(async () => Response.json({})) as typeof fetch)
  const response = await handler(new Request('http://dsh/api/mobile/retry?ticket=tk1', { method: 'POST' }))
  expect(response.status).toBe(200)
  expect(retried).toEqual(['tk1'])
  // 不存在的票是 404，而不是悄悄成功。
  expect((await handler(new Request('http://dsh/api/mobile/retry?ticket=none', { method: 'POST' }))).status).toBe(404)
})

it('returns how one ticket was worked, in order', async () => {
  const upstream = vi.fn(async () => Response.json({}))
  const handler = phoneHandler(host(), 'http://127.0.0.1:8788', upstream as typeof fetch)

  const response = await handler(new Request('http://dsh/api/mobile/work?ticket=tk1'))
  expect(response.status).toBe(200)
  // Nothing went to the gateway: how a ticket was worked is the store's answer, not a queue read.
  expect(upstream).not.toHaveBeenCalled()
  const got = await response.json() as { ticket_id?: string; title?: string; stage?: string; steps?: { kind: string; at: string }[] }
  expect(got.ticket_id).toBe('tk1')
  // A live ticket's stage comes from the stage machine; this fixture has no assignments, so it reports `unknown`
  // rather than failing. An ended ticket is checked below.
  expect(got.stage).toBe('unknown')
  expect(got.title).toBe('调开登录页间距')
  // Steps are ordered by time. The store carries none yet, so the list is empty rather than invented.
  expect(got.steps).toEqual([])
})

it('reports the outcome of a ticket that ended', async () => {
  const ended = { ...ticket(), ended: { outcome: 'done' } }
  const runtimeHost = { ...host({ tickets: [ended] }), } as unknown as HttpHost
  const handler = phoneHandler(runtimeHost, 'http://127.0.0.1:8788', vi.fn(async () => Response.json({})) as typeof fetch)
  const body = await (await handler(new Request('http://dsh/api/mobile/work?ticket=tk1'))).json() as { stage?: string }
  expect(body.stage).toBe('done')
})

it('refuses a work request that names no ticket', async () => {
  const upstream = vi.fn(async () => Response.json({}))
  const handler = phoneHandler(host(), 'http://127.0.0.1:8788', upstream as typeof fetch)
  expect((await handler(new Request('http://dsh/api/mobile/work'))).status).toBe(400)
  expect(upstream).not.toHaveBeenCalled()
})

it('returns the subagent tree of a worker, however deep it goes', async () => {
  // A live session tree: worker → subagent → subagent of a subagent.
  const headers: Record<string, string | undefined> = {
    'worker-tk1': undefined, 'sub-a': 'worker-tk1', 'sub-a-1': 'sub-a', 'sub-b': 'worker-tk1', unrelated: undefined,
  }
  const tree = {
    get: (id: string) => id in headers ? { session: { header: { parentSession: headers[id] } } } : undefined,
    list: () => Object.keys(headers),
  }
  const runtimeHost = { ...host(), agents: tree } as unknown as HttpHost
  const upstream = vi.fn(async () => Response.json({}))
  const handler = phoneHandler(runtimeHost, 'http://127.0.0.1:8788', upstream as typeof fetch)

  const result = await handler(new Request('http://dsh/api/mobile/agents?ticket=tk1'))
  expect(result.status).toBe(200)
  const body = await result.json() as { agents: { id: string; children: { id: string; children: { id: string }[] }[] }[] }
  // Three levels deep is the point: a nested subagent must not be flattened away.
  expect(body.agents[0]!.id).toBe('worker-tk1')
  expect(body.agents[0]!.children.map(child => child.id).sort()).toEqual(['sub-a', 'sub-b'])
  expect(body.agents[0]!.children[0]!.children).toHaveLength(1)
  // A session outside the tree is not pulled in.
  expect(JSON.stringify(body)).not.toContain('unrelated')
})

it('switches the model for the crew and reports what it switched to', async () => {
  let saved: { executor?: { model?: unknown } } | undefined
  const store = {
    settings: () => ({ paused: false, executor: { model: { provider: 'deepseek', model: 'deepseek-v3' }, maxWorkers: 3, directory: '', prepare: '', blockedCommands: [] } }),
    saveSettings: (next: { executor?: { model?: unknown } }) => { saved = next },
    blockRevision: () => 0,
    tickets: { list: () => [], get: () => undefined },
  }
  // 模型切换必须走 Settings.save（它会先 resolveRoleModel）；这里只验证路由把值交对了。
  const runtimeHost = { ...host(), store, settings: { save: async (_block: string, value: { model?: unknown }) => { saved = { executor: value } } } } as unknown as HttpHost
  const handler = phoneHandler(runtimeHost, 'http://127.0.0.1:8788', vi.fn(async () => Response.json({})) as typeof fetch)

  const response = await handler(new Request('http://dsh/api/mobile/model', {
    method: 'POST', body: JSON.stringify({ provider: 'deepseek', model: 'deepseek-v4' }),
  }))
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ ok: true, model: { provider: 'deepseek', model: 'deepseek-v4' } })
  expect(saved?.executor?.model).toMatchObject({ provider: 'deepseek', model: 'deepseek-v4' })
})

it('reports a stale revision as 409 and an unusable model as 400', async () => {
  const settings = { paused: false, executor: { model: { provider: 'deepseek', model: 'deepseek-v3' }, maxWorkers: 3, directory: '', prepare: '', blockedCommands: [] } }
  const store = { settings: () => settings, blockRevision: () => 3, tickets: { list: () => [], get: () => undefined } }
  const answer = async (error: Error) => {
    const handler = phoneHandler({ ...host(), store, settings: { save: async () => { throw error } } } as unknown as HttpHost,
      'http://127.0.0.1:8788', vi.fn(async () => Response.json({})) as typeof fetch)
    return handler(new Request('http://dsh/api/mobile/model', { method: 'POST',
      body: JSON.stringify({ provider: 'deepseek', model: 'deepseek-v4' }) }))
  }
  expect((await answer(new SettingsConflict('Settings changed.'))).status).toBe(409)
  expect((await answer(new Error('modelUnavailable'))).status).toBe(400)
})

it('refuses a model change with no model named', async () => {
  const upstream = vi.fn(async () => Response.json({}))
  const handler = phoneHandler(host(), 'http://127.0.0.1:8788', upstream as typeof fetch)
  expect((await handler(new Request('http://dsh/api/mobile/model', { method: 'POST', body: '{}' }))).status).toBe(400)
  // A model name with no provider does not say where to reach it.
  expect((await handler(new Request('http://dsh/api/mobile/model', { method: 'POST', body: JSON.stringify({ model: 'x' }) }))).status).toBe(400)
  expect(upstream).not.toHaveBeenCalled()
})

it('reports a sent message with no reply yet as still queued', async () => {
  const upstream = vi.fn(async () => Response.json({ items: [
    { id: 'm1', role: 'user', text: '改一下间距', request_id: 'req-1', at: new Date().toISOString() },
    { id: 'r1', role: 'agent', text: '好', bot_id: 'lin', reply_to: 'm1' },
    { id: 'm3', role: 'user', text: '顺便看下 SE', request_id: 'req-2', at: new Date().toISOString() },
  ] }))
  const handler = phoneHandler(host(), 'http://127.0.0.1:8788', upstream as typeof fetch)
  const response = await handler(new Request('http://dsh/api/mobile/timeline'))
  const body = await response.json() as { queued?: string[]; error?: string }
  expect({ status: response.status, error: body.error }).toEqual({ status: 200, error: undefined })
  // m1 was answered, m3 was not: only m3 can still be withdrawn.
  expect(body.queued).toEqual(['req-2'])
})

it('drops a request from queued once the gateway accepts its withdrawal', async () => {
  let withdrawn = false
  const upstream = vi.fn(async (input: string | URL | Request) => {
    if (String(input).endsWith('/withdraw')) {
      withdrawn = true
      return Response.json({ ok: true, id: 1, request_id: 'req-1' })
    }
    return Response.json({ items: withdrawn ? [] : [
      { id: 'm1', role: 'user', text: '这条反悔了', request_id: 'req-1', at: new Date().toISOString() },
    ] })
  })
  const handler = phoneHandler(host(), 'http://127.0.0.1:8788', upstream as typeof fetch)
  const timeline = async () => await (await handler(new Request('http://dsh/api/mobile/timeline'))).json() as { queued?: string[] }
  expect((await timeline()).queued).toEqual(['req-1'])
  const result = await handler(new Request('http://dsh/api/mobile/withdraw', { method: 'POST', body: '{"request_id":"req-1"}' }))
  expect(result.status).toBe(200)
  // 网关接受撤回后，时间线里不再有这条，queued 自然也不再包含它。
  expect((await timeline()).queued).toEqual([])
})

it('stops offering a withdraw once the crew has had time to pick the message up', () => {
  const now = Date.parse('2026-11-09T10:00:00.000Z')
  const items = [
    { id: 'm1', role: 'user', request_id: 'fresh', at: '2026-11-09T09:59:30.000Z' },
    // Older than the window: the crew is on it, so it can no longer be taken back.
    { id: 'm2', role: 'user', request_id: 'stale', at: '2026-11-09T09:55:00.000Z' },
  ]
  expect(queuedRequests(items, now)).toEqual(['fresh'])
})

it('keeps a message whose time cannot be read rather than hiding it', () => {
  // An unreadable timestamp is not evidence the crew picked it up.
  expect(queuedRequests([{ id: 'm1', role: 'user', request_id: 'odd', at: 'not a time' }])).toEqual(['odd'])
})

// ── 未读（契约 §5.6）──────────────────────────────────────────────
// 数的是「人发出去、队伍还没读走」的那几条。唯一的证据是网关 `messages.read_at`，
// 没有就说不清 —— 三条边界各钉一条，免得以后有人把 unknown 当成 0 画出去。
it('counts the messages a person sent that the crew has not picked up', () => {
  expect(unreadOf([
    { id: 'm1', role: 'user', request_id: 'a', at: '1', read_at: '' },
    { id: 'm2', role: 'user', request_id: 'b', at: '2', read_at: '2026-11-09T10:00:00+0800' },
    { id: 'm3', role: 'user', request_id: 'c', at: '3', read_at: '' },
    // 回话没有「读没读」这回事：它不缺 read_at，也一律不算未读。
    { id: 'r1', role: 'agent', reply_to: 'm1', at: '4' },
  ])).toEqual({ count: 2, state: 'live' })
})

it('says it cannot count rather than calling an unreported timeline empty', () => {
  // 老版本网关不带 read_at。同一份时间线里有能判的、有不能判的，混着数出来的数字是假的，
  // 所以整份记 unknown —— 宁可不画徽标，也不画一个少算几条的 0。
  expect(unreadOf([
    { id: 'm1', role: 'user', request_id: 'a', at: '1', read_at: '' },
    { id: 'm2', role: 'user', request_id: 'b', at: '2' },
  ])).toMatchObject({ count: null, state: 'unknown' })
  // 一条人的消息都没有时是「读得到、确实 0 条」，不是说不清：没有可缺的证据。
  expect(unreadOf([{ id: 'r1', role: 'agent', at: '1' }])).toEqual({ count: 0, state: 'live' })
})

it('never counts a withdrawn message the crew never received', () => {
  expect(unreadOf([{ id: 'm1', role: 'user', request_id: 'a', at: '1', read_at: '', withdrawn: true }]))
    .toEqual({ count: 0, state: 'live' })
})

it('hands the unread count to the phone on the same timeline read', async () => {
  const upstream = vi.fn(async () => Response.json({ items: [
    { id: 'm1', role: 'user', request_id: 'a', text: '在吗', at: '2026-11-09T10:00:00+0800', read_at: '' },
    { id: 'm2', role: 'user', request_id: 'b', text: '看一下', at: '2026-11-09T10:01:00+0800', read_at: '2026-11-09T10:01:05+0800' },
    { id: 'r1', role: 'agent', reply_to: 'm2', text: '好', at: '2026-11-09T10:02:00+0800' },
  ] }))
  const body = await (await phoneHandler(host(), undefined, upstream as typeof fetch)(
    new Request('http://dsh/api/mobile/timeline'))).json() as { unread?: { count: number | null; state: string } }
  // 只算没读走的那一条；已读的和回话都不算。
  expect(body.unread).toEqual({ count: 1, state: 'live' })
})

it('passes unknown through the route instead of turning it into zero', async () => {
  // 老版本网关：人的消息上没有 read_at。路由不该补一个 0 上去 —— 那会把「算不出来」
  // 说成「都读过了」，两端就会画出一个不存在的「没有未读」。
  const upstream = vi.fn(async () => Response.json({ items: [
    { id: 'm1', role: 'user', request_id: 'a', text: '在吗', at: '2026-11-09T10:00:00+0800' },
  ] }))
  const body = await (await phoneHandler(host(), undefined, upstream as typeof fetch)(
    new Request('http://dsh/api/mobile/timeline'))).json() as { unread?: { count: number | null; state: string; reason?: string } }
  expect(body.unread).toMatchObject({ count: null, state: 'unknown' })
  expect(body.unread?.reason).toContain('算不出未读')
})

it('finds subagents from the sessions the store recorded, since agents answers by id only', async () => {
  // `ctx.agents` has no list, so the ids have to come from the store's session records.
  const headers: Record<string, string | undefined> = {
    'worker-tk1': undefined, 'sub-x': 'worker-tk1',
  }
  const trees = {
    get: (id: string) => id in headers ? { session: { header: { parentSession: headers[id] } } } : undefined,
    // Deliberately no `list`: this is the shape DSH actually provides.
  }
  const store = {
    settings: () => ({ paused: false }),
    keys: (family: string | { prefix: string }) =>
      (typeof family === 'string' ? family : family.prefix) === 'session-prompts:'
        ? ['session-prompts:worker-tk1', 'session-prompts:sub-x'] : [],
    tickets: { list: () => [], get: () => undefined },
  }
  const runtimeHost = { ...host(), agents: trees, store } as unknown as HttpHost
  const handler = phoneHandler(runtimeHost, 'http://127.0.0.1:8788', vi.fn(async () => Response.json({})) as typeof fetch)

  const body = await (await handler(new Request('http://dsh/api/mobile/agents?ticket=tk1'))).json() as
    { agents: { id: string; children: { id: string }[] }[] }
  expect(body.agents[0]!.children.map(child => child.id)).toEqual(['sub-x'])
})

it('reports what the store does have: each assignment summary in order, when there are any', async () => {
  // 工单里没有「第几步、做到哪」的明细，只有每次执行留下的 state/summary。这里说的是那份事实，
  // 不是设计稿上画的时间线 —— 画时间线得有数据，没有数据就不编。
  const withReport = {
    ...ticket(),
    assignments: [
      { id: 'a1', state: 'ended', startedAt: '2026-11-09T10:00:00.000Z', report: { state: 'work', summary: '改了 login.tsx 两处' } },
      { id: 'a2', state: 'running', startedAt: '2026-11-09T10:03:00.000Z', report: { state: 'work', summary: '在 390 宽度复查' } },
    ],
  }
  const handler = phoneHandler(host({ tickets: [withReport] }), 'http://127.0.0.1:8788', vi.fn(async () => Response.json({})) as typeof fetch)
  const body = await (await handler(new Request('http://dsh/api/mobile/work?ticket=tk1'))).json() as
    { steps: { at: string; kind: string; text: string }[] }
  expect(body.steps.map(step => step.text)).toEqual(['改了 login.tsx 两处', '在 390 宽度复查'])
  expect(body.steps.map(step => step.at)).toEqual(['2026-11-09T10:00:00.000Z', '2026-11-09T10:03:00.000Z'])
})

it('orders conclusions by when they were reached, not when the work began', () => {
  // 两次执行重叠：A 开始早、结束晚。按开始时间排会倒着念。
  const overlapping = {
    ...ticket(),
    assignments: [
      { id: 'a1', state: 'ended', startedAt: '2026-11-09T10:00:00.000Z', endedAt: '2026-11-09T10:09:00.000Z', report: { state: 'progress', summary: '先做的那件', at: '2026-11-09T10:09:00.000Z' } },
      { id: 'a2', state: 'ended', startedAt: '2026-11-09T10:01:00.000Z', endedAt: '2026-11-09T10:05:00.000Z', report: { state: 'progress', summary: '后做完的那件', at: '2026-11-09T10:05:00.000Z' } },
    ],
  }
  // 10:05 得出的结论在前，10:09 的在后 —— 按开始时间排会把这个顺序整个倒过来。
  // stepsOf 只抽取，排序在 workOf 里 —— 这里测的是完整的读法，不是抽取本身。
  expect(workOf(overlapping as never)!.steps.map(step => step.text)).toEqual(['后做完的那件', '先做的那件'])
})

it('reads the plan out of the worker\'s todo list, as counts only', () => {
  // 进度条的分母只有一个出处：worker 自己写的待办清单。三种写法都认。
  expect(planOf({ todos: [{ status: 'completed' }, { status: 'in_progress' }, { status: 'pending' }] })).toEqual({ total: 3, done: 1 })
  expect(planOf({ items: [{ status: 'done' }, { status: 'completed' }] })).toEqual({ total: 2, done: 2 })
  expect(planOf([{ state: 'checked' }, { done: true }, { status: 'pending' }])).toEqual({ total: 3, done: 2 })
  // 没有待办就没有计划 —— 不是「零步的计划」，前端据此不画进度条。
  expect(planOf({ todos: [] })).toBeUndefined()
  expect(planOf({})).toBeUndefined()
  expect(planOf(undefined)).toBeUndefined()
})

it('takes the last todo write, and does not fall back past an unreadable one', () => {
  const events = [
    { type: 'todo/write', data: { todos: [{ status: 'pending' }, { status: 'pending' }, { status: 'pending' }] } },
    { type: 'assistant/message', data: { text: '改完了' } },
    // 最后一条是 worker 此刻的状态：读不懂就说没有，不拿上一条冒充现在。
    { type: 'todo/write', data: { something: 'else' } },
  ]
  expect(planFrom(events)).toBeUndefined()
  expect(planFrom(events.slice(0, 2))).toEqual({ total: 3, done: 0 })
  // 完全没有待办事件：没有计划。
  expect(planFrom([{ type: 'assistant/message', data: {} }])).toBeUndefined()
})

it('caps a runaway todo list instead of trusting any number an event carries', () => {
  const many = Array.from({ length: 500 }, () => ({ status: 'pending' }))
  expect(planOf({ todos: many })).toEqual({ total: 200, done: 0 })
})

it('reports the plan with the ticket, and omits both fields when there is none', async () => {
  const upstream = vi.fn(async () => Response.json({ items: [] }))
  const planned = { ...ticket(), plan: { total: 3, done: 2, at: '2026-11-09T10:03:00.000Z' } }
  const unplanned = { ...ticket(), id: 'tk2' }
  const body = await (await phoneHandler(host({ tickets: [planned, unplanned] }), undefined, upstream as typeof fetch)(
    new Request('http://dsh/api/mobile/timeline'))).json() as { tasks: Record<string, unknown>[] }

  expect(body.tasks[0]).toEqual(expect.objectContaining({ id: 'tk1', total_steps: 3, steps_done: 2 }))
  // 没有计划时两个字段都不出现：客户端拿「有 total_steps」当画不画的开关。
  expect(body.tasks[1]).not.toHaveProperty('total_steps')
  expect(body.tasks[1]).not.toHaveProperty('steps_done')
})

it('never sends more finished steps than the plan holds', async () => {
  const upstream = vi.fn(async () => Response.json({ items: [] }))
  // 计划被改小过：走过的步数比现在的总步数还多。夹回上限，别让手机的进度条溢出。
  const shrunk = { ...ticket(), plan: { total: 2, done: 5, at: '2026-11-09T10:03:00.000Z' } }
  const body = await (await phoneHandler(host({ tickets: [shrunk] }), undefined, upstream as typeof fetch)(
    new Request('http://dsh/api/mobile/timeline'))).json() as { tasks: Record<string, unknown>[] }
  expect(body.tasks[0]).toEqual(expect.objectContaining({ total_steps: 2, steps_done: 2 }))
})

it('lets a phone redeem its code over the message surface, which already carries credentials', async () => {
  // 手机提交配对码走消息面：Connection 已经验过签名凭据，这正是它能到达的地方。
  const dir = mkdtempSync(join(tmpdir(), 'phone-api-')); directories.push(dir)
  const devices = new DeviceStore(dir)
  const code = issuePairingCode(devices, '')

  const runtimeHost = { ...host(), remote: devices } as unknown as HttpHost
  const upstream = vi.fn(async () => Response.json({}))
  const handler = phoneHandler(runtimeHost, 'http://127.0.0.1:8788', upstream as typeof fetch)

  const paired = await handler(new Request('http://dsh/api/mobile/pair', { method: 'POST',
    body: JSON.stringify({ code, deviceId: 'phone-1', name: 'Kenton 的手机', platform: 'android' }) }))
  expect(paired.status).toBe(200)
  const credential = await paired.json() as { token?: string; deviceId?: string }
  expect(credential.deviceId).toBe('phone-1')
  expect(devices.allows('phone-1', credential.token!)).toBe(true)
  // 这不需要网关参与：配对是后端自己的事。
  expect(upstream).not.toHaveBeenCalled()
})

it('refuses a wrong code over the message surface without burning the real one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phone-api-')); directories.push(dir)
  const devices = new DeviceStore(dir)
  const code = issuePairingCode(devices, '')
  const handler = phoneHandler({ ...host(), remote: devices } as unknown as HttpHost, 'http://127.0.0.1:8788',
    vi.fn(async () => Response.json({})) as typeof fetch)

  const wrong = await handler(new Request('http://dsh/api/mobile/pair', { method: 'POST',
    body: JSON.stringify({ code: '000000', deviceId: 'phone-1', name: 'x', platform: 'android' }) }))
  expect(wrong.status).toBe(403)
  // 打错一次不该让人重新生成。
  const right = await handler(new Request('http://dsh/api/mobile/pair', { method: 'POST',
    body: JSON.stringify({ code, deviceId: 'phone-1', name: 'x', platform: 'android' }) }))
  expect(right.status).toBe(200)
})
