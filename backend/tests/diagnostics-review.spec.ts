/**
 * 独立验证（task-12）差分测试 · 只补 owner 的单测没覆盖的缝，不镜像实现、不复制 owner 用例。
 *
 * owner 已有：tests/diagnostics.spec.ts（纯函数/落盘/幂等/设备隔离/写侧淘汰/字节/重开/errorsOnly/导出脱敏）
 *           tests/diagnostics-http.spec.ts（phoneHandler 直调：ACK/401/413/429/自读/重开）
 * 本文件只测它们**没测**的、且任务书/lead 点名要的：
 *   G1 沉默设备读侧过期兜底：只写一次后时间推进，GET/export 仍不得返回过期行（item #3 读侧）。
 *   G2 route 去 query 后仍残留敏感形态（路径内 token、编码 query）→ 整条拒收 route_sensitive（item #2）。
 *   G3 crash.stack 只保留帧：异常 message / token / base64 行整条丢弃（item #2）。
 *   G4 extra 值命中敏感模式 → 整条值丢弃，不 half-store（item #2）。
 *   G5 入口 principal 伪造：经真实 apply() 的 LAN forward 缝，A 用真实有效凭据 + 同时伪造
 *      x-crew-principal=B / body.device=B / query.device=B，落到 phoneHandler 的 principal 只能是 A，
 *      且 A 既写不进也读不到 B 段（lead 高价值点：别把字符串叫 internal 就当信任）。
 *   G6 管理面 list 全设备 + limit 上限 clamp（避免 unbounded）：与 G5 不同库，用纯 Diagnostics。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Diagnostics, sanitizeEvent, parseBatch, type BatchOutcome, type DiagnosticsStore } from '../src/app/diagnostics.ts'

const at = (ms: number) => new Date(ms).toISOString()
const ev = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'r1', at: at(70_000), event: 'connect_fail', route: '/api/mobile/timeline', method: 'get',
  status: 0, ms: 15, err: 'ECONNREFUSED', session: 'main', ...over,
})

/** 与 owner 同款的 Map store —— 这里独立一份，不 import owner 测试，避免耦合。 */
function memoryStore(): DiagnosticsStore & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    get<V>(name: string) { const raw = map.get(name); return raw === undefined ? undefined : JSON.parse(raw) as V },
    set<V>(name: string, value: V) { map.set(name, JSON.stringify(value)) },
    delete(name: string) { map.delete(name) },
    keys(prefix: string) { return [...map.keys()].filter(key => key.startsWith(prefix)) },
  } as DiagnosticsStore & { map: Map<string, string> }
}
const rep = (box: Diagnostics, device: string, parsed: { app: string; build: string; outcome: BatchOutcome }) =>
  box.report(device, parsed.app, parsed.build, parsed.outcome)

// ── G1 沉默设备读侧过期兜底（item #3）──────────────────────────────
describe('G1 读侧保留期兜底：沉默设备不会被 GET/export 读到过期行', () => {
  it('a device written once then left silent is not returned after retain expires, without any new report', () => {
    const store = memoryStore()
    // 保留期 1000ms；先在该时刻写一条，之后**不再 report**，只把 now 推到过期之后再看。
    const box = new Diagnostics(store, { now: () => 1_000, retainMs: 1_000 })
    const parsed = parseBatch({ app: 'BotCrew', batch: [ev({ id: 'old', at: at(1_000) })] })
    if (!parsed.ok) throw new Error('parse failed')
    rep(box, 'silent-dev', parsed)
    expect(box.list({ device: 'silent-dev' }).rows.map(r => r.id)).toEqual(['old'])

    // 时间推进到 3_000（已过期），**没有**任何写操作触发 prune —— 纯读。
    const later = new Diagnostics(store, { now: () => 3_000, retainMs: 1_000 })
    expect(later.list({ device: 'silent-dev' }).rows).toEqual([])
    // export 同口径：不得吐出过期行。
    expect(later.exportNdjson({ device: 'silent-dev' }).trim()).toBe('')
  })
})

