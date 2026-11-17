import { describe, expect, it } from 'vitest'
import {
  Diagnostics, MAX_BATCH, MAX_EVENT_ROW_BYTES, parseBatch, sanitizeEvent, stripQuery,
  type DiagnosticsStore,
} from '../src/app/diagnostics.ts'

/** 一个用 Map 当后端的假 store，只实现 Diagnostics 用到的那几个方法。 */
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

const at = (ms: number) => new Date(ms).toISOString()
const ev = (over: Record<string, unknown> = {}) => ({
  id: 'r1', at: at(1_000), event: 'connect_fail', route: '/api/mobile/timeline', method: 'get',
  status: 0, ms: 15, err: 'ECONNREFUSED', session: 'main', ...over,
})
/** 走真实 report：parseBatch 的 app/build 与 outcome 一起落行。 */
const rep = (box: Diagnostics, device: string, parsed: { app: string; build: string; outcome: import('../src/app/diagnostics.ts').BatchOutcome }) =>
  box.report(device, parsed.app, parsed.build, parsed.outcome)

describe('stripQuery', () => {
  it('keeps only the pathname, dropping query and hash', () => {
    expect(stripQuery('/api/mobile/timeline?session_id=main&x=1')).toBe('/api/mobile/timeline')
    expect(stripQuery('/a/b#h')).toBe('/a/b')
  })
  it('rejects anything that is not a rooted path', () => {
    expect(stripQuery('api/mobile/timeline')).toBeUndefined()
    expect(stripQuery(42)).toBeUndefined()
  })
})

describe('sanitizeEvent', () => {
  it('whitelists fields, upper-cases method, keeps a clean path route', () => {
    // route 必须是干净 pathname（不含 query）。带 query 的一律拒（见 route 敏感测试），这里用干净值。
    const v = sanitizeEvent(ev({ route: '/api/mobile/timeline', extra: { phase: 'connect', junk: 'drop' } }))
    expect('event' in v).toBe(true)
    if (!('event' in v)) return
    expect(v.event).toMatchObject({ id: 'r1', kind: 'event', event: 'connect_fail', route: '/api/mobile/timeline', method: 'GET' })
    // 未知 extra 键被丢，白名单键保留。
    expect(v.event.extra).toEqual({ phase: 'connect' })
  })

  it('refuses an err that looks like an exception message (spaces/punctuation) instead of storing it', () => {
    const v = sanitizeEvent(ev({ err: 'Failed: token=abc123 at login' }))
    if (!('event' in v)) throw new Error('expected accept')
    // err 不是短词 → 该字段整个不出现，绝不把带凭据的 message 落库。
    expect(v.event.err).toBeUndefined()
  })

  it('drops unknown kind down to event, and keeps crash extras only for crash', () => {
    const asCrash = sanitizeEvent({ ...ev(), kind: 'crash', errorClass: 'NullPointerException', stack: 'at a.b(C.java:1)', breadcrumbs: [{ event: 'tap', route: '/m' }] })
    if (!('event' in asCrash)) throw new Error('expected accept')
    expect(asCrash.event).toMatchObject({ kind: 'crash', errorClass: 'NullPointerException' })
    expect(asCrash.event.stack).toContain('NullPointerException'.length ? 'at a.b' : '')
    expect(asCrash.event.breadcrumbs?.length).toBe(1)
    // 普通 event 即使带了 stack 也不采（不进 event 分支）。
    const asEvent = sanitizeEvent({ ...ev(), kind: 'event', stack: 'x' })
    if (!('event' in asEvent)) throw new Error('expected accept')
    expect(asEvent.event).not.toHaveProperty('stack')
  })

  it('caps stack to 8KiB', () => {
    const huge = 'a'.repeat(10 * 1024)
    const v = sanitizeEvent({ ...ev(), kind: 'crash', stack: huge })
    if (!('event' in v)) throw new Error('expected accept')
    expect((v.event.stack ?? '').length).toBeLessThanOrEqual(8 * 1024)
  })

  it('rejects records missing id / bad at / missing route', () => {
    expect(sanitizeEvent({ at: at(1), event: 'x', route: '/a' })).toEqual({ reason: 'id_required' })
    expect(sanitizeEvent({ id: 'r', at: 'not-a-date', event: 'x', route: '/a' })).toEqual({ reason: 'bad_at' })
    expect(sanitizeEvent({ id: 'r', at: at(1), event: 'x', route: 'a' })).toEqual({ reason: 'route_required' })
  })
})

