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
    { path: '/api/mobile/work', methods: ['GET'], requestBody: 'buffered' },
    { path: '/api/mobile/agents', methods: ['GET'], requestBody: 'buffered' },
    { path: '/api/mobile/models', methods: ['GET'], requestBody: 'buffered' },
    { path: '/api/mobile/model', methods: ['POST'], requestBody: 'buffered' },
    { path: '/api/mobile/pair', methods: ['POST'], requestBody: 'buffered' },
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

// 消息面的每一条都在 Connection 的 Fetch 上注册，鉴权由 Connection 在调用处理器之前完成。
// 插件自己再加一层凭据是没用的：请求根本到不了这里。
// 这条测试钉住「凭据由谁负责」，防止有人误以为能在插件侧绕过 Connection。
it('leaves authentication to Connection instead of inventing a second door', () => {
  const registered: string[] = []
  const ctx = {
    inject: (_deps: string[], run: (child: unknown) => void) => {
      run({
        get: () => ({ fetch: { register: (route: { path: string }) => { registered.push(route.path); return () => {} } } }),
        // 注册完要在 effect 里收尾；这里只要它存在，不需要真的跑。
        effect: () => () => {},
      })
    },
    logger: { warn: () => {} },
  }
  registerMobileHttp(ctx as never, host() as never)
  expect(registered.length).toBe(7)
  // 只注册到 Connection，不额外挂到原始 web 路由上。
  expect(registered.every(path => path.startsWith('/api/mobile/'))).toBe(true)
})

// 左栏「模型」那一项要能选：切之前先得知道有哪些。只回可用的 provider，
// 读不出来的那几家单独列出来，别让人以为它本来就没有模型。
it('lists the models a person can switch to, with the one in use and the providers that failed', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'phone-api-')); directories.push(stateDir)
  const models = vi.fn(async () => ({
    default: { provider: 'dsh', model: 'default' }, routableProviders: ['dsh'],
    groups: [{ id: 'dsh', name: 'DSH', models: [{ id: 'm1', name: 'Model One', description: 'fast' }] }],
    failures: [{ id: 'broken', name: 'Broken', message: 'secret endpoint 10.0.0.1' }],
  }))
  const handler = phoneHandler({ ready: Promise.resolve(), machine: { stateDir }, health: {},
    store: { settings: () => ({ paused: false, executor: { model: { provider: 'dsh', model: 'm1' } } }), tickets: { list: () => [] } },
    models } as unknown as HttpHost, 'http://127.0.0.1:8788', vi.fn() as unknown as typeof fetch)
  const result = await handler(new Request('http://dsh/api/mobile/models'))
  expect(result.status).toBe(200)
  const body = await result.json() as Record<string, unknown>
  expect(body).toMatchObject({ current: { provider: 'dsh', model: 'm1' },
    providers: [{ id: 'dsh', name: 'DSH', models: [{ id: 'm1', name: 'Model One', description: 'fast' }] }],
    failures: [{ id: 'broken', name: 'Broken' }] })
  // 失败原因里可能带内网地址和密钥，不往设备上送。
  expect(JSON.stringify(body)).not.toContain('10.0.0.1')
})
