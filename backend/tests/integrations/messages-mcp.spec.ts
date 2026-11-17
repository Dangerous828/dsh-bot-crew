/**
 * 内部 desktop/mobile 消息 adapter —— 真实 `mobileq.db` 端到端测试（task-2，用户 22:20 澄清收窄）。
 *
 * 这不再验「本地 JSON 信箱台架」，而是验**真实产品存储**：
 *   - 真 spawn `src/integrations/messages-mcp/server.ts`，MCP JSON-RPC over stdio；
 *   - 它的 store 是**一个真实临时 `mobileq.db`**（用真 `tools/mobileq` CLI 灌 canary / 读回），
 *     不是另起的 JSON 文件；
 *   - 断言用 `sqlite3` 直读 `messages` / `replies` 表作为**独立真值**（不经 adapter，避免同义反复）；
 *   - 再把 `connections.ts` 的 `allowedTools` / `judgeCall` 套在它注册的工具名上：读 allow、写 ask。
 *
 * 会话面纪律（与 wb2-receive 冻结）：写回复只落 `replies`（server→client），
 * **不写 `messages`**（mobile Source 只 pull messages，故不触发 worker 自循环，下有用例钉住）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { allowedTools, connectionsOf, judgeCall } from '../../src/app/connections.ts'

const SERVER = fileURLToPath(new URL('../../src/integrations/messages-mcp/server.ts', import.meta.url))
const CLI = fileURLToPath(new URL('../../tools/mobileq', import.meta.url))

/** 直读真实 sqlite 的独立真值（不经 adapter）。 */
function sql(db: string, query: string): string {
  return execFileSync('python3', ['-c',
    `import sqlite3,sys,json;c=sqlite3.connect(sys.argv[1]);print(json.dumps(c.execute(sys.argv[2]).fetchall()))`,
    db, query], { encoding: 'utf8' }).trim()
}
/** 每 seed 一次单独起 python3 太慢（600 次≈30s）：一个 python3 进程里循环注入，同效。 */
function seed(db: string, count: number, text: (i: number) => string): void {
  const script = [
    'import sqlite3,sys,json',
    'db, n, texts = sys.argv[1], int(sys.argv[2]), json.loads(sys.argv[3])',
    'c = sqlite3.connect(db)',
    'c.execute("CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT, conversation TEXT NOT NULL, thread INTEGER, sender TEXT NOT NULL, bot INTEGER DEFAULT 0, mentions_me INTEGER DEFAULT 0, text TEXT NOT NULL, at TEXT NOT NULL, url TEXT, reply_to INTEGER, mentions TEXT)")',
    'for i, t in enumerate(texts):',
    '    c.execute("INSERT INTO messages(conversation,thread,sender,bot,mentions_me,mentions,text,at,reply_to) VALUES(?,?,?,?,?,?,?,?,?)", ("main", None, "owner", 0, 0, "", t, "2026-01-01T00:00:00+0800", None))',
    'c.commit()',
  ].join('\n')
  const texts = Array.from({ length: count }, (_, i) => text(i))
  execFileSync('python3', ['-c', script, db, String(count), JSON.stringify(texts)], { encoding: 'utf8' })
}
function cli(db: string, args: string[]): void {
  execFileSync('python3', [CLI, '--db', db, ...args], { encoding: 'utf8' })
}

/** 最小 MCP stdio 客户端：按行发 JSON-RPC，按 id 等回包。 */
class StdioClient {
  private nextId = 1
  private buffer = ''
  private pending = new Map<number, (value: Record<string, unknown>) => void>()
  private child: ChildProcessWithoutNullStreams