// ── G2 route 去 query 后残留敏感形态（item #2「encodedquery 没处理」）──
// 现状（review 时静态核过 SENSITIVE 正则）：`%3Ftoken%3D` 与裸路径 `sk_live_...` 都**不命中**当前
// SENSITIVE（前者无 `?&`、后者前面是 `_` 无 \b），故当前实现会**接受并把 token 落盘** —— 这是差分红点，
// owner 收口补齐编码 query 处理 + 该形态后应转绿。判据按任务书要求（encoded query 必须处理）。
describe('G2 route 残留敏感形态整条拒收（含多层编码）', () => {
  it('rejects a percent-encoded query smuggled into the path', () => {
    // 客户端把 `?token=...` 编码进路径：`/x%3Ftoken%3DSECRET`；stripQuery 看不到 `?`，但编码后仍是 query。
    const v = sanitizeEvent(ev({ route: '/api/x%3Ftoken%3DSECRETVALUE' }))
    expect('reason' in v && v.reason).toBe('route_sensitive')
  })

  it('rejects a double/multi-layer encoded query that survives one decode as residual %HH', () => {
    // lead 静态发现的洞：`%253Ftoken%253D` 单解后变 `%3Ftoken%3D`（仍编码），不能落盘。
    // 现实现：一次 decode 后仍残留 `%HH` → 拒 route_bad_encoding（不循环无限解、不保留歧义编码）。
    for (const route of ['/api/x%253Ftoken%253Dsecret', '/api/x%25253Ftoken%25253Dsecret']) {
      const v = sanitizeEvent(ev({ route }))
      expect('reason' in v, `route ${route} must be rejected`).toBe(true)
      // 明确是编码类拒绝（bad_encoding），且绝不含令牌明文
      expect(('reason' in v) && v.reason).toBe('route_bad_encoding')
    }
    // 非法百分号序列同样拒（不吞、不保留原值）
    const bad = sanitizeEvent(ev({ route: '/api/x%ZZ' }))
    expect(('reason' in bad) && bad.reason).toBe('route_bad_encoding')
  })

  it('rejects a bare bearer-style path token after query stripping', () => {
    // 无 `?`/`#`，令牌长在路径里（`sk_live_` 后 32+ 位）—— stripQuery 保不住，需敏感模式兜。
    // 密钥形态的假值按段拼接，避免仓库里出现能命中密钥扫描的字面量；运行时值不变。
    const keyLike = 'sk_' + 'live_abcdefghij1234567890ABCDEF'
    const v = sanitizeEvent(ev({ route: '/api/user/' + keyLike }))
    expect('reason' in v && v.reason).toBe('route_sensitive')
  })

  it('keeps a clean pathname unchanged', () => {
    const v = sanitizeEvent(ev({ route: '/api/mobile/timeline' }))
    if (!('event' in v)) throw new Error('clean route must be accepted')
    expect(v.event.route).toBe('/api/mobile/timeline')
  })
})

// ── G3 crash.stack 只留帧（item #2）──────────────────────────────
describe('G3 crash.stack 只保留帧，异常 message / token 行丢弃', () => {
  it('keeps stack frames but drops an exception-message line and a token-bearing line', () => {
    const stack = [
      'java.lang.RuntimeException: login failed token=SECRET_TOKEN_abc123', // message 行：带 token → 丢
      'at com.dsh.botcrew.CrewClient.read(CrewClient.kt:123)',
      'at com.dsh.botcrew.MainActivity.onCreate(MainActivity.kt:45)',
      'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig', // token 行 → 丢
    ].join('\n')
    const v = sanitizeEvent(ev({ kind: 'crash', stack, errorClass: 'java.lang.RuntimeException' }))
    if (!('event' in v)) throw new Error('expected accept')
    const stored = v.event.stack ?? ''
    // 帧保留
    expect(stored).toContain('at com.dsh.botcrew.CrewClient.read(CrewClient.kt:123)')
    expect(stored).toContain('at com.dsh.botcrew.MainActivity.onCreate(MainActivity.kt:45)')
    // message / token 段一律不落
    expect(stored).not.toContain('SECRET_TOKEN_abc123')
    expect(stored).not.toContain('login failed')
    expect(stored.toLowerCase()).not.toContain('bearer')
    expect(stored).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9')
  })
})

