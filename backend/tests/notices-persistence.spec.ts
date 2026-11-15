import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { KV } from '../src/kv.ts'
import { deliver, MAX_QUEUE_PER_DEVICE, noticeId, PushOutbox, QUEUE_TTL_MS, storeNoticeStore, type NoticeStore, type PushMessage } from '../src/app/push.ts'

// 真实设备号形状：手机报的 ANDROID_ID（16 位十六进制），桌面是手写名。
const A = 'd021988751fdd554'
const B = '66e74d226c1e38fa'
const msg = (over: Partial<PushMessage> = {}): PushMessage => ({ deviceId: A, title: '有事', body: '队伍在等你', kind: 'followup', ...over })

let directory: string
const openStore = (path = join(directory, 'orchestrator.sqlite')): Store => new Store(path)
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'orchestrator-notice-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) })

describe('PushOutbox over the project Store (durable across instance rebuild)', () => {
  it('keeps an enqueued notice across a fresh Store + fresh PushOutbox on the same DB', () => {
    let now = 1_000
    const storeA = openStore()
    const outboxA = new PushOutbox({ now: () => now }, storeNoticeStore(storeA))
    expect(outboxA.keep(msg({ body: '唯一一条' }))).toBe(1)
    const expectedId = noticeId(msg({ body: '唯一一条' }))
    storeA.close()

    // 实例重建：同一个 DB 文件、新的 Store、新的 PushOutbox —— 内存全丢。
    const storeB = openStore()
    const outboxB = new PushOutbox({ now: () => now }, storeNoticeStore(storeB))
    const items = outboxB.peek(A)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ id: expectedId, title: '有事', body: '唯一一条', kind: 'followup' })
    expect(outboxB.depth(A)).toBe(1)
    storeB.close()
  })

  it('uses a stable id across store reads, and peek never deletes', () => {
    const store = openStore()
    const outbox = new PushOutbox({}, storeNoticeStore(store))
    outbox.keep(msg())
    const first = outbox.peek(A)[0]!.id
    // 反复 peek 不移除、id 不变（设备靠它去重）。
    for (let i = 0; i < 5; i++) expect(outbox.peek(A)[0]!.id).toBe(first)
    // 同一份 DB 换实例再 peek，还是同一个 id（id 入队即生成并落盘）。
    const reopened = new PushOutbox({}, storeNoticeStore(openStorePreserving()))
    expect(reopened.peek(A)[0]!.id).toBe(first)
    store.close()
  })

  it('ack removes from durable storage: a rebuild afterwards has nothing', () => {
    const storeA = openStore()
    const outboxA = new PushOutbox({}, storeNoticeStore(storeA))
    outboxA.keep(msg({ body: '一' }))
    outboxA.keep(msg({ body: '二', kind: 'routine' }))
    const ids = outboxA.peek(A).map(item => item.id)
    expect(ids).toHaveLength(2)
    expect(outboxA.ack(A, ids)).toBe(2)
    storeA.close()

    const storeB = openStore()
    const outboxB = new PushOutbox({}, storeNoticeStore(storeB))
    expect(outboxB.peek(A)).toEqual([])
    expect(outboxB.depth(A)).toBe(0)
    // 空桶在盘上也清掉了，不留孤键。
    expect(storeB.keys(KV.notice.pending.prefix)).toEqual([])
    storeB.close()
  })

  it('device A ack does not touch device B', () => {
    const store = openStore()
    const outbox = new PushOutbox({}, storeNoticeStore(store))
    outbox.keep(msg({ deviceId: A, body: 'A 的' }))
    outbox.keep(msg({ deviceId: B, body: 'B 的' }))
    const idsA = outbox.peek(A).map(item => item.id)
    expect(outbox.ack(A, idsA)).toBe(1)
    expect(outbox.peek(A)).toEqual([])
    expect(outbox.peek(B)).toHaveLength(1)
    expect(outbox.peek(B)[0]!.body).toBe('B 的')
    store.close()
  })

  it('restores the same per-kind merge / CAP semantics from disk', () => {
    const store = openStore()
    const outbox = new PushOutbox({ cap: 3 }, storeNoticeStore(store))
    for (let index = 0; index < 6; index++) outbox.keep(msg({ kind: undefined, body: `第 ${index} 条` }))
    // CAP：只留最新三条，且能从同一个 DB 的新实例读回。
    const reopened = new PushOutbox({ cap: 3 }, storeNoticeStore(openStorePreserving()))
    expect(reopened.peek(A).map(item => item.body)).toEqual(['第 3 条', '第 4 条', '第 5 条'])
    store.close()
  })

  it('expires on TTL and prunes the expired entry from disk', () => {
    let now = 1_000
    const store = openStore()
    const outbox = new PushOutbox({ now: () => now }, storeNoticeStore(store))
    outbox.keep(msg())
    expect(outbox.depth(A)).toBe(1)
    now += QUEUE_TTL_MS + 1
    // peek 触发 TTL 清理：内存与盘都同步删掉（不留只在内存里过期的假象）。
    expect(outbox.peek(A)).toEqual([])
    const reopened = new PushOutbox({ now: () => now }, storeNoticeStore(openStorePreserving()))
    expect(reopened.depth(A)).toBe(0)
    expect(store.keys(KV.notice.pending.prefix)).toEqual([])
    store.close()
  })

  it('a Store that already holds the cap keeps the newest and drops the oldest', () => {
    const store = openStore()
    const outbox = new PushOutbox({}, storeNoticeStore(store))
    for (let index = 0; index < MAX_QUEUE_PER_DEVICE + 4; index++) deliver(msg({ kind: undefined, body: `第 ${index} 条` }), { online: false, outbox })
    expect(outbox.depth(A)).toBe(MAX_QUEUE_PER_DEVICE)
    // 最新一条一定在；最旧那条被挤掉。
    const bodies = outbox.peek(A).map(item => item.body)
    expect(bodies.at(-1)).toBe(`第 ${MAX_QUEUE_PER_DEVICE + 3} 条`)
    expect(bodies).not.toContain('第 0 条')
    store.close()
  })
})

