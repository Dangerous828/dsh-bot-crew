import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { agentEvents, installModelSelection, type Agent, type ModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ReasoningEffortId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { initializeRoleModel } from '../src/app/role-models.ts'
const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())); vi.restoreAllMocks() })

// 真实宿主组件只能从 session-controller 自己的依赖树里解析：backend 的 node_modules 没有
// `dsh-session-projection` / `dsh-agent-default-model` 的顶层符号链接（它们是 controller 的 peer）。
// 按包的真实安装路径拼出来，装上的就是宿主跑的那一份实现，不是本仓的替身。
const controllerHome = (): string => realpathSync(dirname(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-api-session-controller/package.json')))
const siblingModule = (home: string, name: string): string => join(home, '..', name, 'lib', 'index.js')
async function fixture() {
  const ctx = new Context(); contexts.push(ctx); await ctx.plugin(SystemPrompt)
  const resolve = vi.fn(async value => value)
  // 真实目录：默认每个 provider 都「有」它的模型（用调用参数回填），个别测试可 mockImplementation 覆盖。
  const listModels = vi.fn(async (provider: string) => [{ id: 'keep' }, { id: 'one' }, { id: 'main' }, { id: 'reserve' }, { id: 'new' }, { id: 'default' }, { id: 'seed' }])
  const flush = vi.fn(async () => {})
  const selectModel = vi.fn(async (request: { provider: string; model: string }) => ({ selected: { provider: request.provider, model: request.model } }))
  ctx.reflect.provide('llm', { resolveCallConfig: resolve, listModels })
  ctx.reflect.provide('sessionController', { selectModel })
  ctx.reflect.provide('sessionPersistence', { flush })
  const session = Session.create(SessionId('role-model'))
  const agent = { ctx, session } as Agent
  const host: ModelSelectionRef = { get current() { return session.requestHeader()?.config ?? { provider: 'host', model: 'default', reasoningEffort: ReasoningEffortId('high') } }, assembled: undefined }
  installModelSelection(ctx, host)
  const request = () => agentEvents(ctx, agent).waterfall('agent/request', { turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ provider: 'seed', model: 'seed' }))
  const record = (selection: ModelSelection) => { const event = session.append('request/header', { header: { config: selection }, reason: 'initial' }); ctx.emit('session/event', session, event) }
  return { ctx, agent, host, resolve, listModels, selectModel, flush, request, record }
}
it('keeps prompt variables and initial routing on the role model without saving the host default', async () => {
  const { ctx, agent, request, record, flush } = await fixture()
  await initializeRoleModel(ctx, agent, { provider: 'worker-provider', model: 'worker-model' })
  expect((await ctx.systemPrompt.assemble()).variables).toMatchObject({ provider: 'worker-provider', model: 'worker-model' })
  const selected = await request()
  expect(selected).toEqual({ provider: 'worker-provider', model: 'worker-model' })
  expect(agent.session.snapshotEvents().some(event => event.type === 'model/selection')).toBe(true)
  expect(flush).toHaveBeenCalledOnce()
  record(selected)
  // A retry of the same assembled step keeps the same model even after the header is persisted.
  expect(await request()).toEqual(selected)
  await ctx.systemPrompt.assemble()
  expect(await request()).toEqual(selected)
})
it('lets a later explicit selection win without changing the in-flight assembled step', async () => {
  const { ctx, agent, host, request } = await fixture()
  await initializeRoleModel(ctx, agent, { provider: 'worker', model: 'one' })
  await ctx.systemPrompt.assemble()
  const manual = { provider: 'manual', model: 'two', reasoningEffort: ReasoningEffortId('low') }
  Object.defineProperty(host, 'current', { value: manual, configurable: true })
  const event = agent.session.append('model/selection', manual); ctx.emit('session/event', agent.session, event)
  expect(await request()).toEqual({ provider: 'worker', model: 'one' })
  await ctx.systemPrompt.assemble()
  expect(await request()).toEqual(manual)
})
it('preserves a resumed Session whose selection is still in the configured provider family', async () => {
  const { ctx, agent, listModels } = await fixture()
  const existing = { provider: 'existing', model: 'keep' }
  agent.session.append('model/selection', existing)
  // 配置的 provider 与 existing 一致（同族）、且目录里仍有 keep → 保留。
  await initializeRoleModel(ctx, agent, { provider: 'existing', model: 'other' })
  expect(agent.session.snapshotEvents().filter(event => event.type === 'model/selection')).toHaveLength(1)
  expect(listModels).toHaveBeenCalledWith('existing')
})
it('leaves a session that already sent its first request untouched when it has no readable selection', async () => {
  const { ctx, agent, resolve } = await fixture()
  // 有 requestHeader、但没有 model/selection 事件可读：无从判断，保持原样（交给启动检查兜底）。
  agent.session.append('request/header', { header: { config: { provider: 'existing', model: 'keep' } }, reason: 'initial' })
  await initializeRoleModel(ctx, agent, { provider: 'worker', model: 'new' })
  expect(resolve).not.toHaveBeenCalled()
  expect(agent.session.snapshotEvents().some(event => event.type === 'model/selection')).toBe(false)
})
it('reclaims a resumed Session whose existing selection points at a gone provider (root fix)', async () => {
  const { ctx, agent, listModels, selectModel } = await fixture()
  // 主 Session 落盘的旧选择：provider 已下线（deepseek-account 那种情况）——拉它的目录直接抛错。
  const dead = { provider: 'deepseek-account', model: 'deepseek-flash' }
  const event = agent.session.append('model/selection', dead); ctx.emit('session/event', agent.session, event)
  // 内建 deepseek-account：provider 与配置(magpie)不同族 → 直接判脱管纠正，无需依赖 listModels 抛错
  // （它其实会用 bundled catalog 兜底返回假列表，所以不能信它的目录）。
  listModels.mockImplementation(async () => [{ id: 'workbuddy/deepseek-v4.1-flash-500k' }])
  // 配置里已经是能用的 workbuddy：旧死选择应被纠正成它，而不是跳过保持坏的。
  await initializeRoleModel(ctx, agent, { provider: 'magpie', model: 'workbuddy/deepseek-v4.1-flash-500k' })
  // 真正用 selectModel 切换（不是 append），这样老会话之后的请求也换模型，重启不再回旧状态。
  expect(selectModel).toHaveBeenCalledWith(expect.objectContaining({ provider: 'magpie', model: 'workbuddy/deepseek-v4.1-flash-500k' }))
})

// #13 的收口线：「光 selection 写对不算，request 走对才算」。
// 宿主里 sessionController.selectModel 走 selectForNextRequest：它 append 一条 durable
// model/selection，并把 selection.current 置为新选择；installModelSelection 在
// system-prompt/assemble 时把 current 快照成 assembled，agent/request 再用 assembled
// 覆盖 provider/model。所以切换必须走 selectModel 这个正规接口——只 append 事件、
// 或把旧 requestHeader 留在那儿，下一次真实 request 就会继续用死 provider。
it('routes the actual request through the configured provider after reclaiming a dead selection (#13)', async () => {
  const { ctx, agent, host, listModels, selectModel, request } = await fixture()
  const dead = { provider: 'deepseek-account', model: 'deepseek-flash' }
  // 老会话：既发过请求（落盘 header 指向死 provider），也有过时的 selection。
  agent.session.append('request/header', { header: { config: dead }, reason: 'initial' })
  const event = agent.session.append('model/selection', dead); ctx.emit('session/event', agent.session, event)
  listModels.mockImplementation(async () => [{ id: 'workbuddy/deepseek-v4.1-flash-500k' }])
  // mock 只模拟宿主 selectForNextRequest 的那一半：把新选择写成 selection.current。
  // 关键是不调 selectModel 就不会更新——若实现退回 append 老路，request 仍走死 provider，此例变红。
  selectModel.mockImplementation(async (r: { provider: string; model: string }) => {
    Object.defineProperty(host, 'current', { value: { provider: r.provider, model: r.model }, configurable: true, writable: true })
    return { selected: { provider: r.provider, model: r.model } }
  })
  await initializeRoleModel(ctx, agent, { provider: 'magpie', model: 'workbuddy/deepseek-v4.1-flash-500k' })
  expect(selectModel).toHaveBeenCalledWith(expect.objectContaining({ provider: 'magpie', model: 'workbuddy/deepseek-v4.1-flash-500k' }))
  // 下一次真正组装 prompt 并发请求：provider/model 必须是新路由，不是 deepseek-account。
  await ctx.systemPrompt.assemble()
  expect(await request()).toMatchObject({ provider: 'magpie', model: 'workbuddy/deepseek-v4.1-flash-500k' })
})

/**
 * 上面那例验的是「宿主契约替身」：`selectModel` 被换成 mock，`selection.current` 由测试自己赋值，
 * `llm` 是 `resolveCallConfig: value => value` 的假服务。它能证明本仓**调了**正规接口，
 * 但证明不了宿主真的会把 request 送到新 provider——mock 的语义正是待验的那一环。
 *
 * 下面这例换掉替身：真实 `SessionController.selectModel`、真实 modelSelection 投影、
 * 真实 `installModelSelection`、真实 `LlmRuntime` + 真实 adapter 注册表，只在 **adapter 的
 * stream 边界**（provider 真正收到请求的那一层）记录 provider/model。#13 的口径是
 * 「request 走对才算」，所以断言落在 `stream()` 的入参上，不是 selection、不是 agent/request 的返回值。
 */
async function realHost() {
  const home = controllerHome()
  const { SessionProjectionRegistry } = await import(siblingModule(home, 'dsh-session-projection'))
  const { SessionController } = await import(join(home, 'lib', 'index.js'))
  const { AgentRegistry } = await import('@deepseek-ai/dsh-agent')
  const { LlmRuntime, LlmAdapter } = await import('@deepseek-ai/dsh-llm')

  const ctx = new Context(); contexts.push(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(AgentRegistry)
  const noop = (): void => {}
  // typert 只是 Remote 传输的查找表，不参与模型链路，用空实现顶掉。
  ctx.reflect.provide('typert', { lookups: { configure: noop, register: noop }, contexts: { configureHost: noop, registerHost: noop } })
  const llm = new LlmRuntime(ctx)
  const dispatched: string[] = []
  // 真实 adapter：listModels/resolveModel 走宿主的真实校验路径，stream 才是 provider 边界。
  class Recording extends LlmAdapter {
    override providerInfo(provider: string): { id: string; name: string } { return { id: provider, name: provider } }
    override listModels(provider: string): Promise<{ provider: string; id: string; name: string }[]> {
      return Promise.resolve([{ provider, id: 'dead-model', name: 'dead' }, { provider, id: 'live-model', name: 'live' }])
    }
    override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
      return Promise.resolve({ provider, id: model, name: model })
    }
    override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
      dispatched.push(`${options.provider}/${options.model}`)
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  llm.registerAdapter(['dead-provider', 'live-provider'], new Recording())
  ctx.reflect.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'live-provider', model: 'live-model' }), saveSelection: async () => {} })
  ctx.reflect.provide('sessions', { get: () => undefined })
  ctx.reflect.provide('sessionQuery', { query: async () => {}, read: async () => {} })
  ctx.reflect.provide('fileUploads', { registerAgentResolver: noop, bindPrompt: () => ({ commit: noop }), resolve: () => {} })
  ctx.reflect.provide('attachments', {})
  ctx.reflect.provide('fs', {})
  ctx.reflect.provide('workspaceRegistry', { create: async () => ({ id: 'workspace' }), list: () => [], archivedSessionIds: [] })
  ctx.reflect.provide('settings', { configure: noop, describe: () => [] })
  ctx.reflect.provide('credentials', { describe: async () => ({ configured: false }) })
  const controller = new SessionController(ctx, { nativeOpen: false })
  // SessionController 的构造函数把自己注册成 `sessionController` 服务，所以生产代码
  // （initializeRoleModel 的纠正分支）调用 `ctx.sessionController.selectModel` 时拿到的就是它。
  ctx.reflect.provide('sessionPersistence', { flush: async () => {} })
  // 宿主内部那个按 Agent 管 selection 的控制器；`agents` 是 private，这里用窄接口取出来，
  // 只为了在测试里模拟「引用已装好」和「引用没被置上」两种宿主状态。
  const inner = (controller as unknown as { agents: SelectionHost }).agents
  return { ctx, controller, inner, llm, dispatched }
}
/** 宿主 `ApiSessionAgentController` 里与 selection 相关的公开面（只声明测试要用的部分）。 */
interface SelectionHost {
  selectionFor(agent: Agent): { readonly current: ModelSelection | undefined; assembled: ModelSelection | undefined }
  selectForNextRequest(agent: Agent, selection: ModelSelection): void
}

