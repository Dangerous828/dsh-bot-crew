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
  const flush = vi.fn(async () => {})
  ctx.reflect.provide('llm', { resolveCallConfig: resolve })
  ctx.reflect.provide('sessionPersistence', { flush })
  const session = Session.create(SessionId('role-model'))
  const agent = { ctx, session } as Agent
  const host: ModelSelectionRef = { get current() { return session.requestHeader()?.config ?? { provider: 'host', model: 'default', reasoningEffort: ReasoningEffortId('high') } }, assembled: undefined }
  installModelSelection(ctx, host)
  const request = () => agentEvents(ctx, agent).waterfall('agent/request', { turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ provider: 'seed', model: 'seed' }))
  const record = (selection: ModelSelection) => { const event = session.append('request/header', { header: { config: selection }, reason: 'initial' }); ctx.emit('session/event', session, event) }
  return { ctx, agent, host, resolve, flush, request, record }
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
it.each(['header', 'selection'])('preserves a resumed Session with existing %s', async kind => {
  const { ctx, agent, resolve } = await fixture()
  const existing = { provider: 'existing', model: 'keep' }
  if (kind === 'header') agent.session.append('request/header', { header: { config: existing }, reason: 'initial' })
  else agent.session.append('model/selection', existing)
  await initializeRoleModel(ctx, agent, { provider: 'worker', model: 'new' })
  expect(resolve).not.toHaveBeenCalled()
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