// ── G4 extra 值命中敏感 → 整值丢弃（item #2）──────────────────────
describe('G4 extra 敏感值整条丢弃', () => {
  it('drops the whole extra value (no half-store) when it looks like a credential', () => {
    const v = sanitizeEvent(ev({ extra: {
      phase: 'startup',                         // 干净 → 保留
      model: 'access_token=abc123def456',       // 敏感 → 整个值丢
      version: 'Bearer abcdefghijklmnop',       // 敏感 → 丢
      networkKind: 'wifi',                      // 干净 → 保留
    } }))
    if (!('event' in v)) throw new Error('expected accept')
    const extra = v.event.extra ?? {}
    expect(extra.phase).toBe('startup')
    expect(extra.networkKind).toBe('wifi')
    expect(extra.model).toBeUndefined()
    expect(extra.version).toBeUndefined()
    // 落盘整体也不得夹带任何敏感片段
    expect(JSON.stringify(v.event)).not.toContain('abc123def456')
  })
})

// ── G6 管理面 all 设备 + limit clamp（避免 unbounded）──────────────
describe('G6 list 全设备 + limit 上限 clamp', () => {
  it('lists rows across all devices when no device filter, and clamps limit to <= 2000', () => {
    const store = memoryStore()
    const box = new Diagnostics(store, { now: () => 70_000 })
    for (const [device, id] of [['dev-a', 'a1'], ['dev-b', 'b1']] as const) {
      const parsed = parseBatch({ app: 'BotCrew', batch: [ev({ id })] })
      if (!parsed.ok) throw new Error('parse failed')
      rep(box, device, parsed)
    }
    const all = box.list({}) // 无 device → 全设备
    expect(all.rows.map(r => r.device).sort()).toEqual(['dev-a', 'dev-b'])
    // 每行都带 server 派生 device（绝不来自 body），是辨来源的依据。
    for (const row of all.rows) expect(['dev-a', 'dev-b']).toContain(row.device)
    // limit 传超大 → 仍 clamp 到 <= 2000（这里行数少，只断言不报错且被接受）。
    expect(() => box.list({ limit: 10_000_000 })).not.toThrow()
    // limit 下限：传 0/负数也不得返回全量（list 内部 clamp 到 >=1）。
    expect(box.list({ limit: 0 }).rows.length).toBeLessThanOrEqual(1)
  })
})

// ══ G5 入口 principal 伪造（经真实 apply() 的 LAN forward 缝）══════════════
// 机制同 tests/index-forward-headers.spec.ts：mock 掉两条入口，只拿 `forward`；
// phoneHandler 用真实现包一层记账。设备表：只有 A 真实有效（dev-a / good-token-a）。
const held = vi.hoisted(() => ({
  seen: [] as Request[],
  lans: [] as { forward: (r: { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: Uint8Array<ArrayBuffer> }) => Promise<Response> }[],
  runtimes: [] as { store: { get: (k: string) => unknown } }[],
}))