describe('honest failure: a Store write that throws must not report success', () => {
  const failingStore = (): NoticeStore => {
    const real = openStore()
    const adapter = storeNoticeStore(real)
    return { get: adapter.get, devices: adapter.devices, delete: adapter.delete,
      set: () => { throw new Error('disk full (fixture)') } }
  }

  it('keep throws instead of returning a depth', () => {
    const outbox = new PushOutbox({}, failingStore())
    expect(() => outbox.keep(msg())).toThrow(/disk full/)
    // 内存不该在写盘失败后被改成「已留件」的假象：depth 仍读盘，读到空。
    expect(outbox.depth(A)).toBe(0)
  })

  it('deliver throws rather than claiming queued', () => {
    const outbox = new PushOutbox({}, failingStore())
    expect(() => deliver(msg(), { online: false, outbox })).toThrow(/disk full/)
  })

  it('ack throws rather than claiming it removed', () => {
    // 先在一份 DB 里正常留两条不同内容，再换一个读到同一份盘、但写盘会失败的后端，验证 ack 抛出而非谎报。
    const seedStore = openStore()
    const seed = new PushOutbox({}, storeNoticeStore(seedStore))
    seed.keep(msg({ body: '一', kind: 'followup' }))
    seed.keep(msg({ body: '二', kind: 'routine' }))
    seedStore.close()
    const reader = openStorePreserving()
    const stored = reader.get(KV.notice.pending(A))!
    expect(stored).toHaveLength(2)
    // 只点两条里的一条：删一条后剩一条 → 写回（set）被调用 → 抛出，绝不吞成「已删」。
    const outbox = new PushOutbox({}, { ...storeNoticeStore(reader), set: () => { throw new Error('disk full (fixture)') } })
    expect(() => outbox.ack(A, [stored[0]!.id])).toThrow(/disk full/)
  })
})

describe('Runtime wiring (no lingering in-memory-only outbox)', () => {
  it('shares one durable pending family with the Store it is constructed with', () => {
    // 直接演练 Runtime 里那段接法：Store 就绪 → new PushOutbox({}, storeNoticeStore(store))。
    const now = 2_000
    const store = openStore()
    const outbox = new PushOutbox({ now: () => now }, storeNoticeStore(store))
    outbox.keep(msg({ body: '新链以后入队的一条' }))
    // 同一个 Store 的 KV 上确实落了键，值里带稳定 id（证明不是只活在内存 Map）。
    const raw = store.get(KV.notice.pending(A))
    expect(raw).toHaveLength(1)
    expect(raw![0]!.id).toBe(noticeId(msg({ body: '新链以后入队的一条' })))
    store.close()
  })

  it('a genuinely empty new DB reads as empty (no faked old data)', () => {
    const store = openStore()
    const outbox = new PushOutbox({}, storeNoticeStore(store))
    expect(outbox.peek(A)).toEqual([])
    expect(store.get(KV.notice.pending(A))).toBeUndefined()
    store.close()
  })
})

/** 打开同一 SQLite 文件的新 Store，模拟实例重建后重新读到同一份盘。 */
function openStorePreserving(): Store {
  return new Store(join(directory, 'orchestrator.sqlite'))
}
