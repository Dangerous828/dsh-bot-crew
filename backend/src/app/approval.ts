/**
 * 审批：这活做不做。
 *
 * 与 `eval.mode` 是两件事，别混：
 * - `eval.mode`（off / observe / auto）判的是**队伍接不接这条活** —— 接了之后照常做完；
 * - 这里的 `approval` 判的是**接了的活要不要先问一声** —— `ask` 时队伍先停下来等你点头。
 *
 * 三档，都只作用在「已接单」的工作上：
 *
 * | 档 | 意思 |
 * |---|---|
 * | `auto` | 自动做。只有明确写下的禁区（`blocked` 规则命中的）才会停下 |
 * | `ask`  | 需你点头。命中「要审批的」规则时先问，其余照 `auto` 做 |
 * | `off`  | 禁区。一律先问，不自动开工 |
 *
 * 为什么不是简单的「一刀切」：让人对每一件小事点头，他三天后就闭着眼点同意了 ——
 * 那比不问更糟。所以默认档是 `ask`：**只对真的要紧的那几类停下来**。
 */

/** 三种档位。`off` 这个名字沿用 eval 那套，意思是「不自动做」。 */
export type ApprovalMode = 'auto' | 'ask' | 'off'

/** 一次审批判定。 */
export interface ApprovalDecision {
  /** 要不要先问人。 */
  ask: boolean
  /** 为什么。`ask` 为 true 时这句会原样显示给人看。 */
  reason: string
  /** 是哪条规矩让它停下的；`off` 档下可能是 `mode`。 */
  because: 'mode' | 'rule' | 'budget' | 'none'
}

/** 判定需要知道的那些事实。都由调用方从已有数据里读出来，这里不自己查。 */
export interface ApprovalFacts {
  /** 当前档位。 */
  mode: ApprovalMode
  /** 命中的规则 id（来自评估）。 */
  rules: readonly string[]
  /** 那些规则里，哪几条被标成了「要审批」。 */
  sensitive: readonly string[]
  /** 这次活会不会写盘 / 调外部服务。读了不算。 */
  writes?: boolean
  /** 已经用掉的额度比例（0..1）；`undefined` 表示不知道。 */
  budgetUsed?: number
}

/** 超过这个比例就先问一句：快没钱了还闷头干活，是最难解释的一种。 */
export const BUDGET_ASK_RATIO = 0.9

/**
 * 判一次。
 *
 * 顺序是有意的：**档位 → 规则 → 额度**。前面的挡得住就不看后面的 ——
 * 反过来会让一句「额度快用完了」盖掉「这条规矩是禁区」，让人以为那只是钱的事。
 */
export function approvalOf(facts: ApprovalFacts): ApprovalDecision {
  if (facts.mode === 'off') {
    return { ask: true, because: 'mode', reason: '现在设的是「一律先问」：接了的活也要你点头才动' }
  }
  const hit = facts.rules.filter(rule => facts.sensitive.includes(rule))
  if (facts.mode === 'ask' && hit.length > 0) {
    return { ask: true, because: 'rule', reason: `这条撞上了要审批的规矩：${hit.join('、')}` }
  }
  if (facts.budgetUsed !== undefined && facts.budgetUsed >= BUDGET_ASK_RATIO) {
    return { ask: true, because: 'budget', reason: `额度已经用掉 ${Math.round(facts.budgetUsed * 100)}%，再干下去要先跟你说一声` }
  }
  return { ask: false, because: 'none', reason: '' }
}

/** A/B 面板上那两个按钮：从「选哪个」扩到「做不做」。 */
export interface ApprovalPrompt {
  question: string
  options: { id: string; label: string }[]
}

/**
 * 需要点头时，问什么。
 *
 * 三个选项而不是两个：只给「做 / 不做」时，人想「换个做法」只能拒绝再重说一遍。
 * `revise` 让队伍停在原地等一句新要求，不用把活重新派一遍。
 */
export function approvalPrompt(title: string, decision: ApprovalDecision): ApprovalPrompt {
  return {
    question: `${decision.reason}。要「${title}」吗？`,
    options: [
      { id: 'go', label: '做吧' },
      { id: 'stop', label: '先别做' },
      { id: 'revise', label: '换个做法' },
    ],
  }
}

/** 人的回答怎么读。认不出的回答按「先别做」处理 —— 宁可不动，也不要猜他要什么。 */
export function readAnswer(text: string): 'go' | 'stop' | 'revise' {
  const said = text.trim()
  if (/^(做吧|做|同意|可以|开始|好|go|yes|ok)$/i.test(said)) return 'go'
  if (/^(换个做法|改一下|换个方式|revise|change)$/i.test(said)) return 'revise'
  return 'stop'
}
