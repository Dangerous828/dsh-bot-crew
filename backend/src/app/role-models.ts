/** Resolves and seeds per-role default models on newly created sessions without mutating the global DSH default. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { RoleModel } from '../policy.ts'

/** 一条路由可能是「主路由 + 备选路由」的形状；这里只读用的最小结构。 */
export interface RoutedModel extends RoleModel { backup?: RoleModel }

/** 把一条路由展开成候选顺序：主路由优先，backup 次之（都没有 backup 就只有主路由）。 */
export function routeCandidates(model: RoutedModel): RoleModel[] {
  const head: RoleModel = { provider: model.provider, model: model.model,
    ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}) }
  const backup = model.backup
    ? [{ provider: model.backup.provider, model: model.backup.model,
      ...(model.backup.reasoningEffort ? { reasoningEffort: model.backup.reasoningEffort } : {}) }]
    : []
  return [head, ...backup]
}

/** Resolve a configured route through the live provider; catalog membership is not a restriction. */
export async function resolveRoleModel(ctx: Context, model: RoleModel): Promise<ModelSelection> {
  const value = await ctx.llm.resolveCallConfig({ provider: model.provider, model: model.model,
    ...(model.reasoningEffort ? { reasoningEffort: ReasoningEffortId(model.reasoningEffort) } : {}) })
  return { provider: value.provider, model: value.model, ...(value.reasoningEffort ? { reasoningEffort: value.reasoningEffort } : {}) }
}

/**
 * Resolve a route to a selection, trying each candidate in order.
 *
 * 主路由解析不通（provider 下线、配错名字之类）时退到 backup，全部失败才把最后一条错误抛上去 ——
 * 「模型不可用」只在这时候成立。这样一处 provider 抖动不会让整张工单在 `initializeRoleModel` 里直接死掉。
 */
export async function resolveRoutedModel(ctx: Context, model: RoutedModel): Promise<ModelSelection> {
  const candidates = routeCandidates(model)
  let last: unknown
  for (const candidate of candidates) {
    try { return await resolveRoleModel(ctx, candidate) }
    catch (error) { last = error }
  }
  throw last instanceof Error ? last : new Error(String(last))
}

/** Seed a role's configured model onto a brand-new session before its first request, leaving later manual or durable selections intact. */
export async function initializeRoleModel(ctx: Context, agent: Agent, model: RoutedModel | null): Promise<void> {
  if (!model) return
  if (agent.session.requestHeader() || agent.session.snapshotEvents().some(event => event.type === 'model/selection')) return
  const selected = await resolveRoutedModel(ctx, model)
  // Avoid selectModel because it mutates the global DSH default; inject the selection for the initial request only.
  agent.session.append('model/selection', selected)
  let initial = true
  let assembled: ModelSelection | undefined
  agent.ctx.effect(() => {
    const disposers = [
      agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
        const selection = initial ? selected : undefined
        const result = await next()
        assembled = selection
        return selection ? { ...result, variables: { ...result.variables, provider: selection.provider, model: selection.model } } : result
      }, { prepend: true }),
      agent.ctx.on('agent/request', async (_payload, next) => {
        const result = await next()
        if (!assembled) return result
        const { reasoningEffort: _inherited, ...rest } = result
        return { ...rest, ...assembled }
      }, { prepend: true }),
      ctx.on('session/event', (session, event) => {
        if (session === agent.session && (event.type === 'request/header' || event.type === 'model/selection')) initial = false
      }),
    ]
    return () => disposers.forEach(dispose => dispose())
  })
  await ctx.sessionPersistence.flush()
}