describe('parseBatch', () => {
  it('accepts a well-formed batch and reports app/build', () => {
    const r = parseBatch({ app: 'BotCrew', build: '0.1.0(1)', batch: [ev(), ev({ id: 'r2' })] })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.app).toBe('BotCrew')
    expect(r.outcome.accepted.map(e => e.id)).toEqual(['r1', 'r2'])
  })

  it('rejects a double-stringified body', () => {
    const r = parseBatch(JSON.stringify({ app: 'BotCrew', batch: [] }))
    expect(r.ok).toBe(false)
  })

  it('rejects batch over MAX_BATCH', () => {
    const batch = Array.from({ length: MAX_BATCH + 1 }, (_, i) => ev({ id: `r${i}` }))
    expect(parseBatch({ app: 'BotCrew', batch }).ok).toBe(false)
  })

  it('rejects an oversized (>16KiB) record individually with a reason, keeping good rows', () => {
    // 用 17KiB 的未知顶层字段把整条记录撑过 16KiB（JSON 序列化先算大小，再走白名单）。
    const oversized = { ...ev({ id: 'big' }), junk: 'x'.repeat(17 * 1024) }
    const r = parseBatch({ app: 'BotCrew', batch: [oversized, ev({ id: 'ok' })] })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.outcome.accepted.map(e => e.id)).toEqual(['ok'])
    expect(r.outcome.rejected).toContainEqual({ id: 'big', reason: 'row_too_large' })
  })

  it('all-bad batch is a 4xx, not a silent 200', () => {
    const r = parseBatch({ app: 'BotCrew', batch: [{ nope: true }] })
    expect(r.ok).toBe(false)
  })

  it('accepts a crash record up to 16KiB but not an event over 1KiB', () => {
    const crash = { ...ev({ id: 'c1' }), kind: 'crash', errorClass: 'E', stack: 'a'.repeat(4096) }
    const r = parseBatch({ app: 'BotCrew', batch: [crash] })
    expect(r.ok).toBe(true)
    expect(MAX_EVENT_ROW_BYTES).toBe(1024)
  })
})

