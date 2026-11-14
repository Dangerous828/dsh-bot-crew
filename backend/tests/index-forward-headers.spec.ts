/**
 * index.ts 里那条「把 x-crew-session 透传进重建的 Request」的线（三跳链路：入口 → ask 重建 → phoneHandler）。
 *
 * 为什么要有这一份：`ask()` 重建 Request 时原先丢掉全部 headers，于是 LAN（lan-server.ts）与
 * tunnel（tunnel.ts）两条入口传进来的 `x-crew-session` 都到不了 phoneHandler —— header 形态的
 * 会话会静默退回 main（C4 串线）。修复只有一行 `headers: sessionHeader(request.headers)`，
 * 而 `index.ts` 不在任何 agent 的分工表里、是集成时补的，最容易在后续重构里被顺手删掉。
 * 这一份测试的全部价值就是：那一行被删掉时，这里必须变红。
 *
 * 测法：`sessionHeader` 与 `ask` 都是 `apply()` 闭包内的私有函数，不能直接 import。
 * 所以用它们唯一的公开出口——两条入口的 `forward` 回调——把请求送进去，再从
 * `phoneHandler` 那一侧看它到底收到了什么。这条缝就是生产链路本身，不是替身内部结构：
 *   - `createLanServer` / `createTunnel` 换成只记账的替身，为的是拿到 `forward`（真监听会绑端口、
 *     真隧道会连中转，两者都跑在别人正在用的机器上）；
 *   - `phoneHandler` 用真实现包一层：包的那层只记下 `Request`，判 400 / 落 KV 仍由真处理器做。
 * 断言落在两个独立的事实上：`headers.get('x-crew-session')` 的原文，以及真处理器按会话分键写下的
 * KV 键（`mobile-read-cursor:work`，键名由 src/kv.ts 定义）——后者不经过任何被测代码的推断。
 */
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config } from '../src/deployment.ts'
import { apply } from '../src/index.ts'

// ── 记账的替身与真实的处理器 ────────────────────────────────────────────
// vi.mock 的工厂会被提到文件顶部，所以共享状态必须走 vi.hoisted。
const held = vi.hoisted(() => ({
  /** 到达 phoneHandler 的每一个 Request，按顺序。断言就看它们。 */
  seen: [] as Request[],
  /** 转发到网关的上游请求地址（真处理器只在转发类 operation 上用到）。 */
  upstream: [] as string[],
  /** 两条入口的 options：`forward` 在里头。 */
  lans: [] as { forward: (request: { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: Uint8Array<ArrayBuffer> }) => Promise<Response> }[],
  tunnels: [] as { options: { forward: (request: { method: string; url: string; headers: Record<string, string>; body: string }, signal: AbortSignal) => Promise<Response> }; closed: boolean }[],
  /** Runtime 替身实例：用例从它上面读 KV。 */
  runtimes: [] as { store: { get: (key: string) => unknown }; health: Map<string, unknown> }[],
}))

// Runtime 换成替身：真 Runtime 会开库、起执行器，这里要的只是 phoneHandler 依赖的那几项。
vi.mock('../src/app/runtime.ts', () => ({ Runtime: class {
  ready = Promise.resolve()
  readonly health = new Map<string, unknown>()
  readonly store: { get: (key: string) => unknown; set: (key: string, value: unknown) => void
    settings: () => Record<string, unknown>; tickets: { list: () => unknown[]; get: () => undefined }; keys: () => string[] }
  constructor(_ctx: unknown, readonly machine: { stateDir: string }, readonly restart: () => void) {
    // 一份内存 KV：真处理器写下的键在用例里读得到（会话分键的证据就落在这儿）。
    const kv = new Map<string, unknown>()
    this.store = {
      get: key => kv.get(key),
      set: (key, value) => { kv.set(key, value) },
      settings: () => ({ paused: false }),
      tickets: { list: () => [], get: () => undefined },
      keys: () => [],
    }
    held.runtimes.push(this)
  }
  claimHealth(name: string, initial?: unknown) {
    this.health.set(name, initial)
    return { get: () => this.health.get(name), set: (value: unknown) => { this.health.set(name, value) }, release: () => { this.health.delete(name) } }
  }
  configured() { return true }
  attachPusher() {}
  async stop() {}
} }))

// 真处理器 + 一层记录：包的那层只记 Request，会话判定、400、KV 写入全由真实现做。
// 网关换成本地假 fetch：本文件不测转发，只保证真处理器不会真的往外连。
vi.mock('../src/app/mobile-http.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/app/mobile-http.ts')>()
  return {
    ...actual,
    // 这条路由挂在 Connection 上，本文件不测注册；不注册反而少一处对外副作用。
    registerMobileHttp: () => {},
    phoneHandler: (runtime: Parameters<typeof actual.phoneHandler>[0]) => {
      const inner = actual.phoneHandler(runtime, 'http://gateway.test', (async (input: string | URL | Request) => {
        held.upstream.push(String(input instanceof Request ? input.url : input))
        return Response.json({ session_api: 1 })
      }) as typeof fetch)
      return async (request: Request): Promise<Response> => {
        held.seen.push(request)
        return inner(request)
      }
    },
  }
})