it('routes a real request to the new provider through the host\'s own selection chain (#13)', async () => {
  const { ctx, inner, llm, dispatched } = await realHost()
  // 老会话：落盘 header 与 selection 都指向一个已经不存在的 provider（`34269a1` 的现场）。
  const session = Session.create(SessionId('role-model-real'))
  session.append('request/header', { header: { config: { provider: 'dead-provider', model: 'dead-model' } }, reason: 'initial' })
  const stale = session.append('model/selection', { provider: 'dead-provider', model: 'dead-model' })
  ctx.emit('session/event', session, stale)
  const agent = { id: 'role-model-real', session, ctx, options: {} } as unknown as Agent
  // 注册成 live agent，让 selectModel 走 liveAgent 分支（与生产里主 Session 已在跑的状态一致）。
  const detach = ctx.agents.register(agent)
  try {
    // 生产里主 Session 是活的、早就在服务请求：selection 引用在第一次请求前就装好并留在那里。
    // 这里先把引用装出来（等价于宿主在主 Session 首次 assemble 时做的事），纠正才落在同一个引用上。
    inner.selectForNextRequest(agent, { provider: 'dead-provider', model: 'dead-model' })
    // 走**生产代码**：initializeRoleModel 判定旧选择脱管后，用 ctx.sessionController.selectModel 纠正。
    await initializeRoleModel(ctx, agent, { provider: 'live-provider', model: 'live-model' })
    // 真实组装 + 真实 agent/request waterfall，然后真的把这次请求交给 adapter。
    await ctx.systemPrompt.assemble({ agent })
    const proposed = await agentEvents(ctx, agent).waterfall('agent/request', { turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ provider: 'dead-provider', model: 'dead-model' }))
    for await (const _chunk of llm.stream({ provider: proposed.provider, model: proposed.model, messages: [] })) { /* drain */ }
    // 断言落在 provider 边界：adapter 真的收到了新路由的请求。
    expect(dispatched).toEqual(['live-provider/live-model'])
  } finally { detach() }
})

