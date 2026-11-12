import { expect, it, vi } from 'vitest'
import { Config, type Machine } from '../src/deployment.ts'
import { apply } from '../src/index.ts'
import { lanPort } from '../src/app/lan-server.ts'

// Stub Runtime to capture the resolved Machine settings and restart callback.
const runtimes = vi.hoisted(() => [] as { machine: Machine; restart: () => void; health: Map<string, unknown>; pusher?: (message: Record<string, unknown>) => boolean }[])
vi.mock('../src/app/runtime.ts', () => ({ Runtime: class {
  ready = Promise.resolve()
  /** 健康项只记账：index.ts 给 P2P 那条路 claim 一个，用例从 runtimes 里读它。 */
  readonly health = new Map<string, unknown>()
  constructor(_ctx: unknown, readonly machine: Machine, readonly restart: () => void) { runtimes.push(this) }
  claimHealth(name: string, initial?: unknown) {
    this.health.set(name, initial)
    return { get: () => this.health.get(name), set: (health: unknown) => { this.health.set(name, health) }, release: () => { this.health.delete(name) } }
  }
  configured() { return true }
  /** 通知经隧道发出去的那只手；index.ts 在隧道建好后注入，用例从这里读注入了没有。 */
  pusher?: (message: Record<string, unknown>) => boolean
  attachPusher(pusher?: (message: Record<string, unknown>) => boolean) { this.pusher = pusher }
  async stop() {}
} }))
/** Simulate the Cordis loader updating a volatile configuration reference in place. */
const commit = (reference: unknown, value: unknown) => { (reference as Record<symbol, (value: unknown) => void>)[Symbol.for('cosmokit.volatile.write')]!(value) }

function context() {
  const handlers = new Map<string, () => void>()
  const configure = vi.fn(() => () => {})
  const describe = vi.fn(() => [])
  const ctx = {
    on: vi.fn((name: string, handler: () => void) => { handlers.set(name, handler) }),
    inject: vi.fn((services: string[], callback: (child: unknown) => void) => {
      // Optional Connection is absent in this settings-only fixture.
      if (services.includes('connection')) return
      callback({ effect: (effect: () => unknown) => effect(), settings: { configure } })
    }),
    effect: vi.fn(),
    fiber: { restart: vi.fn(async () => {}) },
    get: vi.fn((name: string) => name === 'settings' ? { describe } : undefined),
    // warn 也要有：apply 会在局域网监听失败时 warn 一句，少了它就是一条未处理的 rejection。
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
  }
  return { ctx, handlers, configure, describe }
}

it('reads a limit DSH commits a new value of without a restart, and asks DSH to generate no settings page', async () => {
  const { ctx, handlers, configure } = context()
  const config = Config({ stateDir: '/srv/state', promptMaxChars: 5000 })
  await apply(ctx as never, config)
  expect(configure).toHaveBeenCalledExactlyOnceWith({ auto: false }, ctx.fiber)
  const { machine } = runtimes.at(-1)!
  expect(machine.promptMaxChars.get()).toBe(5000)
  commit(config.promptMaxChars, 8000)
  expect(machine.promptMaxChars.get()).toBe(8000)
  expect(handlers.has('loader/volatile-update')).toBe(false)
  expect(ctx.fiber.restart).not.toHaveBeenCalled()
})

it('asks DSH to read its settings entry again once a restart it started finished', async () => {
  const { ctx, describe } = context()
  let finish = () => {}
  ctx.fiber.restart.mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
  await apply(ctx as never, Config({ stateDir: '/srv/state' }))
  // Saving a Source account change restarts dsh-superagent, which re-runs setup and refreshes the settings descriptor.
  runtimes.at(-1)!.restart()
  await Promise.resolve()
  expect(describe).not.toHaveBeenCalled()
  finish()
  await vi.waitFor(() => { expect(describe).toHaveBeenCalledTimes(1) })
})

it('refuses keys of the previous configuration before registering anything', async () => {
  const { ctx } = context()
  await expect(apply(ctx as never, Config({ stateDir: '/srv/state', github: { cli: 'gh' } } as never))).rejects.toThrow('github (now on the GitHub Source)')
  expect(ctx.on).not.toHaveBeenCalled()
  expect(ctx.inject).not.toHaveBeenCalled()
})

// ── 出门那条路（中转隧道）────────────────────────────────────────────
// 这些用例只验证「接上了没有」：隧道本身的行为在 tests/tunnel.spec.ts 里测。
// 这里要钉住的是「不配中转就什么都不起」与「配了就要能被停掉」——
// 少一条就是端口/连接泄漏，多一条就是没配也往外连。