  constructor(dbPath: string) {
    this.child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, MESSAGES_MCP_DB: dbPath, MESSAGES_MCP_CLI: CLI },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => this.onData(chunk))
  }
  private onData(chunk: string): void {
    this.buffer += chunk
    let index: number
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (!line) continue
      const message = JSON.parse(line) as Record<string, unknown>
      const id = message.id as number | null
      if (typeof id === 'number') {
        const resolve = this.pending.get(id)
        if (resolve) { this.pending.delete(id); resolve(message) }
      }
    }
  }
  private send(message: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.nextId++
    const body = { jsonrpc: '2.0', id, ...message }
    return new Promise(resolve => { this.pending.set(id, resolve); this.child.stdin.write(JSON.stringify(body) + '\n') })
  }
  async initialize(): Promise<Record<string, unknown>> {
    const response = await this.send({ method: 'initialize', params: { protocolVersion: '2024-11-05' } })
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    return response
  }
  async listTools(): Promise<string[]> {
    const response = await this.send({ method: 'tools/list' })
    return ((response.result as Record<string, unknown>).tools as Array<{ name: string }>).map(t => t.name)
  }
  async callTool(name: string, args: Record<string, unknown>): Promise<{ result: unknown; isError: boolean; text: string }> {
    const response = await this.send({ method: 'tools/call', params: { name, arguments: args } })
    const result = response.result as { content: Array<{ text: string }>; isError?: boolean }
    const text = result.content[0]!.text
    // Error results carry a plain "Name: message" string (isError:true), not JSON — hand it back untouched.
    if (result.isError === true) return { result: undefined, isError: true, text }
    return { result: JSON.parse(text), isError: false, text }
  }
  close(): void { this.child.kill() }
}