// 两条入口换成只记账的替身：要的是 `forward` 本身，不是真监听/真隧道。
// bindCandidates 等纯函数仍用真实现 —— apply 用它们算地址，替身没有自己的口径。
vi.mock('../src/app/lan-server.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/app/lan-server.ts')>()
  return {
    ...actual,
    createLanServer: (options: (typeof held.lans)[number]) => {
      held.lans.push(options)
      return { listen: async (port: number) => port, listenAll: async () => ['127.0.0.1'], close: async () => {} }
    },
  }
})
vi.mock('../src/app/tunnel.ts', () => ({
  createTunnel: (options: { forward: (typeof held.tunnels)[number]['options']['forward'] }) => {
    const entry = { options, closed: false }
    held.tunnels.push(entry)
    return { start: async () => {}, close: async () => { entry.closed = true }, state: () => 'live' as const,
      relayUrl: () => '', push: () => true }
  },
}))
// 设备表换成一张只会点头的表：隧道那条路要先过 phoneGate，这里要测的是 gate 之后的透传。
vi.mock('../src/app/remote.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/app/remote.ts')>()
  return { ...actual, deviceStoreOf: () => ({ allows: (deviceId: string, token: string) => deviceId === 'dev-1' && token === 'good-token' }) }
})
// 广播与 P2P 与本题无关：一个会往组播发 mDNS，一个会 spawn tailcat 二进制。都不该在跑测试时发生。
vi.mock('../src/app/discovery.ts', () => ({ createDiscovery: () => ({ publish: () => {}, stop: async () => {} }) }))
vi.mock('../src/app/p2p.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/app/p2p.ts')>()
  return { ...actual, createP2p: () => ({ start: () => {}, stop: async () => {}, addr: () => undefined }) }
})

// ── 跑一次 apply ────────────────────────────────────────────────────
const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  held.seen.length = 0
  held.upstream.length = 0
  held.lans.length = 0
  held.tunnels.length = 0
  held.runtimes.length = 0
  vi.unstubAllGlobals()
  for (const key of ['CREW_RELAY_URLS', 'CREW_RELAY_SECRET', 'CREW_RELAY_INSTANCE']) delete process.env[key]
})

/** 一个够 apply() 走完的 Cordis 上下文；effect 立即执行并把清理函数收起来。 */
function context() {
  return {
    on: vi.fn(),
    inject: vi.fn((_services: string[], callback: (child: unknown) => void) => {
      callback({ effect: (effect: () => unknown) => effect(), settings: { configure: () => () => {} }, logger: { warn: vi.fn() } })
    }),
    effect: vi.fn((factory: () => () => Promise<void>) => { void factory() }),
    fiber: { restart: vi.fn(async () => {}) },
    get: vi.fn(() => undefined),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }
}

/** 起一次 apply，返回两条入口的 `forward` 与 Runtime 替身。 */
async function boot(environment: Record<string, string> = {}): Promise<{ lan: (typeof held.lans)[number]; runtime: (typeof held.runtimes)[number]; stateDir: string }> {
  const stateDir = mkdtempSync(join(tmpdir(), 'crew-forward-headers-'))
  directories.push(stateDir)
  for (const [key, value] of Object.entries(environment)) process.env[key] = value
  await apply(context() as never, Config({ stateDir }))
  const lan = held.lans.at(-1)
  const runtime = held.runtimes.at(-1)
  if (!lan || !runtime) throw new Error('apply() did not build both entries')
  return { lan, runtime, stateDir }
}

/** LAN 形态的一次转发：headers 是 IncomingMessage['headers'] 的形状（同名多值是数组）。 */
const lanRequest = (lan: (typeof held.lans)[number], path: string, headers: Record<string, string | string[] | undefined>, body = '') =>
  lan.forward({ method: 'POST', url: path, headers, body: new TextEncoder().encode(body) })

// ── 1. sessionHeader 的行为（经它唯一的出口观察）──────────────────────

it('keeps x-crew-session on the Request it rebuilds, byte for byte', async () => {
  const { lan } = await boot()
  await lanRequest(lan, '/api/mobile/read', { 'x-crew-session': 'work' }, JSON.stringify({ last_read_id: 'r1' }))
  expect(held.seen).toHaveLength(1)
  expect(held.seen[0]!.headers.get('x-crew-session')).toBe('work')
  // 值不改写：合法会话名原样过去（不 trim、不 lower、不截断）。
  await lanRequest(lan, '/api/mobile/read', { 'x-crew-session': 'work-session-2' }, JSON.stringify({ last_read_id: 'r1' }))
  expect(held.seen[1]!.headers.get('x-crew-session')).toBe('work-session-2')
})