/** 把隧道模块换成一个只记账的替身：真的去连一个不存在的中转会让测试等重连。 */
const tunnels = vi.hoisted(() => [] as { options: Record<string, unknown>; closed: boolean; started: boolean; pushed?: Record<string, unknown>[] }[])
vi.mock('../src/app/tunnel.ts', () => ({
  createTunnel: (options: Record<string, unknown>) => {
    const entry: { options: Record<string, unknown>; closed: boolean; started: boolean; pushed?: Record<string, unknown>[] } = { options, closed: false, started: false }
    tunnels.push(entry)
    return {
      start: async () => { entry.started = true },
      close: async () => { entry.closed = true },
      state: () => (entry.closed ? 'closed' : 'live'),
      relayUrl: () => String(options.relayUrl ?? ''),
      // 通知经这条隧道发出去：记下来，测试要钉的是「接线接上了没有」，不是中转怎么处理。
      push: (message: Record<string, unknown>) => { (entry.pushed ??= []).push(message); return !entry.closed },
    }
  },
}))
// relay-chain 有真实实现，这里不 mock：配置解析本身就是接线的一部分。

// P2P 那条路同理换成替身：真跑 `tools/tailcat serve` 会开一条真 WireGuard 隧道、在 HOME 下建密钥，
// 而这里要钉的只是「起来了没有、停得掉没有」。解析地址的纯函数仍用真实现。
const p2ps = vi.hoisted(() => [] as { options: Record<string, unknown>; started: boolean; stopped: boolean }[])
vi.mock('../src/app/p2p.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/app/p2p.ts')>()
  return {
    ...actual,
    createP2p: (options: Record<string, unknown>) => {
      const entry = { options, started: false, stopped: false }
      p2ps.push(entry)
      return { start: () => { entry.started = true }, stop: async () => { entry.stopped = true }, addr: () => undefined }
    },
  }
})

/** 用一份指定的环境跑一次 apply，并收集 ctx.effect 注册的清理函数。 */
async function withEnv(environment: Record<string, string | undefined>, body: (cleanup: (() => Promise<void>)[], logged: string[]) => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {}
  for (const key of Object.keys(environment)) { saved[key] = process.env[key]; if (environment[key] === undefined) delete process.env[key]; else process.env[key] = environment[key] }
  try {
    const cleanups: (() => Promise<void>)[] = []
    const logged: string[] = []
    const ctx = {
      on: vi.fn(), inject: vi.fn(), fiber: { restart: vi.fn(async () => {}) }, get: vi.fn(() => undefined),
      effect: vi.fn((factory: () => () => Promise<void>) => { cleanups.push(factory()) }),
      // 像真 logger 一样把 %s/%d 换掉：不替换的话，断言只会看到字面量，等于没测到内容。
      logger: { info: (line: string, ...rest: unknown[]) => {
        let next = 0
        logged.push(line.replace(/%[sd]/g, () => String(rest[next++])) + (next < rest.length ? ` ${rest.slice(next).join(' ')}` : ''))
      }, error: vi.fn(), warn: vi.fn() },
      // 局域网那条路会绑真端口；这两条用例不关心它。
    }
    await apply(ctx as never, Config({ stateDir: '/srv/state' }))
    await body(cleanups, logged)
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  }
}

it('does not dial out when no relay is configured', async () => {
  tunnels.length = 0
  await withEnv({ CREW_RELAY_URLS: undefined }, async (_cleanups, logged) => {
    expect(tunnels).toHaveLength(0)
    expect(logged.join('\n')).toMatch(/only reach this machine on the LAN/)
  })
})

// P2P 那条路是手机跨网络的直连，不经过中转：它无条件起，与 CREW_RELAY_URLS 无关。
// 这里钉住的是「端口就是手机要走的那条监听」以及「插件停的时候跟着停」。
it('starts the direct tunnel on the phone listener port, and stops it with the plugin', async () => {
  p2ps.length = 0
  await withEnv({ CREW_RELAY_URLS: undefined }, async cleanups => {
    expect(p2ps).toHaveLength(1)
    expect(p2ps[0]!.started).toBe(true)
    // 端口取自状态目录，和局域网监听同一个：手机在那条路上连的就是这套消息面。
    expect(p2ps[0]!.options).toMatchObject({ port: lanPort('/srv/state') })
    expect(String(p2ps[0]!.options.binary)).toMatch(/tools\/tailcat$/)
    // 二进制不在只会让这条通道报错，别的照旧 —— 所以健康项一开始就是 starting 而不是 ready。
    expect(runtimes.at(-1)!.health.get('p2p')).toMatchObject({ state: 'starting' })
    for (const cleanup of cleanups) await cleanup()
    expect(p2ps[0]!.stopped).toBe(true)
  })
})

