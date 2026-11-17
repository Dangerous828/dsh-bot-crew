import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { phoneHandler } from '../src/app/mobile-http.ts'
import { Diagnostics } from '../src/app/diagnostics.ts'
import { Store } from '../src/app/store.ts'
import type { HttpHost } from '../src/app/http.ts'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

/** 假宿主 + 真实 tmp sqlite 的 Diagnostics（隔离库，不碰生产 state 路径）。 */
function harness(rate = { limit: 30, windowMs: 60_000 }) {
  const stateDir = mkdtempSync(join(tmpdir(), 'diag-api-')); directories.push(stateDir)
  const store = new Store(join(stateDir, 'orchestrator.sqlite'))
  const box = new Diagnostics(store, { rateLimit: rate.limit, rateWindowMs: rate.windowMs })
  const runtime = { ready: Promise.resolve(), machine: { stateDir }, diagnostics: box,
    store: { settings: () => ({ paused: false }), tickets: { list: () => [] }, get: store.get.bind(store), set: store.set.bind(store), delete: store.delete.bind(store), keys: store.keys.bind(store) },
    health: { runtime: { state: 'ready' } } } as unknown as HttpHost
  return { runtime, box, store, stateDir }
}
const send = (runtime: HttpHost, body: unknown, headers: Record<string, string> = { 'x-crew-principal': 'dev-1' }) =>
  phoneHandler(runtime)(new Request('http://dsh/api/mobile/diagnostics', { method: 'POST', headers, body: JSON.stringify(body) }))
const get = (runtime: HttpHost, qs = '', headers: Record<string, string> = { 'x-crew-principal': 'dev-1' }) =>
  phoneHandler(runtime)(new Request(`http://dsh/api/mobile/diagnostics${qs}`, { headers }))
const evt = (over: Record<string, unknown> = {}) => ({ id: 'r1', at: '2026-11-15T10:00:00.000Z',
  event: 'http_error', route: '/api/mobile/timeline', method: 'GET', status: 502, ms: 1800, err: 'CrewUnavailable', session: 'main', ...over })

describe('POST /api/mobile/diagnostics', () => {
  it('ACKs accepted ids with application/json and ok:true after durable store', async () => {
    const h = harness()
    const res = await send(h.runtime, { app: 'BotCrew', build: '0.1.0(1)', batch: [evt({ id: 'a' }), evt({ id: 'b' })] })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = await res.json() as { ok: boolean; acceptedIds: string[] }
    expect(body).toMatchObject({ ok: true })
    expect(body.acceptedIds).toEqual(['a', 'b'])
    // durable：直接查 store 底层有这一段。
    expect(h.box.list({ device: 'dev-1' }).rows.length).toBe(2)
  })

  it('is idempotent by id: re-post ACKs the same ids but stores once', async () => {
    const h = harness()
    const payload = { app: 'BotCrew', build: 'b', batch: [evt({ id: 'dup' })] }
    const first = await (await send(h.runtime, payload)).json() as { acceptedIds: string[] }
    const second = await (await send(h.runtime, payload)).json() as { acceptedIds: string[] }
    expect(first.acceptedIds).toEqual(['dup'])
    expect(second.acceptedIds).toEqual(['dup'])
    expect(h.box.list({ device: 'dev-1' }).rows.filter(r => r.id === 'dup').length).toBe(1)
  })

  it('refuses a request with no verified principal (401), even though the route exists', async () => {
    const h = harness()
    const res = await send(h.runtime, { app: 'BotCrew', batch: [] }, {})
    expect(res.status).toBe(401)
  })

  it('all-bad batch is a 4xx with reasonCodes, not a silent 200', async () => {
    const h = harness()
    const res = await send(h.runtime, { app: 'BotCrew', batch: [{ nope: true }] })
    expect(res.status).toBe(400)
    const body = await res.json() as { ok?: boolean; reasonCodes?: string[] }
    expect(body.ok).toBeUndefined()
    expect(body.reasonCodes).toBeDefined()
  })

  it('empty batch[] is a 400, not an empty ACK', async () => {
    const h = harness()
    const res = await send(h.runtime, { app: 'BotCrew', build: 'b', batch: [] })
    expect(res.status).toBe(400)
  })

  it('persists batch-level build onto GET rows (client only sends build at batch level)', async () => {
    const h = harness()
    await send(h.runtime, { app: 'BotCrew', build: '0.9.9(99)', batch: [evt({ id: 'x' })] })
    const body = await (await get(h.runtime)).json() as { rows: Array<{ id: string; device: string; build: string; app: string }> }
    expect(body.rows[0]).toMatchObject({ id: 'x', device: 'dev-1', build: '0.9.9(99)', app: 'BotCrew' })
  })

  it('rejects an oversized batch body (413)', async () => {
    const h = harness()
    const big = 'x'.repeat(70 * 1024)
    const res = await phoneHandler(h.runtime)(new Request('http://dsh/api/mobile/diagnostics', {
      method: 'POST', headers: { 'x-crew-principal': 'dev-1' }, body: JSON.stringify({ app: 'BotCrew', batch: [{ id: 'a', at: '2026-11-15T10:00:00Z', event: 'e', route: '/x', pad: big }] }) }))
    expect(res.status).toBe(413)
  })

  it('rate-limits a device and returns Retry-After header (429)', async () => {
    const h = harness({ limit: 1, windowMs: 60_000 })
    await send(h.runtime, { app: 'BotCrew', batch: [evt({ id: 'a' })] })
    const res = await send(h.runtime, { app: 'BotCrew', batch: [evt({ id: 'b' })] })
    expect(res.status).toBe(429)
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0)
  })

  it('GET only returns the calling device\'s own rows, never another device', async () => {
    const h = harness()
    await send(h.runtime, { app: 'BotCrew', batch: [evt({ id: 'mine' })] }, { 'x-crew-principal': 'dev-1' })
    await send(h.runtime, { app: 'BotCrew', batch: [evt({ id: 'other' })] }, { 'x-crew-principal': 'dev-2' })
    const res = await get(h.runtime, '', { 'x-crew-principal': 'dev-1' })
    const body = await res.json() as { device: string; rows: Array<{ id: string }> }
    expect(body.device).toBe('dev-1')
    expect(body.rows.map(r => r.id)).toEqual(['mine'])
  })

  it('GET errorsOnly filters to error rows', async () => {
    const h = harness()
    await send(h.runtime, { app: 'BotCrew', batch: [evt({ id: 'plain', event: 'screen_open', status: 200, err: undefined }), evt({ id: 'bad', status: 500 })] })
    const body = await (await get(h.runtime, '?errorsOnly=1')).json() as { rows: Array<{ id: string }> }
    expect(body.rows.map(r => r.id)).toEqual(['bad'])
  })

  it('survives a store reopen with the same tmp db file (durable)', async () => {
    const h = harness()
    await send(h.runtime, { app: 'BotCrew', batch: [evt({ id: 'keep' })] })
    h.store.close()
    const reopened = new Diagnostics(new Store(join(h.stateDir, 'orchestrator.sqlite')))
    expect(reopened.list({ device: 'dev-1' }).rows.map(r => r.id)).toEqual(['keep'])
  })
})
