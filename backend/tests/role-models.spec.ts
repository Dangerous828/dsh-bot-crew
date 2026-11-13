import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { agentEvents, installModelSelection, type Agent, type ModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { initializeRoleModel } from '../src/app/role-models.ts'
const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())); vi.restoreAllMocks() })
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
