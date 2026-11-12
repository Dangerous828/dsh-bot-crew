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

/**
 * 一条路由在启动时「能不能解析通」的预检结果。
 *
 * `ok` 表示主路由或备选路由里至少有一条能解析（provider 在、model 名字认得出）；
 * `detail` 在失败时给一句人话，用来记到 health 与启动日志里，别让操作者对着
 * 「Eval 一直卡在 evaluating」猜。
 */
export interface RouteCheck {
  ok: boolean
  detail: string
}

/**
 * 启动一致性检查：把 settings 里所有会被拿来用的路由（eval、executor、每个 bot 的路由）
 * 各解析一次，确认主/备至少有一条通。
 *
 * 为什么要它：#4 那类静默卡死的一种成因，是 settings 里写了一个解析不通的模型，而 Eval 建起来
 * 之后不会失败、只会等 judgement 等到超时。在这里先把错配拦在启动阶段 —— 报错清清楚楚，
 * 而不是进入 evaluating 之后死等。复用 resolveRoutedModel，主路由不通时它自己会试 backup，
 * 所以「主挂了但备在」不会误报。
 *
 * 返回所有失败项（空数组 = 全部通）。调用方据此决定是否拦下启动。
 */
export async function checkRoleRoutes(ctx: Context, models: readonly (RoutedModel | null | undefined)[]): Promise<RouteCheck[]> {
  const failures: RouteCheck[] = []
  for (const model of models) {
    if (!model) continue // 没配 = 走宿主默认，不是错配，跳过
    try {
      await resolveRoutedModel(ctx, model)
    } catch (error) {
      const label = [model.provider, model.model].filter(Boolean).join('/')
      failures.push({ ok: false, detail: `${label || '(未命名路由)'}：${error instanceof Error ? error.message : String(error)}` })
    }
  }
  return failures
}
