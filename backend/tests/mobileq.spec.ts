/**
 * 网关真实 SQLite / HTTP 的 kind 管线（task-15）。
 *
 * 证据都是**真的**：临时 mobileq.db、真的 `mobileq` CLI 写、真的 `mobilegw` 进程读，
 * 不碰生产库与 token；目录 mkdtemp 起、afterAll 清掉。
 *
 * 钉住四件事：
 *  1. `mobileq reply --kind` 落库；省略 `--kind` 保持 NULL（legacy，不回填推断值）。
 *  2. 非法 `--kind` 写前就拒（不让手机把回执读成最终答复）。
 *  3. `/timeline` 的 agent 条目带 `reply_kind`；历史 NULL 行**不带**该字段。
 *  4. `/meta` 只回 id / request_id / read_at / answered / acknowledged（无正文），`&row=` 点名包含老行。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MOBILEQ = fileURLToPath(new URL('../tools/mobileq', import.meta.url))
const MOBILEGW = fileURLToPath(new URL('../tools/mobilegw', import.meta.url))

let stateDir = ''
let state = ''
let db = ''
let origin = ''
let token = ''
let gateway: ChildProcess | undefined

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = address && typeof address === 'object' ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

/** `--db` 是顶层参数（在子命令之前），与 Source 的调用形状一致。 */
const q = (...args: string[]): string => execFileSync('python3', [MOBILEQ, '--db', db, ...args], { encoding: 'utf8' })

