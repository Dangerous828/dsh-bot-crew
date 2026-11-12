/** 中枢 HTTP 客户端：把契约 08 的两个接口按形状调通，坏响应降级而不毒化注入。 */
import { describe, expect, it, vi } from 'vitest'
import { consolidateResultOf, HubHttp, memoryEntriesOf } from '../src/memory/hub-client.ts'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('中枢 HTTP 客户端', () => {
  it('检索：按契约发 {query,bots,limit}，把 entries 读成条目', async () => {
    const calls: { url: string; body: unknown }[] = []
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) })
      return json({ entries: [{ name: 'bot-lead-a', body: '回复先给结论', type: 'feedback', dedupe_key: 'k' }] })
    }) as unknown as typeof fetch
    const hub = new HubHttp({ base: 'http://hub.local:8642/', fetchImpl })
    const entries = await hub.search({ query: '风格', bots: ['lead'], limit: 6 })
    expect(calls[0]!.url).toBe('http://hub.local:8642/memory/search')
    expect(calls[0]!.body).toEqual({ query: '风格', bots: ['lead'], limit: 6 })
    expect(entries.map(entry => entry.name)).toEqual(['bot-lead-a'])
  })

  it('检索失败：4xx/5xx 抛错，交给上层降级', async () => {
    const fetchImpl = vi.fn(async () => json({ error: 'nope' }, 502)) as unknown as typeof fetch
    await expect(new HubHttp({ base: 'http://h', fetchImpl }).search({ query: 'x' })).rejects.toThrow('502')
  })

  it('巩固：读三个计数；缺一个就返回 undefined', async () => {
    const ok = vi.fn(async () => json({ facts: 2, merged: 1, superseded: 0 })) as unknown as typeof fetch
    expect(await new HubHttp({ base: 'http://h', fetchImpl: ok }).consolidate({})).toEqual({ facts: 2, merged: 1, superseded: 0 })
    const partial = vi.fn(async () => json({ facts: 2 })) as unknown as typeof fetch
    expect(await new HubHttp({ base: 'http://h', fetchImpl: partial }).consolidate({})).toBeUndefined()
  })

  it('坏条目被丢掉：缺 name/body 的条目不进注入', () => {
    expect(memoryEntriesOf([{ name: 'a', body: 'b' }, { name: '', body: 'x' }, { name: 'c' }, 'garbage']).map(e => e.name)).toEqual(['a'])
    expect(memoryEntriesOf(null)).toEqual([])
  })

  it('计数只认非负整数', () => {
    expect(consolidateResultOf({ facts: -1, merged: 0, superseded: 0 })).toBeUndefined()
    expect(consolidateResultOf({ facts: 1.5, merged: 0, superseded: 0 })).toBeUndefined()
    expect(consolidateResultOf('nope')).toBeUndefined()
  })
})