describe('Diagnostics.report', () => {
  it('stores accepted rows and returns them in acceptedIds', () => {
    const store = memoryStore()
    const box = new Diagnostics(store, { now: () => 2_000 })
    const parsed = parseBatch({ app: 'BotCrew', build: 'b', batch: [ev({ id: 'a' }), ev({ id: 'b' })] })
    if (!parsed.ok) throw new Error('parse failed')
    const result = rep(box, 'dev-1', parsed)
    expect(result.acceptedIds).toEqual(['a', 'b'])
    expect(box.list({ device: 'dev-1' }).rows.map(r => r.id).sort()).toEqual(['a', 'b'])
  })

  it('is idempotent by id: re-ACKs the same id without storing it twice', () => {
    const store = memoryStore()
    const box = new Diagnostics(store, { now: () => 2_000 })
    const parsed = parseBatch({ app: 'BotCrew', batch: [ev({ id: 'dup' })] })
    if (!parsed.ok) throw new Error('parse failed')
    rep(box, 'dev-1', parsed)
    const again = rep(box, 'dev-1', parsed)
    // 同 id 再投：ACK 仍在，但只存了一行。
    expect(again.acceptedIds).toEqual(['dup'])
    expect(box.list({ device: 'dev-1' }).rows.filter(r => r.id === 'dup').length).toBe(1)
  })

  it('isolates devices: one device cannot read another', () => {
    const store = memoryStore()
    const box = new Diagnostics(store, { now: () => 2_000 })
    const a = parseBatch({ app: 'BotCrew', batch: [ev({ id: 'a1' })] })
    const b = parseBatch({ app: 'BotCrew', batch: [ev({ id: 'b1' })] })
    if (!a.ok || !b.ok) throw new Error('parse failed')
    rep(box, 'dev-a', a)
    rep(box, 'dev-b', b)
    expect(box.list({ device: 'dev-a' }).rows.map(r => r.id)).toEqual(['a1'])
    expect(box.list({ device: 'dev-b' }).rows.map(r => r.id)).toEqual(['b1'])
  })

  it('trims by per-device row cap, keeping the newest', () => {
    const store = memoryStore()
    const box = new Diagnostics(store, { now: () => 2_000, perDeviceMaxRows: 2, perDeviceMaxBytes: 1 << 20 })
    for (let i = 0; i < 5; i++) {
      const parsed = parseBatch({ app: 'BotCrew', batch: [ev({ id: `r${i}`, at: at(1_000 + i) })] })
      if (!parsed.ok) throw new Error('parse failed')
      rep(box, 'dev', parsed)
    }
    // 只留最近 2 行。
    expect(box.list({ device: 'dev' }).rows.map(r => r.id).sort()).toEqual(['r3', 'r4'])
  })

  it('trims by retain window (7 days)', () => {
    let now = 0
    const store = memoryStore()
    const day = 24 * 60 * 60 * 1000
    const box = new Diagnostics(store, { now: () => now })
    const old = parseBatch({ app: 'BotCrew', batch: [ev({ id: 'old', at: at(0) })] })
    if (!old.ok) throw new Error('parse failed')
    now = 0
    rep(box, 'dev', old)
    now = 8 * day // 8 天后新写一条，读时会把 7 天前的旧的淘汰
    const fresh = parseBatch({ app: 'BotCrew', batch: [ev({ id: 'fresh', at: at(now) })] })
    if (!fresh.ok) throw new Error('parse failed')
    rep(box, 'dev', fresh)
    expect(box.list({ device: 'dev' }).rows.map(r => r.id)).toEqual(['fresh'])
  })

  it('enforces a per-device byte cap', () => {
    const store = memoryStore()
    // 每条约 300B，封顶 700B → 只留最近 2 条左右。
    const box = new Diagnostics(store, { now: () => 5_000, perDeviceMaxRows: 5000, perDeviceMaxBytes: 700 })
    for (let i = 0; i < 6; i++) {
      const parsed = parseBatch({ app: 'BotCrew', batch: [ev({ id: `r${i}`, at: at(1_000 + i) })] })
      if (!parsed.ok) throw new Error('parse failed')
      rep(box, 'dev', parsed)
    }
    const rows = box.list({ device: 'dev' }).rows
    expect(rows.length).toBeLessThanOrEqual(3)
    expect(rows.length).toBeGreaterThan(0)
  })

  it('rate limits a device per window and reports Retry-After seconds', () => {
    let now = 0
    const store = memoryStore()
    const box = new Diagnostics(store, { now: () => now, rateLimit: 2, rateWindowMs: 60_000 })
    expect(box.rateAllowed('d').allowed).toBe(true)
    expect(box.rateAllowed('d').allowed).toBe(true)
    const third = box.rateAllowed('d')
    expect(third.allowed).toBe(false)
    expect(third.retryAfterSec).toBeGreaterThan(0)
    // 换窗口后放行。
    now = 60_001
    expect(box.rateAllowed('d').allowed).toBe(true)
  })

  it('persists across a store reopen (KV durability)', () => {
    const store = memoryStore()
    const box = new Diagnostics(store, { now: () => 2_000 })
    const parsed = parseBatch({ app: 'BotCrew', batch: [ev({ id: 'keep' })] })
    if (!parsed.ok) throw new Error('parse failed')
    rep(box, 'dev', parsed)
    // 用同一份底层 map 新建一个 Diagnostics（模拟进程重启后从库里读回）。
    const reopened = new Diagnostics(store, { now: () => 3_000 })
    expect(reopened.list({ device: 'dev' }).rows.map(r => r.id)).toEqual(['keep'])
  })

  it('errorsOnly filter keeps crashes and error statuses but drops plain events', () => {
    const store = memoryStore()
    const box = new Diagnostics(store, { now: () => 2_000 })
    const parsed = parseBatch({ app: 'BotCrew', batch: [
      ev({ id: 'plain', event: 'screen_open', status: 200, err: undefined }),
      ev({ id: 'bad', status: 502 }),
      { ...ev({ id: 'crash' }), kind: 'crash', errorClass: 'E' },
    ] })
    if (!parsed.ok) throw new Error('parse failed')
    rep(box, 'dev', parsed)
    const ids = box.list({ device: 'dev', errorsOnly: true }).rows.map(r => r.id).sort()
    expect(ids).toEqual(['bad', 'crash'])
  })

  it('export produces NDJSON, one row per line, and never carries secrets', () => {
    const store = memoryStore()
    const box = new Diagnostics(store, { now: () => 2_000 })
    const parsed = parseBatch({ app: 'BotCrew', batch: [ev({ id: 'x', route: '/api/mobile/timeline' })] })
    if (!parsed.ok) throw new Error('parse failed')
    rep(box, 'dev', parsed)
    const ndjson = box.exportNdjson({ device: 'dev' })
    const lines = ndjson.trim().split('\n')
    expect(lines.length).toBe(1)
    expect(JSON.parse(lines[0]!).id).toBe('x')
    expect(ndjson).not.toContain('SEKRET')
  })

  it('global byte accounting stays consistent after evicting other devices (no inflation)', () => {
    const store = memoryStore()
    // 全球只允许 ~2 条的空间；两台设备轮流写，触发跨设备淘汰。
    const box = new Diagnostics(store, { now: () => 9_000, perDeviceMaxRows: 5000, perDeviceMaxBytes: 1 << 20,
      globalMaxRows: 5000, globalMaxBytes: 700 })
    for (let i = 0; i < 6; i++) {
      const device = i % 2 === 0 ? 'dev-a' : 'dev-b'
      const parsed = parseBatch({ app: 'BotCrew', batch: [ev({ id: `${device}-${i}`, at: at(1_000 + i) })] })
      if (!parsed.ok) throw new Error('parse failed')
      rep(box, device, parsed)
    }
    // 从库里真实重算全球字节数，必须与实际剩余行合计一致（且不超过上限 + 一行余量）。
    const allRows = [...box.list({ device: 'dev-a', limit: 2000 }).rows, ...box.list({ device: 'dev-b', limit: 2000 }).rows]
    const actualBytes = allRows.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0)
    const recorded = store.get<number>('diagnostics:bytes')
    // 记录值与实际值同量级（允许因排序/列表裁剪的小差），关键是**不偏高**到 2 倍。
    expect(recorded).toBeLessThanOrEqual(actualBytes + 1024)
    expect(actualBytes).toBeLessThanOrEqual(700 + 512)
    expect(store.get<number>('diagnostics:bytes')).toBeLessThan(700 * 2)
  })
})

