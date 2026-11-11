import { describe, expect, it } from 'vitest'
import { RECENT_STEPS, spendOf, stepOf, type SpendEvent } from '../src/app/spend.ts'

const message = (over: Partial<SpendEvent> = {}): SpendEvent => ({ type: 'assistant/message', turn: 1, step: 1, ...over })

describe('stepOf', () => {
  it('reads the usage DSH recorded for the step', () => {
    const step = stepOf(message({ usage: { inputTokens: 1200, outputTokens: 300, totalTokens: 1500, reasoningTokens: 90 } }))
    expect(step?.usage).toEqual({ inputTokens: 1200, outputTokens: 300, totalTokens: 1500, reasoningTokens: 90 })
  })

  it('ignores events that are not a model call', () => {
    expect(stepOf({ type: 'tool/call' })).toBeUndefined()
    expect(stepOf({ type: 'turn/end' })).toBeUndefined()
  })

  it('falls back to the session route when the event does not name one', () => {
    expect(stepOf(message(), { provider: 'magpie', model: 'k3' })).toMatchObject({ provider: 'magpie', model: 'k3' })
    expect(stepOf(message({ data: { provider: 'dsh', model: 'm1' } }), { provider: 'magpie' })).toMatchObject({ provider: 'dsh', model: 'm1' })
  })

  it('treats a negative or non-numeric count as absent, never as a number', () => {
    const step = stepOf(message({ usage: { inputTokens: -5, outputTokens: Number.NaN } }))
    expect(step?.usage.inputTokens).toBe(0)
    expect(step?.usage.outputTokens).toBe(0)
  })
})

describe('spendOf', () => {
  it('adds up every step it was given, and says how many steps reported nothing', () => {
    const spend = spendOf([
      message({ turn: 1, step: 1, usage: { inputTokens: 1000, outputTokens: 200 } }),
      // 有这一步，但没有用量上报：算「不知道」，不是零。
      message({ turn: 1, step: 2 }),
      message({ turn: 2, step: 1, usage: { inputTokens: 500, outputTokens: 100, cacheReadTokens: 300 } }),
    ])
    expect(spend.step_count).toBe(3)
    expect(spend.unaccounted_steps).toBe(1)
    expect(spend.input_tokens).toBe(1500)
    expect(spend.output_tokens).toBe(300)
    // 没有 totalTokens 时按 input + output 算，不凭空多一块。
    expect(spend.total_tokens).toBe(1800)
    expect(spend.cache_read_tokens).toBe(300)
  })

  it('splits the bill by model, busiest first', () => {
    const spend = spendOf([
      message({ data: { provider: 'magpie', model: 'k3' }, usage: { inputTokens: 10, outputTokens: 5 } }),
      message({ data: { provider: 'magpie', model: 'k3' }, usage: { inputTokens: 10, outputTokens: 5 } }),
      message({ data: { provider: 'dsh', model: 'm1' }, usage: { inputTokens: 7, outputTokens: 3 } }),
    ])
    expect(spend.by_model[0]).toMatchObject({ provider: 'magpie', model: 'k3', steps: 2, input_tokens: 20, output_tokens: 10 })
    expect(spend.by_model[1]).toMatchObject({ provider: 'dsh', model: 'm1', steps: 1 })
  })

  it('keeps only the last few steps, so "the one just now" is answerable', () => {
    const events = Array.from({ length: RECENT_STEPS + 3 }, (_, index) => message({ turn: index, step: 1, usage: { inputTokens: 1, outputTokens: 1 } }))
    const spend = spendOf(events)
    expect(spend.recent).toHaveLength(RECENT_STEPS)
    expect(spend.recent.at(-1)?.turn).toBe(RECENT_STEPS + 2)
  })

  it('says "unknown" for a session that never named a route', () => {
    const spend = spendOf([message({ usage: { inputTokens: 1, outputTokens: 1 } })])
    expect(spend.by_model[0]).toMatchObject({ provider: 'unknown', model: 'unknown' })
  })

  it('reports an empty bill rather than throwing for a session with no model calls', () => {
    expect(spendOf([{ type: 'user/message' }, { type: 'turn/end' }])).toMatchObject({ step_count: 0, total_tokens: 0, unaccounted_steps: 0 })
  })
})
