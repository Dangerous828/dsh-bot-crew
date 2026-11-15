import { describe, expect, it, vi } from 'vitest'
import { makeHubRetraction } from '../src/memory/hub-retraction.ts'

const opts = (fetchImpl: any) => ({ base: () => 'https://hub.test/v1', token: () => 'T', timeoutMs: () => 5000, fetchImpl })

describe('makeHubRetraction.bySourceFile（按冻结协议 §4.1）', () => {
  it('search(live only, metadata_filter source_file) 再逐条 DELETE，返回 deleted/matched/ids', async () => {
    const calls: any[] = []
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      calls.push({ url, method: init.method, body: init.body, h: init.headers })
      if (url.endsWith('/memories/search')) return new Response(JSON.stringify([{ id: 'id1' }, { id: 'id2' }]), { status: 200 })
      return new Response(JSON.stringify({ deleted: true }), { status: 200 })
    })
    const r = await makeHubRetraction(opts(fetchImpl)).bySourceFile({ namespace: 'dsh-memory/bot', sourceFile: 'bot-lead-x.md' })
    expect(r).toMatchObject({ ok: true, deleted: 2, matched: 2 })
    expect(r.ids).toEqual(['id1', 'id2'])
    const search = calls[0]
    expect(search.url).toBe('https://hub.test/v1/memories/search')
    expect(JSON.parse(search.body)).toMatchObject({ namespace: 'dsh-memory/bot', include_deleted: false, metadata_filter: { source_file: 'bot-lead-x.md' } })
    expect(search.h['x-hub-token']).toBe('T')
    const dels = calls.filter(c => c.method === 'DELETE')
    expect(dels.map(d => d.url)).toEqual(['https://hub.test/v1/memories/id1?hard=false&reason=retract%3Abot-lead-x', 'https://hub.test/v1/memories/id2?hard=false&reason=retract%3Abot-lead-x'])
  })
  it('live 零行=成功 deleted:0（幂等零条无害），只 search 一次', async () => {
    const fetchImpl = vi.fn(async () => new Response('[]', { status: 200 }))
    const r = await makeHubRetraction(opts(fetchImpl)).bySourceFile({ namespace: 'dsh-memory/bot', sourceFile: 'none.md' })
    expect(r).toMatchObject({ ok: true, deleted: 0, matched: 0 }); expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
  it('DELETE 404 视为幂等（不计 deleted）', async () => {
    let n = 0
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/memories/search')) { n++; return new Response(JSON.stringify(n === 1 ? [{ id: 'id1' }] : []), { status: 200 }) }
      return new Response('', { status: 404 })
    })
    const r = await makeHubRetraction(opts(fetchImpl)).bySourceFile({ namespace: 'dsh-memory/bot', sourceFile: 'x.md' })
    expect(r.deleted).toBe(0); expect(r.matched).toBe(1)
  })
  it('keepDigest：保留新版本（dedupe_key==keepDigest 的行不删），只删旧行', async () => {
    const dels: string[] = []
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      if (url.endsWith('/memories/search')) return new Response(JSON.stringify([{ id: 'old1', dedupe_key: 'oldhex' }, { id: 'new1', dedupe_key: 'newhex' }]), { status: 200 })
      dels.push(url); return new Response('{}', { status: 200 })
    })
    const r = await makeHubRetraction(opts(fetchImpl)).bySourceFile({ namespace: 'dsh-memory/bot', sourceFile: 'x.md', keepDigest: 'newhex' })
    expect(dels.length).toBe(1); expect(dels[0]).toContain('/memories/old1?')
    expect(r.deleted).toBe(1)
  })
  it('search 5xx 抛错（供上层持久重试 + health 观察）', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 503 }))
    await expect(makeHubRetraction(opts(fetchImpl)).bySourceFile({ namespace: 'n', sourceFile: 'x.md' })).rejects.toThrow(/503/)
  })
  it('bounded：分批（>PAGE）不无限循环，最多 MAX_ROUNDS', async () => {
    // 每轮都返回 PAGE 行（模拟删不完的极端），验证有上界、不挂死。
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/memories/search')) return new Response(JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ id: `id${i}` }))), { status: 200 })
      return new Response('{}', { status: 200 })
    })
    const r = await makeHubRetraction(opts(fetchImpl)).bySourceFile({ namespace: 'n', sourceFile: 'x.md' })
    expect(r.ok).toBe(true)
    // 20 轮 ×100 = 2000 上界
    expect(r.deleted).toBeLessThanOrEqual(20 * 100)
  })
})

describe('makeHubRetraction.tombstoneByDigests（原子占位，不传正文）', () => {
  it('POST /memory/retract-tombstone，body 含 namespace/source_file/known_digests，解析响应', async () => {
    const calls: any[] = []
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      calls.push({ url, method: init.method, body: JSON.parse(init.body) })
      return new Response(JSON.stringify({ ok: true, mode: 'tombstone', placed: ['h1'], already_retracted: ['h2'], soft_deleted: [], conflicts: [] }), { status: 200 })
    })
    const r = await makeHubRetraction(opts(fetchImpl)).tombstoneByDigests!({ namespace: 'dsh-memory/bot', sourceFile: 'bot-lead-x.md', knownDigests: ['h1', 'h2'], reason: 'forget' })
    expect(r).toEqual({ ok: true, placed: ['h1'], alreadyRetracted: ['h2'], softDeleted: [], conflicts: [] })
    const c = calls[0]
    expect(c.url).toBe('https://hub.test/v1/memory/retract-tombstone')
    expect(c.body).toEqual({ namespace: 'dsh-memory/bot', source_file: 'bot-lead-x.md', known_digests: ['h1', 'h2'], reason: 'forget' })
  })
  it('409 conflicts → 抛错（可观察、不误删）', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ conflicts: ['h9'] }), { status: 409 }))
    await expect(makeHubRetraction(opts(fetchImpl)).tombstoneByDigests!({ namespace: 'n', sourceFile: 'x.md', knownDigests: ['h9'] })).rejects.toThrow(/conflicts/)
  })
  it('soft_deleted：canonical 匹配的 live 行被端点直接软删（撤回生效）', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, placed: [], already_retracted: [], soft_deleted: ['h3'], conflicts: [] }), { status: 200 }))
    const r = await makeHubRetraction(opts(fetchImpl)).tombstoneByDigests!({ namespace: 'n', sourceFile: 'x.md', knownDigests: ['h3'] })
    expect(r.softDeleted).toEqual(['h3'])
  })
})
