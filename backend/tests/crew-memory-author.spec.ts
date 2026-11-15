import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthorMirror } from '../src/memory/author.ts'
import type { MemoryEntry } from '../src/memory/recall.ts'

const entry = (over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  name: 'bot-lead-person-以后都用-pnpm', description: '以后都用 pnpm',
  body: '主人原话：「以后都用 pnpm，不要用 npm」', type: 'feedback', status: 'candidate',
  importance: 5, toHub: true, dedupe_key: 'person:以后都用-pnpm', created: 1794700000, updated: 1794700000,
  bot_id: 'lead', origin: 'person:owner', state: 'active', ...over,
})
let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'author-mirror-')) })
afterEach(() => rmSync(root, { recursive: true, force: true }))
const fileOf = (e: MemoryEntry): string => join(root, 'bot', e.bot_id, `${e.name}.md`)
const SF = 'bot-lead-person-以后都用-pnpm.md'

describe('publish — 裁定C：默认不落盘，仅显式 toHub=true 才写', () => {
  it('toHub=true 落盘，frontmatter 与产品 renderMarkdown 一致', async () => {
    const m = new AuthorMirror({ root }); const r = await m.publish(entry()); expect(r.written).toBe(true)
    const t = readFileSync(fileOf(entry()), 'utf8')
    expect(t.startsWith('---\n')).toBe(true)
    expect(t).toContain('name: bot-lead-person-以后都用-pnpm')
    expect(t).toContain('dedupe_key: "person:以后都用-pnpm"')
    expect(t).toContain('主人原话')
  })
  it('toHub=false（settle 默认）不落盘，即使 origin=person:owner type=feedback 也不自动分享', async () => {
    const m = new AuthorMirror({ root })
    const r = await m.publish(entry({ toHub: false }))
    expect(r.written).toBe(false); expect(existsSync(join(root, 'bot', 'lead'))).toBe(false)
  })
  it('敏感粗筛命中（Bearer/KEY=value 样式）即使 toHub=true 也不落盘', async () => {
    const m = new AuthorMirror({ root })
    const r = await m.publish(entry({ toHub: true, body: '导出现在用 Bearer abcdefghijklmnop 走' }))
    expect(r.written).toBe(false); expect(r.sensitive).toBe(true); expect(existsSync(join(root, 'bot', 'lead'))).toBe(false)
  })
  it('正常项目事实（含路径/单词 token 但不是凭据值）不被误伤', async () => {
    const m = new AuthorMirror({ root })
    const r = await m.publish(entry({ toHub: true, body: '这个 token 管理器在 /opt/data/foo 下跑，测试通过' }))
    expect(r.written).toBe(true) // 「token 管理器」不是 KEY=value 样式，不误伤
  })
  it('幂等：同内容重复 publish 不重写', async () => {
    const m = new AuthorMirror({ root }); await m.publish(entry()); const p = fileOf(entry()); const before = readFileSync(p, 'utf8')
    await new Promise(r => setTimeout(r, 5)); const again = await m.publish(entry())
    expect(again.written).toBe(false); expect(readFileSync(p, 'utf8')).toBe(before)
  })
})

