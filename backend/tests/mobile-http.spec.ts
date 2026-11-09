import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { phoneHandler, registerMobileHttp } from '../src/app/mobile-http.ts'
import type { HttpHost } from '../src/app/http.ts'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
function host() {
  const stateDir = mkdtempSync(join(tmpdir(), 'phone-api-')); directories.push(stateDir)
  writeFileSync(join(stateDir, 'mobilegw.token'), 'server-only-test-token')
  return { ready: Promise.resolve(), machine: { stateDir }, health: { runtime: { state: 'ready' }, mobile: { state: 'ready' } },
    store: { settings: () => ({ paused: false }), tickets: { list: () => [] } } } as unknown as HttpHost
}
it('uses Connection authenticated exact routes, never raw public web routes', () => {
  const registered: unknown[] = [], dispose = vi.fn(async () => {})
  const child = { get: () => ({ fetch: { register: (route: unknown) => { registered.push(route); return dispose } } }), effect: vi.fn() }
  const ctx = { inject: (dependencies: string[], action: (scope: unknown) => void) => { expect(dependencies).toEqual(['connection']); action(child) } }
  registerMobileHttp(ctx as never, host())
  expect(registered).toMatchObject([
    { path: '/api/mobile/timeline', methods: ['GET'], requestBody: 'buffered' },
    { path: '/api/mobile/send', methods: ['POST'], requestBody: 'buffered' },
  ])
})
it('injects only the server credential and refuses malformed sends before enqueue', async () => {
  const upstream = vi.fn(async () => Response.json({ ok: true, id: 1 }))
  const handler = phoneHandler(host(), 'http://127.0.0.1:8788', upstream as typeof fetch)
  for (const value of [[], { text: 'ok' }, { text: 42, request_id: 'a' }]) {
    expect((await handler(new Request('http://dsh/api/mobile/send', { method: 'POST', body: JSON.stringify(value) }))).status).toBe(400)
  }
  expect(upstream).not.toHaveBeenCalled()
  const result = await handler(new Request('http://dsh/api/mobile/send', { method: 'POST',
    body: JSON.stringify({ text: 'hello', request_id: 'phone-1', sender: 'other', token: 'client-secret' }) }))
  expect(result.status).toBe(200)
  expect(upstream).toHaveBeenCalledWith('http://127.0.0.1:8788/send', expect.objectContaining({
    body: JSON.stringify({ text: 'hello', request_id: 'phone-1', mentions: [] }), headers: { 'X-GW-Token': 'server-only-test-token', 'Content-Type': 'application/json' },
  }))
})
it('shows actual runtime state and reports transport failures without secrets', async () => {
  const upstream = vi.fn(async () => Response.json({ items: [{ id: 'm1', text: 'hello' }] }))
  const handler = phoneHandler(host(), undefined, upstream as typeof fetch)
  const result = await handler(new Request('http://dsh/api/mobile/timeline'))
  expect(await result.json()).toMatchObject({ items: [{ id: 'm1' }], tasks: [], bots: [], default_bot_id: '',
    status: { runtime: 'ready', mobile: 'ready', paused: false } })
  upstream.mockRejectedValueOnce(new Error('private internal secret'))
  const failed = await handler(new Request('http://dsh/api/mobile/timeline'))
  expect(failed.status).toBe(502)
  expect(await failed.text()).not.toContain('private')
})
