import { describe, expect, it } from 'vitest'
import { CONTEXT_WARN_RATIO, compact, quotaOf, quotaWarning, replyLine, replySpendOf } from '../src/app/quota.ts'

describe('replySpendOf', () => {
  it('names the route that answered and what it cost', () => {
    expect(replySpendOf({ provider: 'magpie', model: 'k3', usage: { inputTokens: 1200, outputTokens: 300 } })).toMatchObject({
      route: 'magpie/k3', input_tokens: 1200, output_tokens: 300, total_tokens: 1500,
    })
  })

  it('computes the context left only when the window is disclosed', () => {
    const known = replySpendOf({ provider: 'p', model: 'm', usage: { inputTokens: 30_000 }, contextWindow: 128_000 })
    expect(known.context_left).toBe(98_000)
    const unknown = replySpendOf({ provider: 'p', model: 'm', usage: { inputTokens: 30_000 } })
    // 不知道就不写：编一个「还剩 128k」会让人放心地继续聊，然后突然撞墙。
    expect(unknown).not.toHaveProperty('context_left')
    expect(unknown).not.toHaveProperty('context_window')
  })

  it('counts only the input against the window', () => {
    // 输出是这一步新写的，不占「已用」。
    const spend = replySpendOf({ provider: 'p', model: 'm', usage: { inputTokens: 1_000, outputTokens: 90_000 }, contextWindow: 10_000 })
    expect(spend.context_left).toBe(9_000)
  })

  it('never goes negative when a step exceeded the window', () => {
    expect(replySpendOf({ provider: 'p', model: 'm', usage: { inputTokens: 200_000 }, contextWindow: 128_000 }).context_left).toBe(0)
  })

  it('says unknown rather than guessing a route', () => {
    expect(replySpendOf({ usage: {} }).route).toBe('unknown/unknown')
  })
})

describe('quotaOf', () => {
  it('admits it does not know when no window was disclosed', () => {
    const quota = quotaOf([replySpendOf({ usage: { inputTokens: 10 } })])
    expect(quota.used_ratio).toBeUndefined()
    expect(quotaWarning(quota)).toBeUndefined()
  })

  it('reports the tightest step, not the average', () => {
    // 平均值会把「最后那一步快满了」这件事藏起来。
    const quota = quotaOf([
      replySpendOf({ usage: { inputTokens: 1_000 }, contextWindow: 100_000 }),
      replySpendOf({ usage: { inputTokens: 95_000 }, contextWindow: 100_000 }),
      replySpendOf({ usage: { inputTokens: 20_000 }, contextWindow: 100_000 }),
    ])
    expect(quota.tightest_left).toBe(5_000)
    expect(quota.used_ratio).toBeCloseTo(0.95, 5)
  })
})

describe('quotaWarning', () => {
  it('speaks up when the context is nearly full', () => {
    const warning = quotaWarning(quotaOf([replySpendOf({ usage: { inputTokens: 95_000 }, contextWindow: 100_000 })]))
    expect(warning).toContain('95%')
    expect(warning).toContain('5.0k')
    // 光说「快满了」不够：要说清怎么办，而且这件事不会丢记忆。
    expect(warning).toContain('另起一个')
    expect(warning).toContain('记忆不会丢')
  })

  it('stays quiet below the threshold', () => {
    expect(quotaWarning(quotaOf([replySpendOf({ usage: { inputTokens: 50_000 }, contextWindow: 100_000 })]))).toBeUndefined()
    expect(CONTEXT_WARN_RATIO).toBe(0.9)
  })
})

describe('compact', () => {
  it('writes numbers the way a person reads them', () => {
    expect(compact(0)).toBe('0')
    expect(compact(999)).toBe('999')
    expect(compact(1_200)).toBe('1.2k')
    expect(compact(1_500_000)).toBe('1.5M')
  })
})

describe('replyLine', () => {
  it('puts the route, the cost and what is left on one line', () => {
    expect(replyLine(replySpendOf({ provider: 'magpie', model: 'k3', usage: { inputTokens: 1200, outputTokens: 300 }, contextWindow: 128_000 })))
      .toBe('magpie/k3 · 进 1.2k 出 300 · 余 126.8k')
  })

  it('leaves the unknown part out instead of printing a placeholder', () => {
    expect(replyLine(replySpendOf({ provider: 'dsh', model: 'm1', usage: { inputTokens: 10, outputTokens: 5 } })))
      .toBe('dsh/m1 · 进 10 出 5')
  })
})