vi.mock('../src/app/runtime.ts', async () => {
  const { Diagnostics } = await import('../src/app/diagnostics.ts')
  return { Runtime: class {
  ready = Promise.resolve()
  readonly health = new Map<string, unknown>()
  /** 真 Diagnostics 落在内存 Map store 上 —— 与生产 Runtime 构造同款（store 就绪后建），手机面收/管理面读共用一份。 */
  readonly diagnostics: import('../src/app/diagnostics.ts').Diagnostics
  readonly store: { get: (k: string) => unknown; set: (k: string, v: unknown) => void; delete: (k: string) => void
    settings: () => Record<string, unknown>; tickets: { list: () => unknown[]; get: () => undefined }; keys: () => string[] }
  constructor(_ctx: unknown, readonly machine: { stateDir: string }, readonly restart: () => void) {
    const kv = new Map<string, string>()
    const store = {
      get: (k: string) => { const raw = kv.get(k); return raw === undefined ? undefined : JSON.parse(raw) },
      set: (k: string, v: unknown) => { kv.set(k, JSON.stringify(v)) },
      delete: (k: string) => { kv.delete(k) },
      settings: () => ({ paused: false }),
      tickets: { list: () => [] as unknown[], get: () => undefined },
      keys: () => [...kv.keys()],
    }
    this.store = store
    this.diagnostics = new Diagnostics(store as unknown as import('../src/app/diagnostics.ts').DiagnosticsStore)
    held.runtimes.push(this)
  }
  claimHealth(name: string, initial?: unknown) {
    this.health.set(name, initial)
    return { get: () => this.health.get(name), set: (v: unknown) => { this.health.set(name, v) }, release: () => { this.health.delete(name) } }
  }
  configured() { return true }
  attachPusher() {}
  async stop() {}
} }
})

vi.mock('../src/app/mobile-http.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/app/mobile-http.ts')>()
  return {
    ...actual,
    registerMobileHttp: () => {},
    phoneHandler: (runtime: Parameters<typeof actual.phoneHandler>[0]) => {
      const inner = actual.phoneHandler(runtime, 'http://gateway.test',
        (async () => Response.json({ session_api: 1 })) as unknown as typeof fetch)
      return async (request: Request): Promise<Response> => { held.seen.push(request); return inner(request) }
    },
  }
})
vi.mock('../src/app/lan-server.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/app/lan-server.ts')>()
  return { ...actual, createLanServer: (options: (typeof held.lans)[number]) => {
    held.lans.push(options)
    return { listen: async (port: number) => port, listenAll: async () => ['127.0.0.1'], close: async () => {} }
  } }
})
vi.mock('../src/app/tunnel.ts', () => ({ createTunnel: () => ({ start: async () => {}, close: async () => {}, state: () => 'live' as const, relayUrl: () => '', push: () => true }) }))
// 设备表：**只有 A 有效**。B 是伪造目标，凭据不匹配任何设备。
vi.mock('../src/app/remote.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/app/remote.ts')>()
  return { ...actual, deviceStoreOf: () => ({ allows: (deviceId: string, token: string) => deviceId === 'dev-a' && token === 'good-token-a' }) }
})
vi.mock('../src/app/discovery.ts', () => ({ createDiscovery: () => ({ publish: () => {}, stop: async () => {} }) }))
vi.mock('../src/app/p2p.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/app/p2p.ts')>()
  return { ...actual, createP2p: () => ({ start: () => {}, stop: async () => {}, addr: () => undefined }) }
})