it('adds no header at all when the request carries no session header', async () => {
  const { lan } = await boot()
  await lanRequest(lan, '/api/mobile/read', {}, JSON.stringify({ last_read_id: 'r1' }))
  expect(held.seen).toHaveLength(1)
  expect(held.seen[0]!.headers.get('x-crew-session')).toBeNull()
  // 空对象意味着一个头都不带：不是「带一个空的 x-crew-session」。
  expect([...held.seen[0]!.headers.keys()]).toEqual([])
})

it('joins repeated session headers instead of guessing the first, and the surface answers 400', async () => {
  const { lan } = await boot()
  // 网关 get_all 的口径：同名多值拼成一个值，绝不取第一个 —— 取第一个就是替客户端猜它想进哪个会话。
  const answer = await lanRequest(lan, '/api/mobile/read', { 'x-crew-session': ['work', 'other'] }, JSON.stringify({ last_read_id: 'r1' }))
  expect(held.seen[0]!.headers.get('x-crew-session')).toBe('work, other')
  // 拼出来的值过不了会话名形状校验：真处理器回 400，绝不静默按 main 落库。
  // 这条 400 也带能力位（契约 §9.3 / #14 第 3 处），拼出来的原值逐字回显便于排障。
  expect(answer.status).toBe(400)
  expect(await answer.json()).toEqual({ error: 'invalid_session', session_id: 'work, other', session_api: 1 })
})

it('passes a single-element array through as one value, not as a joined oddity', async () => {
  const { lan } = await boot()
  // 反向代理把单值也包成数组（get_all 的形状）：一个元素拼出来仍是它自己，会话照常成立。
  // 这条与上一条是一对：数组不必然非法，非法的是「多个值还猜一个」。
  const answer = await lanRequest(lan, '/api/mobile/read', { 'x-crew-session': ['work'] }, JSON.stringify({ last_read_id: 'r1' }))
  expect(held.seen[0]!.headers.get('x-crew-session')).toBe('work')
  expect(answer.status).toBe(200)
})

it('refuses even two identical session headers rather than collapsing them', async () => {
  const { lan } = await boot()
  // 真 Node 收到两个同名头时会自己拼成 `work, work` 一个字符串；这里用数组形状送进去，
  // 结果同一条路：拼出来的值过不了形状校验，消息面回 400。
  // 与网关的一处口径差值得知道：mobilegw 先 dict.fromkeys 去重（['work','work'] → work 放行），
  // 这一侧不去重、直接拼。方向是安全的（失败即拒，绝不静默按 main 落库），
  // 所以按现状钉住；要不要跟网关对齐由 lead 定。
  const answer = await lanRequest(lan, '/api/mobile/read', { 'x-crew-session': ['work', 'work'] }, JSON.stringify({ last_read_id: 'r1' }))
  expect(held.seen[0]!.headers.get('x-crew-session')).toBe('work, work')
  expect(answer.status).toBe(400)
  expect(await answer.json()).toEqual({ error: 'invalid_session', session_id: 'work, work', session_api: 1 })
})

it('forwards an empty session header verbatim so the surface can refuse it', async () => {
  const { lan } = await boot()
  // 头在、值为空串（IncomingMessage 里很常见：`curl -H "x-crew-session;"`、客户端拿空环境变量拼头）。
  // 消息面的口径是「头存在但值为空 = 显式非法 → 400 invalid_session」。所以这里必须原样带下去，
  // 不能当「没带」丢掉 —— 丢掉之后请求会以「没带会话」的身份落到 main 并 200，那是 C4 静默串线。
  const answer = await lanRequest(lan, '/api/mobile/read', { 'x-crew-session': '' },
    JSON.stringify({ last_read_id: 'r1' }))
  expect(answer.status).toBe(400)
  // 原值就是空串：回显空串（不是把它美化掉，也不是换成 main）。
  expect(await answer.json()).toEqual({ error: 'invalid_session', session_id: '', session_api: 1 })
  // 而且没有任何会话水位被写下来（既没写 main，也没写空会话）。
  const runtime = held.runtimes.at(-1)!
  expect(runtime.store.get('mobile-read-cursor')).toBeUndefined()
  expect(runtime.store.get('mobile-read-cursor:')).toBeUndefined()
})