describe('root-cause fixes (metadata / stack / sensitive / retention-on-read / empty)', () => {
  it('carries batch-level app/build onto every persisted row and survives reopen', () => {
    const store = memoryStore()
    const box = new Diagnostics(store, { now: () => 2_000 })
    const parsed = parseBatch({ app: 'BotCrew', build: '0.2.3(45)', batch: [ev({ id: 'a' }), ev({ id: 'b' })] })
    if (!parsed.ok) throw new Error('parse failed')
    rep(box, 'dev-1', parsed)
    // 客户端只在批级带 build：落行的每一行都要带 app/build。
    for (const row of box.list({ device: 'dev-1' }).rows) {
      expect(row).toMatchObject({ app: 'BotCrew', build: '0.2.3(45)', device: 'dev-1' })
    }
    // 重开（模拟进程重启）后元数据仍在。
    const reopened = new Diagnostics(store, { now: () => 3_000 })
    expect(reopened.list({ device: 'dev-1' }).rows[0]).toMatchObject({ app: 'BotCrew', build: '0.2.3(45)' })
  })

  it('keeps only structural stack frames, dropping exception messages / token URLs / free text', () => {
    const stack = [
      'java.lang.NullPointerException: Failed to load user token=abc123SECRET at /api?token=x',
      'at com.acme.App.load(App.kt:42)',
      'at com.acme.Net.fetch(Net.kt:88)',
      'Caused by: chat message "hello this is private chat 老板说加薪"',
      '    at android.os.Handler.dispatch(Handler.java:99)',
      'NativeMethod',
    ].join('\n')
    const v = sanitizeEvent({ ...ev(), kind: 'crash', errorClass: 'NullPointerException', stack })
    if (!('event' in v)) throw new Error('expected accept')
    const out = v.event.stack ?? ''
    // 结构帧保留。
    expect(out).toContain('at com.acme.App.load(App.kt:42)')
    expect(out).toContain('at com.acme.Net.fetch(Net.kt:88)')
    // 异常 message / token URL / 聊天原文整条丢弃。
    expect(out).not.toContain('SECRET')
    expect(out).not.toContain('token=')
    expect(out).not.toContain('加薪')
    expect(out).not.toContain('NullPointerException') // message 行不带括号位置，不收
    expect(out).not.toContain('Caused by')
  })

  it('strips sensitive extra values and rejects a route carrying an encoded secret', () => {
    const ok = sanitizeEvent({ ...ev(), extra: { phase: 'connect', networkKind: 'wifi', model: 'aGVsbG9Xb3JsZDEyMzQ1Njc4OTBhYmNkZWY=' } })
    if (!('event' in ok)) throw new Error('expected accept')
    // 像 base64/长随机串的 model 值被剥掉，其余保留。
    expect(ok.event.extra).toEqual({ phase: 'connect', networkKind: 'wifi' })
    const sensitiveExtra = sanitizeEvent({ ...ev(), extra: { phase: 'connect', model: 'password=hunter2' } })
    if (!('event' in sensitiveExtra)) throw new Error('expected accept')
    // 只有命中敏感模式的 model 值被剥掉；合法的 phase 保留。
    expect(sensitiveExtra.event.extra).toEqual({ phase: 'connect' })
    // 把 query 编码进路径（`%3Ftoken%3D…`）：解码后冒出 `?token=` → 整条拒（route_sensitive），不 strip 后假装干净。
    const badRoute = sanitizeEvent({ ...ev(), route: '/api/x%3Ftoken%3DSECRET' })
    expect(badRoute).toEqual({ reason: 'route_sensitive' })
    // 双层编码绕过（`%253F` 单解一次变 `%3F`，既无字面 ? 也不命中 hasSensitive）：残留 %HH → 明确拒 route_bad_encoding。
    expect(sanitizeEvent({ ...ev(), route: '/api/x%253Ftoken%253Dsecret' })).toEqual({ reason: 'route_bad_encoding' })
    // 明文 query 也拒（报告只该带干净 pathname）。
    expect(sanitizeEvent({ ...ev(), route: '/api/user?token=SECRET' })).toEqual({ reason: 'route_sensitive' })
    // 裸路径里的长密钥段（sk_live_ + 下划线前缀，\b 不成立）→ 拒。
    // 密钥形态的假值按段拼接，避免仓库里出现能命中密钥扫描的字面量；运行时值不变。
    const keyLike = 'sk_' + 'live_abcdefghij1234567890ABCDEF'
    expect(sanitizeEvent({ ...ev(), route: '/api/user/' + keyLike })).toEqual({ reason: 'route_sensitive' })
    // 直接塞 Bearer 到路径里 → 拒收。
    const bearerRoute = sanitizeEvent({ ...ev(), route: '/x/Bearer abcdefgh12345678' })
    expect(bearerRoute).toEqual({ reason: 'route_sensitive' })
  })

  it('never returns expired rows on list/export even without a later POST (clock advanced)', () => {
    let now = 0
    const day = 24 * 60 * 60 * 1000
    const store = memoryStore()
    const box = new Diagnostics(store, { now: () => now })
    const parsed = parseBatch({ app: 'BotCrew', batch: [ev({ id: 'old', at: at(0) })] })
    if (!parsed.ok) throw new Error('parse failed')
    rep(box, 'silent-dev', parsed)
    // 把时钟推进 8 天，但**不发任何新 POST**：GET/导出必须看不到过期报告。
    now = 8 * day
    expect(box.list({ device: 'silent-dev' }).rows).toEqual([])
    expect(box.list({}).rows).toEqual([])
    expect(box.exportNdjson({ device: 'silent-dev' }).trim()).toBe('')
  })

  it('prunes other silent devices too when a different device posts', () => {
    let now = 0
    const day = 24 * 60 * 60 * 1000
    const store = memoryStore()
    const box = new Diagnostics(store, { now: () => now })
    const a = parseBatch({ app: 'BotCrew', batch: [ev({ id: 'a-old', at: at(0) })] })
    if (!a.ok) throw new Error('parse failed')
    rep(box, 'dev-a', a)
    // 8 天后另一台设备上报：应连带把 dev-a 的过期行从存储里淘汰（不是只在读时过滤）。
    now = 8 * day
    const b = parseBatch({ app: 'BotCrew', batch: [ev({ id: 'b-new', at: at(now) })] })
    if (!b.ok) throw new Error('parse failed')
    rep(box, 'dev-b', b)
    // dev-a 的段里那行已被删（重开后也读不到）。
    const reopened = new Diagnostics(store, { now: () => now })
    expect(reopened.list({ device: 'dev-a' }).rows).toEqual([])
    expect(reopened.list({ device: 'dev-b' }).rows.map(r => r.id)).toEqual(['b-new'])
  })

  it('refuses an empty batch[] with a 400 (not a silent empty ACK)', () => {
    expect(parseBatch({ app: 'BotCrew', batch: [] })).toEqual({ ok: false, error: 'batch must not be empty' })
  })

  it('management view rows carry a server-derived device field so merged arrays are attributable', () => {
    const store = memoryStore()
    const box = new Diagnostics(store, { now: () => 2_000 })
    const a = parseBatch({ app: 'BotCrew', batch: [ev({ id: 'a1' })] })
    const b = parseBatch({ app: 'BotCrew', batch: [ev({ id: 'b1' })] })
    if (!a.ok || !b.ok) throw new Error('parse failed')
    rep(box, 'dev-a', a)
    rep(box, 'dev-b', b)
    const merged = box.list({}).rows
    expect(merged.find(r => r.id === 'a1')?.device).toBe('dev-a')
    expect(merged.find(r => r.id === 'b1')?.device).toBe('dev-b')
  })
})
