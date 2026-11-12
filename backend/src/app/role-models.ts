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

/** 从 session 的事件里取最后一次持久化的模型选择（没有则 undefined）。 */
function durableSelection(agent: Agent): ModelSelection | undefined {
  let last: ModelSelection | undefined
  for (const event of agent.session.snapshotEvents()) {
    if (event.type === 'model/selection') last = (event as { data?: ModelSelection }).data
  }
  return last
}

/**
 * 判断一条已有 selection 是否「还在配置体系里、可以保留」。
 *
 * 背景（这是 #4 那类静默卡死的根因）：主 Session 的 selection 是历史落盘的，可能指向一个
 * 如今已不可用的 provider（例如内建的 `deepseek-account`——它没有 `DEEPSEEK_API_KEY`，只靠
 * bundled catalog 兜底列模型，所以 `listModels` 永远「成功」但它根本调不通）。以前 initializeRoleModel
 * 「有 selection 就跳过」，于是队伍永远绑死在死 provider 上、Eval 卡在 evaluating 直到超时。
 *
 * 确定性判据（不依赖网络探测，因为 provider 的兜底目录会骗人）：
 * 1. **provider 必须与配置路由 model 的 provider 一致**。本部署的可用凭据只有一套（magpie），
 *    selection 的 provider 一旦偏离配置，就是脱管的死选择，必须纠正。
 * 2. 同 provider 下再看 `listModels` 目录里是否真有这个 model（防同一 provider 改名/下线）。
 *
 * 两条都满足才保留；否则纠正为配置路由。
 */
async function selectionInConfigFamily(ctx: Context, selection: ModelSelection, config: RoutedModel): Promise<boolean> {
  if (selection.provider !== config.provider) return false
  try {
    const models = await ctx.llm.listModels(selection.provider)
    return models.some(info => info.id === selection.model)
  } catch {
    return false
  }
}

/**
 * Seed a role's configured model onto a session.
 *
 * 行为：
 * - 全新 session（没有 requestHeader、没有 selection）→ 注入配置的路由（主→备取第一条通的）。
 * - 已有 selection 且**仍在配置体系内且可解析** → 保留（尊重人为/durable 选择，不覆盖）。
 * - 已有 selection 但 **provider 偏离配置体系 / 模型已不在目录**（如内建 deepseek-account 无凭据）→ **重新注入配置的路由**。
 *   这一条是修「选了新模型、重启又回到已下线的旧模型、队伍静默卡死」的根因：
 *   旧 selection 不该成为永久枷锁，模型不可用就该被纠正，并在启动一致性检查里同步暴露。
 */
export async function initializeRoleModel(ctx: Context, agent: Agent, model: RoutedModel | null): Promise<void> {
  if (!model) return
  const existing = durableSelection(agent)
  if (existing) {
    // 已有 durable selection：还在配置体系内且可解析就保留；否则这就是「脱管的死选择」，必须真正纠正。
    if (await selectionInConfigFamily(ctx, existing, model)) return
    // 关键：纠正**不能只 append 一条 selection**——已有会话早发过请求，initializeRoleModel 的「首帧注入」
    // 只作用于第一次请求，append 对老会话不生效（这正是「重启又回旧模型」的最后一层原因）。
    // 必须用 session/selectModel 真正切换：它更新 host.current，让之后的每一次请求都用新模型。
    const replacement = await resolveRoutedModel(ctx, model)
    await ctx.sessionController.selectModel({ sessionId: agent.session.id as never,
      provider: replacement.provider, model: replacement.model,
      ...(replacement.reasoningEffort ? { reasoningEffort: ReasoningEffortId(replacement.reasoningEffort) } : {}) })
    await ctx.sessionPersistence.flush()
    return
  }
  if (agent.session.requestHeader()) return // 有 requestHeader 却读不到 selection：无从判断，保持原样（交给启动检查兜底）。
  // 全新会话：用主/备里第一条能解析的路由，注入首帧选择（不动全局 DSH 默认）。
  const selected = await resolveRoutedModel(ctx, model)
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
