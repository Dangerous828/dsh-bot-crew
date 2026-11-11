/**
 * 成本账：每条回复用的哪个模型、花了多少 token。
 *
 * 数据源**只有一个**：DSH 会话事件里 `assistant/message` 的 `usage`
 * （`TokenUsage`：input / output / total / cacheRead / cacheWrite / reasoning）。
 * 有没有这一项由 provider 决定：上报了就记，没上报就是没有 —— **绝不估**。
 * 「大概 4 万字」比「不知道」更糟，因为它看起来像个数。
 *
 * 金额这一层这里不算：单价随 provider、套餐、时段变，写死在代码里必然过期。
 * 这一份给的是**可核对的用量**，钱由看到的人拿自己的价目表乘。
 */

/** 一次模型调用的用量。字段名与 DSH 的 `TokenUsage` 一致，缺的就不给。 */
export interface Usage {
  inputTokens: number
  outputTokens: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

/** 一步（一个 turn 里的一次模型调用）的账。 */
export interface SpendStep {
  turn: number
  step: number
  /** 这一刻用的哪条路由；事件里没带就退回会话的默认路由。 */
  provider?: string
  model?: string
  usage: Usage
  at?: string
}

/** 一张票的总账。 */
export interface Spend {
  step_count: number
  input_tokens: number
  output_tokens: number
  total_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  reasoning_tokens: number
  /** 有几步没有用量上报：这个数不为 0 时，上面的合计只是「有报的那几步」。 */
  unaccounted_steps: number
  /** 按模型分的合计，键是 `provider/model`。 */
  by_model: { provider: string; model: string; steps: number; input_tokens: number; output_tokens: number; total_tokens: number }[]
  /** 最近几步，给「它刚才那一下用的哪个模型」这个问题一个直接的答案。 */
  recent: SpendStep[]
}

/** 会话事件里成本账会读到的最小形状（`screen` / `outputs` 同款：只声明用得到的字段）。 */
export interface SpendEvent {
  type: string
  turn?: number
  step?: number
  usage?: Partial<Usage>
  data?: { provider?: string; model?: string; usage?: Partial<Usage> }
  time?: string
}

/** 最近几步留在 `recent` 里。够回答「刚才那一下」，又不至于把一屏塞满。 */
export const RECENT_STEPS = 5

const number = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0

/** 一条事件是不是一次模型调用；是就取出它的用量与路由。 */
export function stepOf(event: SpendEvent, fallback: { provider?: string; model?: string } = {}): SpendStep | undefined {
  if (event.type !== 'assistant/message') return undefined
  const usage = event.usage ?? event.data?.usage
  const provider = event.data?.provider ?? fallback.provider
  const model = event.data?.model ?? fallback.model
  return {
    turn: number(event.turn),
    step: number(event.step),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    usage: {
      inputTokens: number(usage?.inputTokens),
      outputTokens: number(usage?.outputTokens),
      ...(usage?.totalTokens === undefined ? {} : { totalTokens: number(usage.totalTokens) }),
      ...(usage?.cacheReadTokens === undefined ? {} : { cacheReadTokens: number(usage.cacheReadTokens) }),
      ...(usage?.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: number(usage.cacheWriteTokens) }),
      ...(usage?.reasoningTokens === undefined ? {} : { reasoningTokens: number(usage.reasoningTokens) }),
    },
    ...(typeof event.time === 'string' && event.time ? { at: event.time } : {}),
  }
}

/**
 * 把一张票的会话事件算成一本账。
 *
 * `unaccounted_steps` 是这一份里最重要的字段：有的 provider 不上报用量，
 * 那时候合计只覆盖「报了的那几步」。把它写出来，读的人才知道这个数能信到什么程度。
 */
export function spendOf(events: readonly SpendEvent[], fallback: { provider?: string; model?: string } = {}): Spend {
  const steps: SpendStep[] = []
  let unaccounted = 0
  for (const event of events) {
    const step = stepOf(event, fallback)
    if (!step) continue
    // 有事件但没有用量：算一步「不知道」，不是零。
    if (event.usage === undefined && event.data?.usage === undefined) unaccounted += 1
    steps.push(step)
  }
  const sum = (pick: (usage: Usage) => number | undefined): number => steps.reduce((total, step) => total + number(pick(step.usage)), 0)
  const byModel = new Map<string, { provider: string; model: string; steps: number; input_tokens: number; output_tokens: number; total_tokens: number }>()
  for (const step of steps) {
    const provider = step.provider ?? 'unknown', model = step.model ?? 'unknown'
    const line = byModel.get(`${provider}/${model}`) ?? { provider, model, steps: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0 }
    line.steps += 1
    line.input_tokens += step.usage.inputTokens
    line.output_tokens += step.usage.outputTokens
    line.total_tokens += step.usage.totalTokens ?? step.usage.inputTokens + step.usage.outputTokens
    byModel.set(`${provider}/${model}`, line)
  }
  return {
    step_count: steps.length,
    input_tokens: sum(usage => usage.inputTokens),
    output_tokens: sum(usage => usage.outputTokens),
    total_tokens: sum(usage => usage.totalTokens ?? usage.inputTokens + usage.outputTokens),
    cache_read_tokens: sum(usage => usage.cacheReadTokens),
    cache_write_tokens: sum(usage => usage.cacheWriteTokens),
    reasoning_tokens: sum(usage => usage.reasoningTokens),
    unaccounted_steps: unaccounted,
    by_model: [...byModel.values()].sort((left, right) => right.steps - left.steps),
    recent: steps.slice(-RECENT_STEPS),
  }
}