describe('forget — 双保险（md disabled + 远端按 source_file 撤全部 live 版本）', () => {
  it('forget 后 md disabled:true，正文保留', async () => {
    const m = new AuthorMirror({ root }); await m.publish(entry()); await m.forget(entry().name, 'lead')
    const t = readFileSync(fileOf(entry()), 'utf8'); expect(t).toMatch(/^disabled: true$/m); expect(t).toContain('主人原话')
  })
  it('forget 调 bySourceFile（namespace + md 文件名），不是 ledger 业务 dedupe_key', async () => {
    const bySourceFile = vi.fn().mockResolvedValue({ ok: true, deleted: 2, matched: 2, ids: ['a', 'b'] })
    const m = new AuthorMirror({ root, retract: { bySourceFile } }); await m.publish(entry())
    const r = await m.forget(entry().name, 'lead')
    expect(bySourceFile).toHaveBeenCalledWith({ namespace: 'dsh-memory/bot', sourceFile: SF })
    expect(r.retracted).toEqual({ ok: true, deleted: 2, matched: 2, ids: ['a', 'b'] })
  })
  it('md 不存在仍撤远端（幂等零条无害）', async () => {
    const bySourceFile = vi.fn().mockResolvedValue({ ok: true, deleted: 0, matched: 0 })
    const m = new AuthorMirror({ root, retract: { bySourceFile } })
    const r = await m.forget('bot-lead-nope', 'lead'); expect(r.ok).toBe(true); expect(bySourceFile).toHaveBeenCalled()
  })
  it('远端撤失败可观察：retractError 但 md disabled 已生效', async () => {
    const bySourceFile = vi.fn().mockRejectedValue(new Error('hub 503'))
    const m = new AuthorMirror({ root, retract: { bySourceFile } }); await m.publish(entry())
    const r = await m.forget(entry().name, 'lead')
    expect(r.retractError).toBeInstanceOf(Error); expect(readFileSync(fileOf(entry()), 'utf8')).toMatch(/^disabled: true$/m)
  })
})

describe('supersede / evict', () => {
  it('supersede 旧 md status:superseded 且撤旧源', async () => {
    const bySourceFile = vi.fn().mockResolvedValue({ ok: true, deleted: 1, matched: 1 })
    const m = new AuthorMirror({ root, retract: { bySourceFile } }); await m.publish(entry())
    const r = await m.supersede(entry().name, 'lead')
    expect(readFileSync(fileOf(entry()), 'utf8')).toMatch(/^status: superseded$/m)
    expect(bySourceFile).toHaveBeenCalledWith({ namespace: 'dsh-memory/bot', sourceFile: SF }); expect(r.retracted?.deleted).toBe(1)
  })
  it('evict 真删 md 且撤全部版本', async () => {
    const bySourceFile = vi.fn().mockResolvedValue({ ok: true, deleted: 2, matched: 2 })
    const m = new AuthorMirror({ root, retract: { bySourceFile } }); await m.publish(entry())
    const r = await m.evict(entry().name, 'lead')
    expect(existsSync(fileOf(entry()))).toBe(false)
    expect(bySourceFile).toHaveBeenCalledWith({ namespace: 'dsh-memory/bot', sourceFile: SF }); expect(r.retracted?.deleted).toBe(2)
  })
})

describe('edit — 内容变化重写 md，按 keepDigest 撤旧版本、保留新版本', () => {
  it('edit 内容变化：md 更新为新正文', async () => {
    const m = new AuthorMirror({ root }); await m.publish(entry())
    const r = await m.edit(entry({ body: '主人原话：「以后都用 pnpm，别用 npm」', updated: 1794700100 }))
    expect(r.written).toBe(true); expect(readFileSync(fileOf(entry()), 'utf8')).toContain('别用 npm')
  })
  it('edit 传 keepDigest：bySourceFile 收到 keepDigest（保留新版本行不删）', async () => {
    const bySourceFile = vi.fn().mockResolvedValue({ ok: true, deleted: 1, matched: 2 })
    const m = new AuthorMirror({ root, retract: { bySourceFile } }); await m.publish(entry())
    // 模拟 toHub 变 false+edit 触发撤（或显式撤旧）——用 publish(toHub=false) 走 keepDigest 分支
    const r = await m.publish(entry({ toHub: false }), { keepDigest: 'newdigest16hex00' })
    expect(bySourceFile).toHaveBeenCalledWith({ namespace: 'dsh-memory/bot', sourceFile: SF, keepDigest: 'newdigest16hex00' })
    expect(r.retracted?.deleted).toBe(1)
  })
})

describe('apply — 统一生命周期', () => {
  it('publish→forget→evict 全链路同步 md 且撤远端', async () => {
    const bySourceFile = vi.fn().mockResolvedValue({ ok: true, deleted: 1, matched: 1 })
    const m = new AuthorMirror({ root, retract: { bySourceFile } })
    await m.apply({ kind: 'publish', entry: entry() }); expect(existsSync(fileOf(entry()))).toBe(true)
    await m.apply({ kind: 'forget', name: entry().name, botId: 'lead' })
    expect(readFileSync(fileOf(entry()), 'utf8')).toMatch(/^disabled: true$/m)
    await m.apply({ kind: 'evict', name: entry().name, botId: 'lead' }); expect(existsSync(fileOf(entry()))).toBe(false)
    expect(bySourceFile).toHaveBeenCalledTimes(2)
  })
})