describe('内部消息 adapter：真实 mobileq.db 读 / 写 / 审批 / 拒后不执行 / 不自循环', () => {
  let dir: string
  let db: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'messages-adapter-e2e-'))
    db = join(dir, 'mobileq.db')
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('真进程 + 真队列：initialize/tools/list 暴露 4 个映射到真实存储的工具', async () => {
    const client = new StdioClient(db)
    try {
      const init = await client.initialize()
      expect(((init.result as Record<string, unknown>).serverInfo as { name: string }).name).toBe('messages')
      expect((await client.listTools()).sort()).toEqual(['get_message', 'list_channels', 'list_messages', 'send_message'])
    } finally { client.close() }
  })

  it('读真实 canary：真 CLI 注入的入站消息，adapter 从真实 db 读回同一会话', async () => {
    cli(db, ['inject', '--conversation', 'main', '--sender', 'owner', '--text', '真机 canary：读我这条'])
    const client = new StdioClient(db)
    try {
      await client.initialize()
      const channels = (await client.callTool('list_channels', {})).result as { id: string; messages: number }[]
      expect(channels.map(c => c.id)).toContain('main')
      const messages = (await client.callTool('list_messages', { channel: 'main' })).result as { role: string; text: string }[]
      expect(messages.some(m => m.role === 'user' && m.text === '真机 canary：读我这条')).toBe(true)
    } finally { client.close() }
  })

  it('写回复落 replies 表并出现在会话视图（客户端可见），且不新增 messages（不触发 worker 自循环）', async () => {
    cli(db, ['inject', '--conversation', 'main', '--sender', 'owner', '--text', '需要一张回话'])
    const msgId = (JSON.parse(sql(db, 'SELECT max(id) FROM messages')) as number[][])[0]![0]!
    const unreadBefore = (JSON.parse(sql(db, 'SELECT count(*) FROM messages WHERE read_at IS NULL')) as number[][])[0]![0]!
    const messagesBefore = (JSON.parse(sql(db, 'SELECT count(*) FROM messages')) as number[][])[0]![0]!

    const client = new StdioClient(db)
    let replyId: string | null
    try {
      await client.initialize()
      const sent = await client.callTool('send_message', { channel: 'main', to: `m${msgId}`, text: '这是队伍的回话', key: `k-main-${msgId}` })
      expect(sent.isError).toBe(false)
      const body = sent.result as { ok: boolean; visible_reply_id: string | null }
      expect(body.ok).toBe(true)
      replyId = body.visible_reply_id
      // 回话确实进了会话视图（/api/mobile/timeline 同源）。
      const messages = (await client.callTool('list_messages', { channel: 'main' })).result as { id: string; role: string; text: string }[]
      expect(messages.some(m => m.role === 'agent' && m.text === '这是队伍的回话')).toBe(true)
    } finally { client.close() }

    // 独立真值：replies 表真的新增一行；messages 表一行没多（写 reply 不碰 messages）。
    const replies = JSON.parse(sql(db, 'SELECT text,to_msg,kind FROM replies ORDER BY id DESC LIMIT 1')) as [string, number, string | null][]
    expect(replies[0]).toEqual(['这是队伍的回话', msgId, 'reply'])
    expect(replyId).toBeTruthy()
    expect((JSON.parse(sql(db, 'SELECT count(*) FROM messages')) as number[][])[0]![0]).toBe(messagesBefore)
    // 关键：未读（read_at IS NULL）条数不变 —— 没有把回话塞进 messages 队列、不制造新 Trigger。
    expect((JSON.parse(sql(db, 'SELECT count(*) FROM messages WHERE read_at IS NULL')) as number[][])[0]![0]).toBe(unreadBefore)
  })

  it('幂等：同一 key 的 send_message 只写一条（rkey UNIQUE），重放仍回报那条可见回话', async () => {
    // Real parent: a message that actually exists in `main` (never a guessed literal).
    cli(db, ['inject', '--conversation', 'main', '--sender', 'owner', '--text', '幂等用的父消息'])
    const parent = String((JSON.parse(sql(db, 'SELECT max(id) FROM messages')) as number[][])[0]![0]!)
    const seen: (string | null)[] = []
    for (let i = 0; i < 2; i++) {
      const client = new StdioClient(db)
      try {
        await client.initialize()
        const sent = await client.callTool('send_message', { channel: 'main', to: parent, text: '同一条回话', key: 'idem-1' })
        seen.push((sent.result as { visible_reply_id: string | null }).visible_reply_id)
      } finally { client.close() }
    }
    expect((JSON.parse(sql(db, "SELECT count(*) FROM replies WHERE rkey='idem-1'")) as number[][])[0]![0]).toBe(1)
    // 两次都回报同一条 r<N>（不是只有 200 但 visible id 为 null —— 那会让「客户端可见」无从核验）。
    expect(seen[0]).toBeTruthy()
    expect(seen[0]).toBe(seen[1])
  })

  it('同内容不同长度的长回话不撞键：截断不会把第十条长回话吞成重放', async () => {
    cli(db, ['inject', '--conversation', 'main', '--sender', 'owner', '--text', '长文用的父消息'])
    const parent = String((JSON.parse(sql(db, 'SELECT max(id) FROM messages')) as number[][])[0]![0]!)
    const head = 'x'.repeat(150)
    const client = new StdioClient(db)
    try {
      await client.initialize()
      const a = await client.callTool('send_message', { channel: 'main', to: parent, text: `${head}-A` })
      const b = await client.callTool('send_message', { channel: 'main', to: parent, text: `${head}-B` })
      const idA = (a.result as { visible_reply_id: string | null }).visible_reply_id
      const idB = (b.result as { visible_reply_id: string | null }).visible_reply_id
      expect(idA).toBeTruthy()
      expect(idB).toBeTruthy()
      expect(idA).not.toBe(idB)
    } finally { client.close() }
    expect((JSON.parse(sql(db, "SELECT count(*) FROM replies WHERE text LIKE '%-A'")) as number[][])[0]![0]).toBe(1)
    expect((JSON.parse(sql(db, "SELECT count(*) FROM replies WHERE text LIKE '%-B'")) as number[][])[0]![0]).toBe(1)
  })

  it('list_messages.limit：未传取 50、小数取整、超大封顶 500；显式非法值是清楚参数错误不静默回落', async () => {
    // 造 600 条，确认「超大 limit」真的被封在 500，而不是把整段历史拉回。
    const many = mkdtempSync(join(tmpdir(), 'messages-limit-'))
    const big = join(many, 'mobileq.db')
    try {
      seed(big, 600, i => `m${i}`)
      const client = new StdioClient(big)
      const size = async (limit?: number): Promise<number> => {
        const args: Record<string, unknown> = { channel: 'main' }
        if (limit !== undefined) args.limit = limit
        const r = await client.callTool('list_messages', args)
        return (r.result as unknown[]).length
      }
      const isErr = async (limit: unknown): Promise<boolean> =>
        (await client.callTool('list_messages', { channel: 'main', limit })).isError
      try {
        await client.initialize()
        expect(await size()).toBe(50)              // 未传 → 缺省 50
        expect(await size(3.9)).toBe(3)            // 小数取整
        expect(await size(10)).toBe(10)
        expect(await size(9e9)).toBe(500)          // 超大封顶 500
        // 显式非法值：清楚报参数错误，不是悄悄换成 50。
        expect(await isErr(-5)).toBe(true)         // 负数
        expect(await isErr(0)).toBe(true)          // 0
        expect(await isErr(Number.NaN)).toBe(true) // NaN
      } finally { client.close() }
    } finally { rmSync(many, { recursive: true, force: true }) }
  })

  it('get_message 精确主键：>500 历史的旧 id 仍命中；别的会话的 id 报不存在', async () => {
    const many = mkdtempSync(join(tmpdir(), 'messages-get-'))
    const big = join(many, 'mobileq.db')
    try {
      // main 造 600 条；第 1 条远在最近 500 窗口之外。work 造 1 条做跨会话对照。
      seed(big, 600, i => (i === 0 ? '最早的一条' : `m${i}`))
      cli(big, ['inject', '--conversation', 'work', '--sender', 'owner', '--text', 'work 里的'])
      const client = new StdioClient(big)
      try {
        await client.initialize()
        // m1 是最旧的，远超「最近 500」窗口——精确主键查得到，不能被窗口误报为不存在。
        const old = await client.callTool('get_message', { channel: 'main', id: 'm1' })
        expect(old.isError).toBe(false)
        expect((old.result as { text: string }).text).toBe('最早的一条')
        // work 的那条用 work 会话名查得到；但用 main 会话名查它 → 报不存在（会话过滤，不跨会话读）。
        const workId = (JSON.parse(sql(big, "SELECT id FROM messages WHERE conversation='work'")) as number[][])[0]![0]!
        const viaMain = await client.callTool('get_message', { channel: 'main', id: `m${workId}` })
        expect(viaMain.isError).toBe(true)
      } finally { client.close() }
    } finally { rmSync(many, { recursive: true, force: true }) }
  })

  it('send_message 回执在长历史下按 UNIQUE rkey 精确回 stable id（重放同文与并发同文都不错行/null）', async () => {
    const many = mkdtempSync(join(tmpdir(), 'messages-receipt-'))
    const big = join(many, 'mobileq.db')
    try {
      // 长历史：600 条。回执不应依赖「重拉整会话按 text 扫」。
      seed(big, 600, i => `m${i}`)
      const client = new StdioClient(big)
      const send = async (text: string, key?: string) => {
        const r = await client.callTool('send_message', { channel: 'main', to: '1', text, ...(key ? { key } : {}) })
        return r.result as { visible_reply_id: string | null; replayed?: boolean }
      }
      try {
        await client.initialize()
        const first = await send('重复正文')
        const replay = await send('重复正文')          // 同派生键重放（同正文 → 内容寻址天然重放）
        expect(first.visible_reply_id).toBeTruthy()
        expect(replay.visible_reply_id).toBe(first.visible_reply_id) // 重放回同一 stable id，不 null
        const a = await send('并发同文-A')
        const b = await send('并发同文-B')
        expect(a.visible_reply_id).not.toBe(b.visible_reply_id)       // 同文不撞，两行各自 stable
        // 显式 rkey：同 key 不同正文不得暗示新正文送达——必须标 replayed，且库中正文仍是第一条。
        const k1 = await send('原始正文', 'K-exp')
        const k2 = await send('不同正文', 'K-exp')
        expect(k1.replayed).toBeFalsy()
        expect(k2.replayed).toBe(true)                 // 明确是重放，不是新的
        expect(k2.visible_reply_id).toBe(k1.visible_reply_id) // 回原有行
        expect((JSON.parse(sql(big, "SELECT text FROM replies WHERE rkey='K-exp'")) as string[][])[0]![0]).toBe('原始正文')
      } finally { client.close() }
    } finally { rmSync(many, { recursive: true, force: true }) }
  })

  it('send_message 正文超传输上限（64KB）仍被如实报错，不落库', async () => {
    const before = (JSON.parse(sql(db, 'SELECT count(*) FROM replies')) as number[][])[0]![0]!
    const client = new StdioClient(db)
    try {
      await client.initialize()
      const sent = await client.callTool('send_message', { channel: 'main', to: '1', text: 'x'.repeat(70_000) })
      expect(sent.isError).toBe(true)
    } finally { client.close() }
    expect((JSON.parse(sql(db, 'SELECT count(*) FROM replies')) as number[][])[0]![0]).toBe(before)
  })

  it('send_message 的 to 只接受真实父消息：会话名/rN/负数/0/不存在/别会话来消息一律 isError 且零写；m<N> 与纯数字各 +1', async () => {
    // A real parent in `main`, and a real message that lives in `work` (foreign to main).
    cli(db, ['inject', '--conversation', 'main', '--sender', 'owner', '--text', '父消息 in main'])
    const mainParent = String((JSON.parse(sql(db, 'SELECT max(id) FROM messages')) as number[][])[0]![0]!)
    cli(db, ['inject', '--conversation', 'work', '--sender', 'owner', '--text', '别人的父消息 in work'])
    const workId = String((JSON.parse(sql(db, 'SELECT max(id) FROM messages')) as number[][])[0]![0]!)

    const before = (JSON.parse(sql(db, 'SELECT count(*) FROM replies')) as number[][])[0]![0]!
    const client = new StdioClient(db)
    try {
      await client.initialize()
      // Every one of these must be a parameter error (isError) and write ZERO rows.
      const bad: Array<string> = [
        'main',            // 会话名 —— 旧 bug 会削成 'ain' 落库；现在必须拒
        'work',            // 另一会话名
        'r1',              // 回话 id，不是入站消息
        '-3', '0', '007',  // 负数 / 0 / 前导零
        'abc', 'm',        // 非数字
        '999999',          // 不存在
        workId,            // 别会话的真实消息（foreign parent）
        `m${workId}`,      // 同上，带 m 前缀
      ]
      for (const to of bad) {
        const sent = await client.callTool('send_message', { channel: 'main', to, text: `非法 to=${to}` })
        expect(sent.isError, `to=${JSON.stringify(to)} must be isError`).toBe(true)
      }
      // 一个合法父：m<N> 前缀形式 +1。
      const ok1 = await client.callTool('send_message', { channel: 'main', to: `m${mainParent}`, text: '合法 m 前缀回话' })
      expect(ok1.isError).toBe(false)
      expect((ok1.result as { visible_reply_id: string | null }).visible_reply_id).toBeTruthy()
      // 同一合法父：纯数字形式 +1（不同正文 → 不同派生键）。
      const ok2 = await client.callTool('send_message', { channel: 'main', to: mainParent, text: '合法纯数字回话' })
      expect(ok2.isError).toBe(false)
      expect((ok2.result as { visible_reply_id: string | null }).visible_reply_id).toBeTruthy()
    } finally { client.close() }

    const after = (JSON.parse(sql(db, 'SELECT count(*) FROM replies')) as number[][])[0]![0]!
    // 10 个非法 to 全部零写；两次合法各 +1 → 净 +2。
    expect(after).toBe(before + 2)
    // 没有一条 reply 的 to_msg 是 'ain' / 会话名 / foreign —— 全部落在 main 的合法消息上。
    const badRows = (JSON.parse(sql(db, "SELECT count(*) FROM replies WHERE to_msg IN ('ain','main','work') OR to_msg='" + workId + "'")) as number[][])[0]![0]!
    expect(badRows).toBe(0)
  })

  it('闸门：真实注册的工具名，读 allow、写 ask（readOnly 默认）', async () => {
    const client = new StdioClient(db)
    const toolNames = await (async () => {
      try { await client.initialize(); return await client.listTools() } finally { client.close() }
    })()
    const config = connectionsOf({
      readOnly: true,
      connections: [{ kind: 'messages', server: 'messages',
        readTools: ['list_channels', 'list_messages', 'get_message'], writeTools: ['send_message'] }],
    })
    const hostTools = new Set(toolNames.map(n => `mcp__messages__${n}`))
    expect(allowedTools(config).filter(n => hostTools.has(n)).sort()).toEqual(allowedTools(config).sort())
    expect(judgeCall(config, 'messages', 'list_messages')).toMatchObject({ action: 'allow' })
    expect(judgeCall(config, 'messages', 'get_message')).toMatchObject({ action: 'allow' })
    expect(judgeCall(config, 'messages', 'send_message')).toMatchObject({ action: 'ask', kind: 'messages' })
  })

  it('拒后不执行：写判定为 ask 且无批准 → 真不调用 send_message → replies 表不新增', async () => {
    const before = (JSON.parse(sql(db, 'SELECT count(*) FROM replies')) as number[][])[0]![0]!
    const config = connectionsOf({
      readOnly: true,
      connections: [{ kind: 'messages', server: 'messages', readTools: ['list_messages'], writeTools: ['send_message'] }],
    })
    // 复刻 runtime.guardConnection：judgeCall=ask 且没有同签名批准 → 这次调用根本没被执行。
    const verdict = judgeCall(config, 'messages', 'send_message')
    expect(verdict.action).toBe('ask')
    const client = new StdioClient(db)
    try {
      await client.initialize()
      // 「人拒绝」＝不发起这次写调用；只有 allow/已批准才允许调用 send_message。
      if (verdict.action === 'allow') await client.callTool('send_message', { channel: 'main', to: '1', text: '不该发出去' })
    } finally { client.close() }
    const after = (JSON.parse(sql(db, 'SELECT count(*) FROM replies')) as number[][])[0]![0]!
    expect(after).toBe(before)
  })
})
