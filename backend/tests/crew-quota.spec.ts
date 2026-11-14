import { describe, expect, it } from 'vitest'
import { CONTEXT_WARN_RATIO, QuotaSourceReader, compact, parseQuotaSource, quotaOf, quotaSourceLine, quotaWarning, readQuotaSource,
  replyLine, replySpendOf } from '../src/app/quota.ts'

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

  it('counts the whole prompt — input plus cache traffic — against the window', () => {
    // 输出是这一步新写的，不占「已用」；但**缓存读/写是真进了模型的**，必须算。
    // 本部署的 workbuddy / trae-cn 把绝大部分提示词记在 cacheReadTokens 里，
    // 只减 inputTokens 会报出「还剩 49.9 万」，比实际宽得多（真数据见 runtime.spec 那条）。
    const spend = replySpendOf({ provider: 'p', model: 'm',
      usage: { inputTokens: 1_000, outputTokens: 90_000, cacheReadTokens: 48_000 }, contextWindow: 50_000 })
    expect(spend.prompt_tokens).toBe(49_000)
    expect(spend.context_left).toBe(1_000)
  })

  it('says "no cache this step" with 0, and "provider said nothing" by omitting the field', () => {
    const zero = replySpendOf({ usage: { inputTokens: 10, cacheReadTokens: 0 } })
    expect(zero.cache_read_tokens).toBe(0)
    const silent = replySpendOf({ usage: { inputTokens: 10 } })
    expect(silent).not.toHaveProperty('cache_read_tokens')
    expect(silent).not.toHaveProperty('cache_write_tokens')
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

describe('parseQuotaSource', () => {
  // 形状照抄 magpie `GET /v1/magpie/quotas` 的真响应（2026-11-14 实测）。
  const real = {
    data: [
      { provider: 'workbuddy', name: 'WorkBuddy', kind: 'subscription', plan: 'Free plan', user: '159****8010', windows: [
        { name: 'Credits', used: 100, remaining: 0, display: '500 / 500', unit: 'credits', amount: 500, limit: 500 },
        { name: 'Extra credits', used: 75.21987638954685, remaining: 24.780123610453145, display: '2921.54 / 3884', unit: 'credits' },
      ] },
      { provider: 'codex', kind: 'subscription', plan: 'plus', user: 'nzxabc@gmail.com', windows: [
        { name: '5 hours', used: 0, remaining: 100, resetsAt: '2026-11-14T14:00:54+08:00' },
      ] },
      { provider: 'linksub-fun', kind: 'balance', user: 'sk-J…UOVL', windows: [], balance: '$-3.51' },
      { provider: 'kimi-work', kind: 'subscription', windows: [], error: 'Kimi 网页登录已过期，打开一次 Kimi 桌面版即可刷新额度' },
    ],
  }

  it('reads every window as the source wrote it, display string included', () => {
    const windows = parseQuotaSource(real)
    expect(windows).toContainEqual({ provider: 'workbuddy', account: '159****8010', plan: 'Free plan', window: 'Credits',
      used: 100, remaining: 0, display: '500 / 500', unit: 'credits' })
    expect(windows).toContainEqual(expect.objectContaining({ provider: 'codex', window: '5 hours', remaining: 100,
      resets_at: '2026-11-14T14:00:54+08:00' }))
  })

  it('keeps a balance and an unreadable source as their own rows', () => {
    const windows = parseQuotaSource(real)
    expect(windows).toContainEqual({ provider: 'linksub-fun', account: 'sk-J…UOVL', window: 'balance', balance: '$-3.51' })
    // 源自己说读不到：原话带出来，不改成「未知」。
    expect(windows.find(window => window.provider === 'kimi-work')).toMatchObject({ window: 'unreadable',
      note: expect.stringContaining('登录已过期') })
  })

  it('answers nothing for a shape it does not know, instead of inventing rows', () => {
    expect(parseQuotaSource(null)).toEqual([])
    expect(parseQuotaSource({ data: 'nope' })).toEqual([])
    expect(parseQuotaSource({ data: [{ windows: [{ name: 'x' }] }] })).toEqual([])
  })

  it('skips one unreadable entry without dropping the rest', () => {
    expect(parseQuotaSource({ data: [null, 'x', { provider: 'p', windows: [{ name: 'w', remaining: 5 }] }] }))
      .toEqual([{ provider: 'p', window: 'w', remaining: 5 }])
  })
})

describe('readQuotaSource', () => {
  const ok = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch

  it('says why it could not read, rather than returning an empty list as if there were no quota', async () => {
    const missing = await readQuotaSource(undefined)
    expect(missing).toMatchObject({ state: 'unavailable', windows: [] })
    expect(missing.reason).toContain('没有配置真实额度源')
    const refused = await readQuotaSource('http://127.0.0.1:1/x', { fetch: (async () => new Response('no', { status: 503 })) as unknown as typeof fetch })
    expect(refused).toMatchObject({ state: 'unavailable', windows: [] })
    expect(refused.reason).toContain('503')
    const threw = await readQuotaSource('http://127.0.0.1:1/x', { fetch: (async () => { throw new Error('connect ECONNREFUSED') }) as unknown as typeof fetch })
    expect(threw.reason).toContain('ECONNREFUSED')
  })

  it('reports a read with its time and address, so the panel can be checked against the source', async () => {
    const reading = await readQuotaSource('http://gw/v1/magpie/quotas', { fetch: ok({ data: [
      { provider: 'workbuddy', windows: [{ name: 'Credits', remaining: 0, display: '500 / 500' }] }] }),
    now: () => '2026-11-14T11:20:00.000Z' })
    expect(reading).toMatchObject({ state: 'read', url: 'http://gw/v1/magpie/quotas', at: '2026-11-14T11:20:00.000Z' })
    expect(reading.windows).toHaveLength(1)
  })

  it('does not call an empty answer a successful read', async () => {
    const reading = await readQuotaSource('http://gw', { fetch: ok({ data: [] }) })
    expect(reading).toMatchObject({ state: 'unavailable', reason: '真实额度源回了空列表' })
  })
})

describe('quotaSourceLine', () => {
  it('names the tightest window per provider and keeps the source\'s own display string', () => {
    const line = quotaSourceLine({ state: 'read', windows: [
      { provider: 'workbuddy', window: 'Extra credits', remaining: 24.78, display: '2921.54 / 3884', account: '159****8010' },
      { provider: 'workbuddy', window: 'Credits', remaining: 0, display: '500 / 500', account: '159****8010' },
      { provider: 'trae-cn', window: 'Credits', remaining: 9.19 },
    ] })
    expect(line).toContain('workbuddy 剩 0%（500 / 500）')
    expect(line).toContain('trae-cn 剩 9%')
  })

  it('says "cannot read" with the reason, never a made-up percentage', () => {
    expect(quotaSourceLine({ state: 'unavailable', windows: [], reason: '真实额度源回了 HTTP 502' }))
      .toBe('额度：读不到真实源（真实额度源回了 HTTP 502）')
  })

  it('carries a balance and an unreadable row through to the line', () => {
    const line = quotaSourceLine({ state: 'read', windows: [
      { provider: 'linksub-fun', window: 'balance', balance: '$-3.51' },
      { provider: 'kimi-work', window: 'unreadable', note: 'Kimi 网页登录已过期' },
    ] })
    expect(line).toContain('linksub-fun 余额 $-3.51')
    expect(line).toContain('kimi-work：Kimi 网页登录已过期')
  })

  it('puts the ticket\'s own route first and says it is that one', () => {
    const reading = { state: 'read' as const, windows: [
      { provider: 'workbuddy', window: 'Credits', remaining: 0, display: '500 / 500' },
      { provider: 'trae-cn', window: 'Credits', remaining: 9.19 },
    ] }
    // 本票走 trae-cn：它排最前，哪怕 workbuddy 更紧 —— 一张票最该看的是它自己那条路由。
    const line = quotaSourceLine(reading, { route: 'magpie/trae-cn/deepseek-v4.1-flash-max' })
    expect(line.indexOf('trae-cn')).toBeLessThan(line.indexOf('workbuddy'))
    expect(line).toContain('trae-cn 剩 9%（本票）')
    // 没有本票路由时按剩余升序，最紧的在前。
    expect(quotaSourceLine(reading).indexOf('workbuddy')).toBeLessThan(quotaSourceLine(reading).indexOf('trae-cn'))
  })

  it('marks nothing when the route has no provider segment to match', () => {
    // `magpie/k3` 只有两段：网关后面没有 provider 段，拿模型名猜一个只会猜错。
    const line = quotaSourceLine({ state: 'read', windows: [{ provider: 'workbuddy', window: 'Credits', remaining: 0 }] },
      { route: 'magpie/k3' })
    expect(line).not.toContain('本票')
  })
})

describe('QuotaSourceReader', () => {
  const counting = () => {
    let calls = 0
    const fetch: typeof globalThis.fetch = async () => { calls += 1; return new Response(JSON.stringify({ data: [
      { provider: 'workbuddy', windows: [{ name: 'Credits', remaining: 0 }] }] }), { status: 200 }) }
    return { fetch, calls: () => calls }
  }

  it('serves a cached reading inside its lifetime, so a phone refresh does not re-query the provider', async () => {
    const counter = counting()
    let clock = 0
    const reader = new QuotaSourceReader(() => 'http://gw', { fetch: counter.fetch, ttlMs: 1_000, clock: () => clock })
    expect((await reader.read()).state).toBe('read')
    clock = 999
    await reader.read()
    expect(counter.calls()).toBe(1)
    clock = 1_001
    await reader.read()
    expect(counter.calls()).toBe(2)
  })

  it('runs one query for concurrent callers', async () => {
    const counter = counting()
    const reader = new QuotaSourceReader(() => 'http://gw', { fetch: counter.fetch })
    await Promise.all([reader.read(), reader.read(), reader.read()])
    expect(counter.calls()).toBe(1)
  })

  it('retries a failure sooner than a success, and still answers rather than throwing', async () => {
    let calls = 0
    const fetch: typeof globalThis.fetch = async () => { calls += 1; return new Response('no', { status: 502 }) }
    let clock = 0
    const reader = new QuotaSourceReader(() => 'http://gw', { fetch, ttlMs: 60_000, failureTtlMs: 5_000, clock: () => clock })
    expect((await reader.read()).state).toBe('unavailable')
    clock = 4_000
    expect((await reader.read()).state).toBe('unavailable')
    expect(calls).toBe(1)
    clock = 5_001
    await reader.read()
    expect(calls).toBe(2)
  })
})