describe('forget — 原子 tombstone 占位（防未入库旧 pending 首次上行复活）', () => {
  it('forget 传 entry：先 tombstoneByDigests（known digests 含当前+历史）再 bySourceFile', async () => {
    const order: string[] = []
    const tombstoneByDigests = vi.fn(async (_input: { namespace: string; sourceFile: string; knownDigests: string[] }) => { order.push('tombstone'); return { ok: true, placed: ['d1'], alreadyRetracted: [], softDeleted: [], conflicts: [] } })
    const bySourceFile = vi.fn(async () => { order.push('bySourceFile'); return { ok: true, deleted: 1, matched: 1 } })
    // digestsOf 返回历史（含旧版本），当前 entry 的 digest 也会被并入
    const m = new AuthorMirror({ root, retract: { bySourceFile, tombstoneByDigests }, digestsOf: () => ['old1hex', 'old2hex'] })
    await m.publish(entry())
    const r = await m.forget(entry().name, 'lead', entry())
    expect(order).toEqual(['tombstone', 'bySourceFile'])
    expect(r.tombstoned).toBe(true)
    const arg = tombstoneByDigests.mock.calls[0]![0]
    expect(arg.namespace).toBe('dsh-memory/bot')
    expect(arg.sourceFile).toBe(SF)
    expect(arg.knownDigests).toEqual(expect.arrayContaining(['old1hex', 'old2hex']))
  })
  it('conflicts 非空 → retractError（可观察、不误删）', async () => {
    const tombstoneByDigests = vi.fn(async () => { throw new Error('retract-tombstone conflicts (409): x') })
    const bySourceFile = vi.fn(async () => ({ ok: true, deleted: 0, matched: 0 }))
    const m = new AuthorMirror({ root, retract: { bySourceFile, tombstoneByDigests }, digestsOf: () => ['h'] })
    await m.publish(entry())
    const r = await m.forget(entry().name, 'lead', entry())
    expect(r.retractError).toBeInstanceOf(Error)
    expect(readFileSync(fileOf(entry()), 'utf8')).toMatch(/^disabled: true$/m)
  })
})

describe('撤回失败持久待重试（真 Store/ledger，非纯类返回）', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'author-store-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  it('record → list → clear 落真 KV，重启后仍在（新 ledger 同库可读）', async () => {
    const { Store } = await import('../src/app/store.ts')
    const { MemoryLedger } = await import('../src/app/memory.ts')
    const dbPath = join(dir, 'orchestrator.sqlite')
    const store = new Store(dbPath)
    const ledger = new MemoryLedger(store)
    ledger.recordRetractPending('bot-lead-x', { botId: 'lead', digests: ['h1', 'h2'], error: 'hub 503' })
    expect(ledger.listRetractPending()).toEqual([{ name: 'bot-lead-x', item: { botId: 'lead', digests: ['h1', 'h2'], at: expect.any(Number), attempts: 1, lastError: 'hub 503' } }])
    store.close()
    // 重启：新 Store 同库仍读得到（持久化证据）
    const store2 = new Store(dbPath)
    const ledger2 = new MemoryLedger(store2)
    const pending = ledger2.listRetractPending()
    expect(pending).toHaveLength(1)
    expect(pending[0]!.name).toBe('bot-lead-x')
    expect(pending[0]!.item.digests).toEqual(['h1', 'h2'])
    // 累加 attempts + 合并 digests
    ledger2.recordRetractPending('bot-lead-x', { botId: 'lead', digests: ['h3'], error: 'hub 503 again' })
    const again = ledger2.listRetractPending()[0]!.item
    expect(again.attempts).toBe(2)
    expect(again.digests).toEqual(['h1', 'h2', 'h3'])
    ledger2.clearRetractPending('bot-lead-x')
    expect(ledger2.listRetractPending()).toEqual([])
    store2.close()
  })
})
