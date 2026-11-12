import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { phoneHandler, unreadRepliesOf } from '../src/app/mobile-http.ts'
import type { HttpHost } from '../src/app/http.ts'
import { phoneGate } from '../src/app/phone-gate.ts'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

/** 假宿主只给这条路由会碰到的能力：`store.set` 记水位、`store.get` 读水位。 */
function readHost(options: { set?: (key: string, value: unknown) => void; get?: (key: string) => unknown } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'phone-read-')); directories.push(stateDir)
  writeFileSync(join(stateDir, 'mobilegw.token'), 'server-only-test-token')
  return { ready: Promise.resolve(), machine: { stateDir },
    health: { runtime: { state: 'ready' }, mobile: { state: 'ready' } },
    store: { settings: () => ({ paused: false }), tickets: { list: () => [] },
      ...(options.set ? { set: options.set } : {}), ...(options.get ? { get: options.get } : {}) } } as unknown as HttpHost
}

const post = (body?: string) => new Request('http://dsh/api/mobile/read', { method: 'POST', body })

// 契约 §5.6 原来缺的那个输入：客户端把自己读到的最后一条回话报上来。
// 这条路由只记水位，不碰时间线内容；成功与参数缺失各钉住一种结果。
it('records the reply the owner has read, and refuses a body without it', async () => {
  const writes: [string, unknown][] = []
  const set = vi.fn((key: string, value: unknown) => { writes.push([key, value]) })
  const handler = phoneHandler(readHost({ set }), undefined, vi.fn() as unknown as typeof fetch)

  const done = await handler(post(JSON.stringify({ last_read_id: 'r7' })))
  expect(done.status).toBe(200)
  expect(await done.json()).toEqual({ ok: true, last_read_id: 'r7' })
  expect(set).toHaveBeenCalledTimes(1)
  expect(writes[0]?.[0]).toContain('mobile-read')
  expect(writes[0]?.[1]).toBe('r7')

  // 缺字段、空串、类型不对、不是 JSON 对象、畸形 JSON、超限：一律 400/413，且绝不写水位。
  for (const body of [undefined, '{}', '{"last_read_id":""}', '{"last_read_id":42}', 'null', '[]', '{']) {
    expect((await handler(post(body))).status).toBe(400)
  }
  expect((await handler(post(' '.repeat(8193)))).status).toBe(413)
  expect(set).toHaveBeenCalledTimes(1)
})

it('says the host cannot hold a read cursor instead of claiming success', async () => {
  const handler = phoneHandler(readHost(), undefined, vi.fn() as unknown as typeof fetch)
  const failed = await handler(post('{"last_read_id":"r7"}'))
  expect(failed.status).toBe(503)
  expect(await failed.json()).toEqual({ error: '这个后端记不下已读位置' })
})

it('keeps the existing device credential gate on the read route', async () => {
  const set = vi.fn()
  const handler = phoneHandler(readHost({ set }))
  const devices = { allows: (id: string, token: string) => id === 'phone-1' && token === 'paired-token' }
  const dispatch = (headers: Record<string, string | undefined>) => phoneGate({ pathname: '/api/mobile/read', method: 'POST', headers, devices })
    ?? handler(post('{"last_read_id":"r7"}'))
  for (const headers of [{}, { 'x-crew-device': 'phone-1', 'x-crew-credential': 'wrong' }]) {
    expect((await dispatch(headers)).status).toBe(401)
  }
  expect(set).not.toHaveBeenCalled()
  expect((await dispatch({ 'x-crew-device': 'phone-1', 'x-crew-credential': 'paired-token' })).status).toBe(200)
  expect(set).toHaveBeenCalledTimes(1)
})

// 「未读回话」与 §5.6 的 `unread` 是方向相反的两个数，谁也不冒充谁。
// 沿用同一套三态口径：算不出来是 unknown，不冒充 0；按列表顺序判，不按时间比。
it('counts the replies after the reported cursor, and calls an unknown cursor unknown', () => {
  const items = [
    { id: 'm1', role: 'user', at: '2026-11-11T10:00:00+0800' },
    { id: 'r1', role: 'agent', at: '2026-11-11T10:01:00+0800' },
    { id: 'm2', role: 'user', at: '2026-11-11T10:02:00+0800' },
    { id: 'r2', role: 'agent', at: '2026-11-11T10:03:00+0800' },
  ]
  expect(unreadRepliesOf(items, 'r1')).toEqual({ count: 1, state: 'live' })
  // 报到最后一条：确实是 0 条，不是「算不出来」。
  expect(unreadRepliesOf(items, 'r2')).toEqual({ count: 0, state: 'live' })
  // 没报过 / 水位对不上：不画徽标，也不把「读不出来」说成 0。
  expect(unreadRepliesOf(items, undefined).state).toBe('unknown')
  expect(unreadRepliesOf(items, undefined).count).toBeNull()
  expect(unreadRepliesOf(items, 'gone').state).toBe('unknown')
})

it('hands the new count to the phone on the same timeline read', async () => {
  const upstream = vi.fn(async () => Response.json({ items: [
    { id: 'm1', role: 'user', text: '在吗', at: '2026-11-11T10:00:00+0800', read_at: '' },
    { id: 'r1', role: 'agent', text: '在', at: '2026-11-11T10:01:00+0800' },
    { id: 'r2', role: 'agent', text: '看完了', at: '2026-11-11T10:02:00+0800' },
  ] }))
  const get = vi.fn((key: string) => key.includes('mobile-read') ? 'r1' : undefined)
  const body = await (await phoneHandler(readHost({ get }), undefined, upstream as typeof fetch)(
    new Request('http://dsh/api/mobile/timeline'))).json() as { unread?: { count: number | null }; unread_replies?: { count: number | null; state: string } }
  // 原来的 `unread` 一格不改：仍数「人发出去没被读走」。
  expect(body.unread).toEqual({ count: 1, state: 'live' })
  expect(body.unread_replies).toEqual({ count: 1, state: 'live' })
})