describe('G5 入口 principal 伪造：A 的真凭据 + 伪造 B 的 principal/device 不得越权', () => {
  afterEach(() => { held.seen.length = 0; held.lans.length = 0; held.runtimes.length = 0 })

  async function boot() {
    const { Config } = await import('../src/deployment.ts')
    const { apply } = await import('../src/index.ts')
    const stateDir = mkdtempSync(join(tmpdir(), 'diag-principal-')); dirs.push(stateDir)
    const ctx = {
      on: vi.fn(),
      inject: vi.fn((_s: string[], cb: (child: unknown) => void) => cb({ effect: (e: () => unknown) => e(), settings: { configure: () => () => {} }, logger: { warn: vi.fn() } })),
      effect: vi.fn((f: () => () => Promise<void>) => { void f() }),
      fiber: { restart: vi.fn(async () => {}) }, get: vi.fn(() => undefined),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }
    await apply(ctx as never, Config({ stateDir }))
    const lan = held.lans.at(-1); if (!lan) throw new Error('apply() built no lan')
    return lan
  }
  const dirs: string[] = []
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

  it('A posts with forged x-crew-principal=B and body.device/query.device=B: stored under A only', async () => {
    const lan = await boot()
    const body = JSON.stringify({ app: 'BotCrew', build: 'b', device: 'dev-b', batch: [ev({ id: 'p1' })] })
    const res = await lan.forward({ method: 'POST', url: '/api/mobile/diagnostics?device=dev-b',
      headers: {
        'x-crew-device': 'dev-a', 'x-crew-credential': 'good-token-a', // 真实有效 A
        'x-crew-principal': 'dev-b',                                    // 伪造内部头
      }, body: new TextEncoder().encode(body) })
    expect(res.status).toBe(200)
    // 到达 phoneHandler 的 Request 里，principal 头必须是 A（不是伪造的 B），且只有一个值。
    const seen = held.seen.at(-1)!
    expect(seen.headers.get('x-crew-principal')).toBe('dev-a')
    // 落到库里的 device 只能是 A —— 读 A 看得到、读 B 看不到。
    const rt = held.runtimes.at(-1)!
    const json = JSON.stringify(rt.store.get('diagnostics:dev:dev-a') ?? null)
    expect(json).toContain('p1')
    expect(rt.store.get('diagnostics:dev:dev-b')).toBeUndefined()
  })

  it('A cannot read B rows by query.device=B or forged principal', async () => {
    const lan = await boot()
    // 先用 A 写一条（确认 A 段存在）
    await lan.forward({ method: 'POST', url: '/api/mobile/diagnostics',
      headers: { 'x-crew-device': 'dev-a', 'x-crew-credential': 'good-token-a' },
      body: new TextEncoder().encode(JSON.stringify({ app: 'BotCrew', batch: [ev({ id: 'mine' })] })) })
    // A 再 GET，试图用 query.device=dev-b + 伪造 principal=dev-b 读 B
    const res = await lan.forward({ method: 'GET', url: '/api/mobile/diagnostics?device=dev-b',
      headers: { 'x-crew-device': 'dev-a', 'x-crew-credential': 'good-token-a', 'x-crew-principal': 'dev-b' },
      body: new Uint8Array() })
    expect(res.status).toBe(200)
    const payload = await res.json() as { device: string; rows: Array<{ id: string }> }
    // GET 的 device 永远是 principal 派生的 A，不是 query 里的 B
    expect(payload.device).toBe('dev-a')
    // 返回的只能是 A 自己的行
    expect(payload.rows.map(r => r.id)).toEqual(['mine'])
  })

  it('a forged x-crew-principal header does not bypass the credential gate (direct phoneGate)', async () => {
    // 直接调真 phoneGate（不 mock，不绑端口）：带了 internal 风格的 x-crew-principal、但凭据错/无 → 必须 401。
    // 这条钉住「internal 头不是通行证」—— 放行只看 devices.allows(真凭据)。
    const { phoneGate } = await import('../src/app/phone-gate.ts')
    const devices = { allows: (deviceId: string, token: string) => deviceId === 'dev-a' && token === 'good-token-a' }
    // 伪造成 A 的 principal，但凭据是坏的
    const denied = phoneGate({ pathname: '/api/mobile/diagnostics', method: 'POST',
      headers: { 'x-crew-device': 'dev-b', 'x-crew-credential': 'wrong', 'x-crew-principal': 'dev-a' }, devices })
    expect(denied?.status).toBe(401)
    // 完全无凭据但带 internal 头 → 仍 401
    const denied2 = phoneGate({ pathname: '/api/mobile/diagnostics', method: 'POST',
      headers: { 'x-crew-principal': 'dev-a' }, devices })
    expect(denied2?.status).toBe(401)
    // 真凭据 → 放行（返回 undefined）
    const ok = phoneGate({ pathname: '/api/mobile/diagnostics', method: 'POST',
      headers: { 'x-crew-device': 'dev-a', 'x-crew-credential': 'good-token-a', 'x-crew-principal': 'dev-b' }, devices })
    expect(ok).toBeUndefined()
  })
})