it('forwards no other header into the rebuilt Request', async () => {
  const { lan } = await boot()
  await lanRequest(lan, '/api/mobile/read', {
    'x-crew-session': 'work',
    // 凭据归各自入口的 phoneGate，不进重建的 Request：透传它等于把门里的东西再往里递一层。
    'x-crew-device': 'dev-1',
    'x-crew-credential': 'good-token',
    // 逐跳头与来源头同样不该进去。
    'x-forwarded-for': '10.0.0.9',
    'x-real-ip': '10.0.0.9',
    connection: 'keep-alive',
    'content-length': '21',
  }, JSON.stringify({ last_read_id: 'r1' }))
  const rebuilt = held.seen[0]!
  expect(rebuilt.headers.get('x-crew-session')).toBe('work')
  for (const name of ['x-crew-device', 'x-crew-credential', 'x-forwarded-for', 'x-real-ip', 'connection', 'content-length']) {
    expect(rebuilt.headers.get(name), name).toBeNull()
  }
  // 唯一被带上的就是那一个头。
  expect([...rebuilt.headers.keys()]).toEqual(['x-crew-session'])
})

// ── 2. 端到端：LAN 形态 → ask 重建 → 真 phoneHandler ──────────────────

it('lands the LAN session on the handler: the read cursor is keyed under work, not main', async () => {
  const { lan, runtime } = await boot()
  const answer = await lanRequest(lan, '/api/mobile/read', { 'x-crew-session': 'work' }, JSON.stringify({ last_read_id: 'r7' }))
  expect(answer.status).toBe(200)
  // 键名来自 src/kv.ts 的 mobile.readCursor：main 是 `mobile-read-cursor`，其余是 `mobile-read-cursor:<id>`。
  // 落成 `:work` 才算会话真的到了处理器 —— 退回 main 会写到没有后缀的那个键上（C4 串线）。
  expect(runtime.store.get('mobile-read-cursor:work')).toBe('r7')
  expect(runtime.store.get('mobile-read-cursor')).toBeUndefined()
})

it('leaves an old call on main: no session header still writes the legacy cursor key', async () => {
  const { lan, runtime } = await boot()
  const answer = await lanRequest(lan, '/api/mobile/read', {}, JSON.stringify({ last_read_id: 'r8' }))
  expect(answer.status).toBe(200)
  expect(runtime.store.get('mobile-read-cursor')).toBe('r8')
  expect(runtime.store.get('mobile-read-cursor:work')).toBeUndefined()
})

// ── 3. 另一条入口：tunnel 形态走同一个 ask，也必须到得了 ──────────────

it('lands the tunnel session on the handler too', async () => {
  // 中转那条路先过 phoneGate（凭据由替身点头），再过 ask —— 两条入口共用同一份重建逻辑。
  vi.stubGlobal('WebSocket', class {
    onerror?: () => void
    addEventListener(type: string, handler: () => void): void { if (type === 'error') this.onerror = handler }
    close(): void {}
  })
  const { runtime } = await boot({ CREW_RELAY_URLS: 'wss://relay.test/tunnel' })
  const tunnel = held.tunnels.at(-1)
  if (!tunnel) throw new Error('apply() did not build the tunnel')
  const answer = await tunnel.options.forward({
    method: 'POST', url: '/api/mobile/read',
    headers: { 'x-crew-session': 'work', 'x-crew-device': 'dev-1', 'x-crew-credential': 'good-token' },
    body: JSON.stringify({ last_read_id: 'r9' }),
  }, new AbortController().signal)
  expect(answer.status).toBe(200)
  expect(held.seen[0]!.headers.get('x-crew-session')).toBe('work')
  expect(runtime.store.get('mobile-read-cursor:work')).toBe('r9')
})

// ── 4. 回归守门（这一份测试的核心价值）────────────────────────────────
// 把 backend/src/index.ts 里 `headers: sessionHeader(request.headers),` 这一行删掉，这一条必须红：
// 重建的 Request 会丢掉会话头，handler 退回 main，`x-crew-session` 读出来是 null。
// 它是上面那些断言里最直白的一条，单独列出来是为了让「谁删了那一行」一眼看到红在哪。
it('the rebuilt Request keeps the session header: deleting that line in ask() turns this red', async () => {
  const { lan } = await boot()
  await lanRequest(lan, '/api/mobile/read', { 'x-crew-session': 'work' }, JSON.stringify({ last_read_id: 'r1' }))
  expect(held.seen).toHaveLength(1)
  expect(held.seen[0]!.headers.get('x-crew-session')).toBe('work')
})

// 同一个守门在另一侧：把那一行删掉，`work` 的消息会被写到 main 的键上。
it('deleting that line would put a work message on main: the cursor key is the second witness', async () => {
  const { lan, runtime } = await boot()
  await lanRequest(lan, '/api/mobile/read', { 'x-crew-session': 'work' }, JSON.stringify({ last_read_id: 'r1' }))
  expect(runtime.store.get('mobile-read-cursor:work')).toBe('r1')
  expect(runtime.store.get('mobile-read-cursor')).toBeUndefined()
})
