/**
 * 逐条用量与额度：每条回复标清「哪个模型答的、花了多少」，以及「还剩多少」。
 *
 * 与 `spend.ts` 的分工：
 * - `spend.ts` 按**票**总账（一张票一共花了多少）；
 * - 这一份按**每条回复**（刚才那一下用了谁、多少），再由此算额度。
 *
 * 「额度」这个词在这里只有一个诚实的含义：**上下文余量**（`contextWindow` 减去这一步的
 * 输入 token）。它由模型自己公布，可核对。**余额（还剩多少钱）这里不算**：单价与套餐
 * 由 provider 决定，不在这台机器上，也不在会话事件的任何一个字段里。要把余额算出来
 * 只能靠编，而编出来的余额比没有余额更危险 —— 人会拿它做决定。
 */

/** 一条回复的账：答卷的是谁、花了多少、上下文还剩多少。 */
export interface ReplySpend {
  /** `provider/model`，事件里没带就写 unknown。 */
  route: string
  input_tokens: number
  output_tokens: number
  total_tokens: number
  /** 这一步之后上下文还剩多少。`contextWindow` 不知道时缺席 —— 不猜。 */
  context_left?: number
  context_window?: number
}

/** 额度：只报算得出来的那一种。 */
export interface Quota {
  /** 上下文余量里最少的那一步（最紧的时候）。 */
  tightest_left?: number
  context_window?: number
  /** 用到什么比例；`context_window` 不知道时缺席。 */
  used_ratio?: number
  /** 告急的阈值：留不到一成时提前说。 */
  warn_ratio: number
}

/** 余量低于这个比例就说一声：撞上「上下文满了」才知道，是最贵的一种发现方式。 */
export const CONTEXT_WARN_RATIO = 0.9

/**
 * 一条回复的账。
 *
 * `contextWindow` 从模型目录里读（provider 公布才有）。读不到就不写 `context_left`：
 * 一个编出来的「还剩 128k」会让人放心地继续聊，然后在某一刻突然撞墙。
 */
export function replySpendOf(input: {
  provider?: string
  model?: string
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number }
  contextWindow?: number
}): ReplySpend {
  const inputTokens = positive(input.usage.inputTokens)
  const outputTokens = positive(input.usage.outputTokens)
  const total = input.usage.totalTokens === undefined ? inputTokens + outputTokens : positive(input.usage.totalTokens)
  const route = `${input.provider ?? 'unknown'}/${input.model ?? 'unknown'}`
  const window = input.contextWindow && input.contextWindow > 0 ? input.contextWindow : undefined
  // 余量按**输入**算：那才是被塞进上下文的量。输出是这一步新写的，不占「已用」。
  const left = window === undefined ? undefined : Math.max(0, window - inputTokens)
  return {
    route, input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: total,
    ...(left === undefined ? {} : { context_left: left, context_window: window }),
  }
}

const positive = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0

/**
 * 额度告急没有。只对**算得出来的**那一种作答。
 *
 * `undefined` 的意思是「不知道」，与 `false`（「还够」）分开 —— 混在一起会让人以为
 * 系统在替他看着，而实际上它根本没看见。
 */
export function quotaOf(replies: readonly ReplySpend[], warnRatio = CONTEXT_WARN_RATIO): Quota {
  const known = replies.filter(reply => reply.context_window !== undefined && reply.context_left !== undefined)
  if (known.length === 0) return { warn_ratio: warnRatio }
  // 最紧的那一步决定告急：余量一直在掉，平均值会把它藏起来。
  const tightest = known.reduce((lowest, reply) => reply.context_left! < lowest.context_left! ? reply : lowest)
  const window = tightest.context_window!
  const left = tightest.context_left!
  return { tightest_left: left, context_window: window, used_ratio: 1 - left / window, warn_ratio: warnRatio }
}

/** 额度告急该说一句吗。`undefined`（不知道）时不说 —— 不知道的事不要拿来吓人。 */
export function quotaWarning(quota: Quota): string | undefined {
  if (quota.used_ratio === undefined || quota.context_window === undefined || quota.tightest_left === undefined) return undefined
  if (quota.used_ratio < quota.warn_ratio) return undefined
  return `上下文用到 ${Math.round(quota.used_ratio * 100)}%，只剩 ${compact(quota.tightest_left)} / ${compact(quota.context_window)}。`
    + '长会话可以考虑另起一个，记忆不会丢 —— 它已经在账本里了。'
}

/** 12000 → 12k，1500000 → 1.5M。与桌面端 `compactTokens` 同一套写法。 */
export function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

/**
 * 一条回复底下那行小字：`magpie/k3 · 进 1.2k 出 300 · 余 120k`。
 *
 * 缺的项直接不写，不留占位符：一个空的「余 —」比不写更让人以为坏了。
 */
export function replyLine(spend: ReplySpend): string {
  const parts = [spend.route, `进 ${compact(spend.input_tokens)} 出 ${compact(spend.output_tokens)}`]
  if (spend.context_left !== undefined) parts.push(`余 ${compact(spend.context_left)}`)
  return parts.join(' · ')
}