it('would fail the real-request assertion if the switch only appended a selection', async () => {
  const { ctx, controller, llm, dispatched } = await realHost()
  const session = Session.create(SessionId('role-model-append'))
  session.append('request/header', { header: { config: { provider: 'dead-provider', model: 'dead-model' } }, reason: 'initial' })
  session.append('model/selection', { provider: 'dead-provider', model: 'dead-model' })
  const agent = { id: 'role-model-append', session, ctx, options: {} } as unknown as Agent
  const detach = ctx.agents.register(agent)
  try {
    // 反例：只往 session 里 append 一条新 selection，不走 selectModel。
    // 这正是 ADR 0006 判定为「写对落盘、request 仍走旧 provider」的那条老路。
    const event = session.append('model/selection', { provider: 'live-provider', model: 'live-model' })
    ctx.emit('session/event', session, event)
    await ctx.systemPrompt.assemble({ agent })
    const proposed = await agentEvents(ctx, agent).waterfall('agent/request', { turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ provider: 'dead-provider', model: 'dead-model' }))
    for await (const _chunk of llm.stream({ provider: proposed.provider, model: proposed.model, messages: [] })) { /* drain */ }
    // 请求仍打到死 provider：证明上一例的绿灯不是恒真，而是 selectModel 真的起了作用。
    expect(dispatched).toEqual(['dead-provider/dead-model'])
  } finally { detach() }
})