it('starts a tunnel and closes it when the plugin stops', async () => {
  tunnels.length = 0
  await withEnv({ CREW_RELAY_URLS: 'wss://relay.example/tunnel', CREW_RELAY_SECRET: 's', CREW_RELAY_INSTANCE: 'my-box' }, async (cleanups, logged) => {
    expect(tunnels).toHaveLength(1)
    expect(tunnels[0]!.options).toMatchObject({ relayUrl: ['wss://relay.example/tunnel'], instanceId: 'my-box', registerSecret: 's' })
    expect(tunnels[0]!.started).toBe(true)
    // 清理必须真的把它关掉，否则插件重载会留下一条没人管的隧道。
    for (const cleanup of cleanups) await cleanup()
    expect(tunnels[0]!.closed).toBe(true)
    expect(logged.join('\n')).not.toMatch(/fallbacks/)
  })
})

it('derives a stable instance id from the state directory when none is given', async () => {
  // 换成随机 id 的话，每次重启手机就要重新找路 —— 那正是这套隧道要解决的问题。
  const { instanceIdFor } = await import('../src/index.ts')
  expect(instanceIdFor('/srv/state')).toBe(instanceIdFor('/srv/state'))
  expect(instanceIdFor('/srv/state')).not.toBe(instanceIdFor('/srv/other'))
  expect(instanceIdFor('/srv/state')).toMatch(/^crew-[0-9a-f]{16}$/)
})

it('hands every configured relay to the tunnel, primary first', async () => {
  // 兜底只有真的交给了隧道才算数：只交出第一条的话，配了就等于没配。
  tunnels.length = 0
  await withEnv({ CREW_RELAY_URLS: 'wss://a.example/tunnel,wss://b.example/tunnel,wss://c.example/tunnel' }, async (_cleanups, logged) => {
    expect(tunnels).toHaveLength(1)
    // 顺序必须保持：第一条是自建，换顺序等于把兜底放到前面。
    expect(tunnels[0]!.options.relayUrl).toEqual(['wss://a.example/tunnel', 'wss://b.example/tunnel', 'wss://c.example/tunnel'])
    expect(logged.join('\n')).toMatch(/fallbacks configured: 2/)
  })
})

it('routes notices through the relay tunnel once one is configured, and stops when it closes', async () => {
  // 推送那条链缺的就是这一环：Runtime 先构造、隧道后建，中间必须有人把两只手接起来。
  // 不接的话通知只会落本地留件 —— 手机在后台（隧道才是唯一的路）时永远收不到。
  tunnels.length = 0
  runtimes.length = 0
  await withEnv({ CREW_RELAY_URLS: 'wss://relay.example/tunnel' }, async () => {
    const runtime = runtimes[0]!
    expect(typeof runtime.pusher).toBe('function')
    // 注进来的那只手要真的走到隧道上，而不是一个自己造的对象。
    expect(runtime.pusher!({ deviceId: 'dev_abc123', title: 't', body: 'b' })).toBe(true)
    expect(tunnels[0]!.pushed).toEqual([{ deviceId: 'dev_abc123', title: 't', body: 'b' }])
  })
})

it('keeps the tunnel on the message surface after the path is normalised', async () => {
  // 中转发来的 path 由手机决定。前缀看起来对不代表真的对：
  // `/api/mobile/../../orchestrator/api/settings` 规范化之后是 `/orchestrator/api/settings`，
  // 而管理面就住在那儿。隧道必须判规范化之后的结果。
  tunnels.length = 0
  await withEnv({ CREW_RELAY_URLS: 'wss://relay.example/tunnel' }, async () => {
    const forward = tunnels[0]!.options.forward as (request: { method: string; url: string; headers: Record<string, string>; body: string }, signal: AbortSignal) => Promise<Response>
    for (const url of ['/api/mobile/../../orchestrator/api/settings', '/orchestrator/api/settings', '/api/tickets', '/']) {
      const answer = await forward({ method: 'GET', url, headers: {}, body: '' }, new AbortController().signal)
      expect(answer.status, url).toBe(404)
    }
  })
})
