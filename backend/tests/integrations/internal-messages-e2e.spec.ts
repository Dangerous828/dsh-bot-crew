/**
 * 内部 desktop/mobile 消息 —— 真实投递链接通（task-2，用户 22:20 澄清收窄；非 JSON 台架）。
 *
 * 这条测试把**生产真用的投递链**接起来，不 mock 存储：
 *   Outbox.send(message)  → 真 Store(receipts) + 真 Effects → Outbox.deliver
 *     → 真 SourceRegistry.send → mobileKind.channel.send = sendMobile
 *     → commands.run('mobileq', ['reply', ...])（真 tools/mobileq CLI，真临时 mobileq.db）
 *     → replies 表新增一行（= /api/mobile/timeline 客户端聊天可见的那条）
 *
 * 断言用 sqlite3 直读 `replies` 作为独立真值。拒/停链路：source 未启用 → outbox 不投递 → replies 不新增。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from '../../src/app/store.ts'
import { Effects } from '../../src/app/effects.ts'
import { Outbox } from '../../src/app/outbox.ts'
import { SourceRegistry } from '../../src/sources/registry.ts'
import { mobileKind } from '../../src/sources/mobile.ts'
import { HealthBoard } from '../../src/infra/health.ts'
import { Commands } from '../../src/infra/commands.ts'
import { SettingsSchema } from '../../src/policy.ts'
import type { OutboundMessage } from '../../src/core/index.ts'

const CLI = fileURLToPath(new URL('../../tools/mobileq', import.meta.url))

/** sqlite 直读真值。 */
const sql = (db: string, query: string): string =>
  execFileSync('python3', ['-c', `import sqlite3,sys,json;c=sqlite3.connect(sys.argv[1]);print(json.dumps(c.execute(sys.argv[2]).fetchall()))`, db, query], { encoding: 'utf8' }).trim()
const rowCount = (db: string, table: string): number => (JSON.parse(sql(db, `SELECT count(*) FROM ${table}`)) as number[][])[0]![0]!

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

/** 真投递链：真 Store/Effects/Outbox/SourceRegistry + mobileKind + 真 CLI 指向临时 db。 */
function chain(db: string, enabled: boolean) {
  const home = mkdtempSync(join(tmpdir(), 'internal-msg-chain-')); dirs.push(home)
  const store = new Store(join(home, 'store.sqlite'))
  const effects = new Effects(store, new HealthBoard())
  effects.start()
  const settings = () => SettingsSchema.parse({ sources: { mobile: { enabled, config: { conversations: [{ id: 'main', listen: 'all' }], pollSeconds: 5 } } } })
  const sources = new SourceRegistry(settings)
  sources.register(mobileKind)
  // 真 Commands：run 落到真 CLI，--db 指向临时 db，deployment.stateDir 也指过去（sendMobile 从不读它，但保持同源）。
  const commands = new Commands(() => ({ stateDir: db.replace(/\/[^/]+$/, '') } as never), {}, new AbortController().signal)
  const run = commands.run.bind(commands)
  ;(commands as unknown as { run: (p: string, a: string[]) => Promise<string> }).run =
    (program, args) => program === 'mobileq' ? run('python3', [CLI, '--db', db, ...args]) : run(program, args)
  const outbox = new Outbox({
    store, effects, sources, commands, paused: () => false,
  } as never)
  return { store, effects, sources, commands, outbox }
}

function mobileReply(db: string, text: string, messageId: string, id = 'reply-1'): OutboundMessage {
  return { id, text, kind: 'reply',
    channel: { source: 'mobile', thread: `mobile:main:${messageId}`, address: { conversation: 'main', message: messageId } } }
}

/** The id of the last injected message — the real parent a reply must hang under (never a guessed literal). */
function lastMessageId(db: string): string {
  const rows = JSON.parse(sql(db, 'SELECT max(id) FROM messages')) as number[][]
  return String(rows[0]![0]!)
}

describe('内部消息真实投递链：Outbox → sendMobile → 真 mobileq.db', () => {
  it('队伍回话经真投递链落 replies 表（客户端 timeline 可见那一行）', async () => {
    const db = join(mkdtempSync(join(tmpdir(), 'internal-msg-db-')), 'mobileq.db'); dirs.push(join(db, '..'))
    execFileSync('python3', [CLI, '--db', db, 'inject', '--conversation', 'main', '--sender', 'owner', '--text', '需要回话'])
    const parent = lastMessageId(db)
    const { outbox, store } = chain(db, true)
    expect(rowCount(db, 'replies')).toBe(0)
    outbox.send(mobileReply(db, '这是队伍的回话', parent))
    await outbox.sent()
    const rows = JSON.parse(sql(db, 'SELECT text, to_msg, conversation FROM replies')) as [string, number, string][]
    expect(rows).toEqual([['这是队伍的回话', Number(parent), 'main']])
    // receipt 结算为 sent（不是挂起）。
    expect(store.receipts.get('reply-1')?.status).toBe('sent')
    store.close()
  })

  it('拒/停：source 未启用 → 消息停在 outbox，replies 表不新增（真实存储没被写）', async () => {
    const db = join(mkdtempSync(join(tmpdir(), 'internal-msg-db-')), 'mobileq.db'); dirs.push(join(db, '..'))
    execFileSync('python3', [CLI, '--db', db, 'inject', '--conversation', 'main', '--sender', 'owner', '--text', '不该被回'])
    const parent = lastMessageId(db)
    const { outbox, store } = chain(db, false)
    expect(rowCount(db, 'replies')).toBe(0)
    outbox.send(mobileReply(db, '不该发出去', parent))
    // 给 effect 一拍时间尝试；source off 会 Later 重试而非投递。
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(rowCount(db, 'replies')).toBe(0)
    expect(store.receipts.get('reply-1')?.status).toBe('pending')
    store.close()
  })
})