it('inherits the host when unset and fails unavailable routes before recording a selection', async () => {
  const { ctx, agent, resolve, request } = await fixture()
  await initializeRoleModel(ctx, agent, null)
  await ctx.systemPrompt.assemble()
  expect(await request()).toMatchObject({ provider: 'host', model: 'default' })
  resolve.mockRejectedValueOnce(new Error('unknown provider'))
  await expect(initializeRoleModel(ctx, agent, { provider: 'unknown', model: 'x' })).rejects.toThrow('unknown provider')
  expect(agent.session.snapshotEvents().some(event => event.type === 'model/selection')).toBe(false)
})

it('falls back to the backup route when the primary provider cannot be resolved', async () => {
  const { ctx, agent, resolve, request } = await fixture()
  resolve.mockImplementation(async (value: { provider: string }) => {
    if (value.provider === 'primary') throw new Error('provider is down')
    return value
  })
  await initializeRoleModel(ctx, agent, { provider: 'primary', model: 'main', backup: { provider: 'backup', model: 'reserve' } })
  await ctx.systemPrompt.assemble()
  expect(await request()).toEqual({ provider: 'backup', model: 'reserve' })
})

it('uses the primary when it resolves and never touches the backup', async () => {
  const { ctx, agent, resolve } = await fixture()
  resolve.mockImplementation(async (value: { provider: string }) => {
    if (value.provider === 'backup') throw new Error('should not be tried')
    return value
  })
  await initializeRoleModel(ctx, agent, { provider: 'primary', model: 'main', backup: { provider: 'backup', model: 'reserve' } })
  expect(resolve).toHaveBeenCalledTimes(1)
})