beforeAll(async () => {
  stateDir = mkdtempSync(join(tmpdir(), 'mobile-kind-'))
  state = join(stateDir, 'state', 'superagent')
  // 显式 `--db` 时 CLI 不建父目录（它只在 $DSH_HOME 缺省路径下建），这里自己起。
  mkdirSync(state, { recursive: true })
  db = join(state, 'mobileq.db')
  const port = await freePort()
  origin = `http://127.0.0.1:${port}`
  // 先让 CLI 建库（CLI 与网关各自跑同一段迁移，谁先都一样）。
  q('inject', '--conversation', 'main', '--sender', 'owner', '--text', '在吗')
  gateway = spawn('python3', [MOBILEGW], {
    env: { ...process.env, DSH_HOME: stateDir, MOBILEGW_STATE: state, MOBILEGW_HOST: '127.0.0.1',
      MOBILEGW_PORT: String(port), PYTHONUNBUFFERED: '1' },
    stdio: 'ignore',
  })
  for (let attempt = 0; attempt < 120; attempt++) {
    try { if ((await fetch(`${origin}/health`)).ok) break } catch { /* not up yet */ }
    if (gateway.exitCode !== null) throw new Error(`mobilegw exited early (${gateway.exitCode})`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  token = readFileSync(join(state, 'mobilegw.token'), 'utf8').trim()
}, 30_000)

afterAll(() => {
  gateway?.kill('SIGTERM')
  if (stateDir) rmSync(stateDir, { recursive: true, force: true })
})

const get = async (path: string): Promise<Response> => fetch(`${origin}${path}`, { headers: { 'X-GW-Token': token } })
const send = async (session: string, text: string, requestId: string): Promise<Response> => fetch(
  `${origin}/send?session_id=${session}`, { method: 'POST', headers: { 'X-GW-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, request_id: requestId }) })

describe('mobileq reply --kind 落库', () => {
  it('写的类型读得回来；省略类型保持 NULL（legacy 不回填）', () => {
    q('reply', '--conversation', 'main', '--to', '1', '--key', 'k-typed', '--text', '收到', '--kind', 'acknowledgement')
    q('reply', '--conversation', 'main', '--to', '1', '--key', 'k-legacy', '--text', '早年的回话')
    const outbox = JSON.parse(q('outbox', '--conversation', 'main', '--json')) as
      { items: { key: string; reply_kind?: string }[] }
    const typed = outbox.items.find(item => item.key === 'k-typed')
    const legacy = outbox.items.find(item => item.key === 'k-legacy')
    expect(typed?.reply_kind).toBe('acknowledgement')
    // 省略就是缺：不是 'reply'，也不是空串。
    expect(legacy?.reply_kind).toBeUndefined()
  })

  it('非法类型写前就拒，且不留半条记录', () => {
    expect(() => q('reply', '--conversation', 'main', '--to', '1', '--key', 'k-bad', '--text', 'x', '--kind', 'final')).toThrow()
    const outbox = JSON.parse(q('outbox', '--conversation', 'main', '--json')) as { items: { key: string }[] }
    expect(outbox.items.some(item => item.key === 'k-bad')).toBe(false)
  })
})

describe('网关 HTTP 面', () => {
  it('/timeline 的 agent 条目带 reply_kind；历史 NULL 行不带该字段', async () => {
    const body = await (await get('/timeline?session_id=main')).json() as
      { items: { id: string; role: string; text?: string; reply_kind?: string }[] }
    const typed = body.items.find(item => item.role === 'agent' && item.text === '收到')
    const legacy = body.items.find(item => item.role === 'agent' && item.text === '早年的回话')
    expect(typed?.reply_kind).toBe('acknowledgement')
    expect(legacy).toBeDefined()
    // 关键：不猜。字段缺席，客户端因此不宣称「已回复」。
    expect(legacy && 'reply_kind' in legacy).toBe(false)
  })

  it('/meta 只回关联所需的元数据，不含正文', async () => {
    // `inject` 造的行没有 request_id（它是扫码/测试入口）；`/send` 才是手机真正走的那条，
    // 也只有它带的 request_id 值得被关联。用真 HTTP 写一条。
    const sent = await send('main', '这条要能被活动端点关联', 'rid-meta-1')
    expect(sent.status).toBe(200)
    const body = await (await get('/meta?session_id=main')).json() as
      { items: Record<string, unknown>[]; session_id: string; session_api: number }
    expect(body.session_id).toBe('main')
    expect(body.session_api).toBe(1)
    const row = body.items.find(item => item.request_id === 'rid-meta-1')
    expect(row).toBeDefined()
    expect(row?.read_at).toBeDefined()
    // 轻量端点不得为了活动去读消息正文：连 text 这个键都不该出现。
    expect(row && 'text' in row).toBe(false)
    // 那条消息挂着一句回执（acknowledgement，reply 到 m1）——不是最终答复。
    expect(row?.acknowledged).toBe(false)
  })

  it('/meta 的 &row= 点名能带回最近窗口之外的老行', async () => {
    // 先发一条会被挤出窗口的，再发 60 条把它推到「最近 50 条」之外。
    expect((await send('main', '很久以前的一条', 'rid-old')).status).toBe(200)
    const old = await (await get('/meta?session_id=main')).json() as { items: { id: string; request_id?: string }[] }
    const oldRow = old.items.find(item => item.request_id === 'rid-old')!
    const oldNumber = oldRow.id.replace(/^m/, '')
    for (let index = 0; index < 60; index++) await send('main', `后续 ${index}`, `rid-fill-${index}`)
    const recent = await (await get('/meta?session_id=main')).json() as { items: { id: string }[] }
    expect(recent.items.some(item => item.id === oldRow.id)).toBe(false)
    // 点名之后老行回来：活跃票不该因为「不在最近 N 条里」而从快照里消失。
    const named = await (await get(`/meta?session_id=main&row=${oldNumber}`)).json() as { items: { id: string }[] }
    expect(named.items.some(item => item.id === oldRow.id)).toBe(true)
  })

  it('重新登记 request_id 后 /meta 把它带回来，且不串到别的会话', async () => {
    expect((await send('work', '工作会话里的一条', 'rid-work-1')).status).toBe(200)
    const work = await (await get('/meta?session_id=work')).json() as { items: { request_id?: string }[] }
    expect(work.items.map(item => item.request_id)).toContain('rid-work-1')
    const main = await (await get('/meta?session_id=main')).json() as { items: { request_id?: string }[] }
    expect(main.items.map(item => item.request_id)).not.toContain('rid-work-1')
  })
})