it('throws the last error only when both the primary and the backup fail', async () => {
  const { ctx, agent, resolve } = await fixture()
  resolve.mockRejectedValue(new Error('everything is down'))
  await expect(initializeRoleModel(ctx, agent, { provider: 'primary', model: 'main', backup: { provider: 'backup', model: 'reserve' } }))
    .rejects.toThrow('everything is down')
  expect(agent.session.snapshotEvents().some(event => event.type === 'model/selection')).toBe(false)
})

// #8-1 启动一致性检查：settings 里任一路由主备都解析不通时，checkRoleRoutes 要把它报出来，
// 好让运行时在启动阶段拦下（进 Eval 前就报错，而不是 evaluating 里死等）。
it('checkRoleRoutes reports a route whose provider cannot resolve', async () => {
  const { ctx, resolve } = await fixture()
  // 让 worker-provider 解析成功，unknown-provider 抛错（模拟 provider 下线 / 名字配错）。
  resolve.mockImplementation(async (value: { provider: string }) => {
    if (value.provider === 'unknown-provider') throw new Error('unknown provider')
    return value
  })
  const { checkRoleRoutes } = await import('../src/app/role-models.ts')
  const ok = await checkRoleRoutes(ctx, [{ provider: 'worker-provider', model: 'm' }])
  expect(ok).toEqual([])
  const bad = await checkRoleRoutes(ctx, [{ provider: 'unknown-provider', model: 'x' }])
  expect(bad).toHaveLength(1)
  const first = bad[0]!
  expect(first.ok).toBe(false)
  expect(first.detail).toContain('unknown-provider')
  expect(first.detail).toContain('unknown provider')
})

// 主路由挂了但 backup 通 —— 不算错配（resolveRoutedModel 会自己退到 backup）。
it('checkRoleRoutes passes when the primary fails but the backup resolves', async () => {
  const { ctx, resolve } = await fixture()
  resolve.mockImplementation(async (value: { provider: string }) => {
    if (value.provider === 'down') throw new Error('connection refused')
    return value
  })
  const { checkRoleRoutes } = await import('../src/app/role-models.ts')
  const result = await checkRoleRoutes(ctx, [{ provider: 'down', model: 'x', backup: { provider: 'up', model: 'y' } }])
  expect(result).toEqual([])
})

// 没配（null/undefined）不算错配：走宿主默认，跳过检查。
it('checkRoleRoutes skips unset routes', async () => {
  const { ctx } = await fixture()
  const { checkRoleRoutes } = await import('../src/app/role-models.ts')
  expect(await checkRoleRoutes(ctx, [null, undefined])).toEqual([])
})
