#!/usr/bin/env node
/**
 * 内部 desktop/mobile 消息 adapter —— MCP stdio server，**store 是真实 `mobileq.db`**，不是本地 JSON 信箱。
 *
 * 定位（task-2，用户 22:20 澄清后）：只处理本人 desktop/mobile 客户端消息，用真实既有会话/消息存储。
 * 本 server 把 MCP 工具映射到**真实队列**（`<stateDir>/superagent/mobileq.db`）的读写：
 *   - 读：`list_channels` / `list_messages` 读 `mobileq timeline` / `conversations`（与 `/api/mobile/timeline`
 *     同源的合并视图），`get_message` 读单条。
 *   - 写：`send_message` → `mobileq reply`，落 `replies` 表（server→client 会话面，`rkey` UNIQUE 幂等）。
 *
 * 关键纪律（与 wb2-receive 冻结）：
 *   1. **只写 `replies`，绝不写 `messages`**：mobile Source 只 pull `messages`（read_at IS NULL），
 *      写 replies 不产生 Trigger，因此不会触发 worker 自循环。
 *   2. **不 import sources/team 入队路径**，不另建存储、不给本地 JSON 取名 messages。
 *   3. 读放行 / 写审批的闸门由宿主 `connections.ts` 的 `allowedTools`/`judgeCall` + `runtime.guardConnection`
 *      在 worker 那侧做；本 server 只负责把工具语义映射到真实 CLI，是「可注册的数据 adapter」。
 *
 * 数据库路径：`MESSAGES_MCP_DB`（= 真实 `<stateDir>/superagent/mobileq.db`）。**没有默认落 JSON 文件**——
 * 缺省走 CLI 自己的 `$DSH_HOME/state/superagent/mobileq.db`（与生产同一个库），并由 `--db` 显式指定时以它为准。
 *
 * 协议：JSON-RPC 2.0 over newline-delimited stdio（initialize / notifications/initialized / ping /
 * tools/list / tools/call）。
 *
 * 用法：
 *   MESSAGES_MCP_DB=/path/to/mobileq.db node server.ts      # MCP stdio
 *   MESSAGES_MCP_DB=/path/to/q.db node server.ts --self-check
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as readline from 'node:readline'

const VERSION = '2.0.0'
const PROTOCOL_VERSION = '2024-11-05'
const SUPPORTED_PROTOCOLS = new Set(['2024-11-05', '2025-03-26', '2025-06-18'])
/**
 * 一条回话最多保留多少条。与项目各处列表读的口径一致（`screen.ts` 的 `Math.min(limit, 500)`、
 * `resources.ts` 的 limit 上限同为数百量级），给模型一个明确固定上限，避免「超大 limit 把整个会话拉回」。
 */
const MAX_LIMIT = 500
const DEFAULT_LIMIT = 50
/**
 * 回话正文的字节上限，**与传输面同一条约束**（`mobile-http.ts` 的 `send` 用 `64 * 1024` 拒「Message too large」）。
 * adapter 只是更早地按同一口径挡住，不另立一个小阈值。
 */
const MAX_TEXT_BYTES = 64 * 1024

/** The real queue file. `MESSAGES_MCP_DB` wins; else the CLI's own default $DSH_HOME/state/superagent/mobileq.db. */
function dbPath(): string | undefined {
  const explicit = process.env.MESSAGES_MCP_DB
  if (explicit) return explicit
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'state', 'superagent', 'mobileq.db')
}

/** The real `mobileq` CLI: env override, else sibling tool in this repo, else PATH. */
function cliPath(): string {
  if (process.env.MESSAGES_MCP_CLI) return process.env.MESSAGES_MCP_CLI
  const sibling = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'tools', 'mobileq')
  return existsSync(sibling) ? sibling : 'mobileq'
}

/** Run a `mobileq` subcommand against the real queue. `--db` goes at top level (before the subcommand). */
function runCli(args: string[], db = dbPath()): Promise<string> {
  return new Promise((resolve, reject) => {
    const full = [...(db ? ['--db', db] : []), ...args]
    const child = spawn(cliPath(), full, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { out += chunk })
    child.stderr.on('data', (chunk: string) => { err += chunk })
    child.on('error', reject)
    child.on('close', code => code === 0
      ? resolve(out)
      : reject(new Error(`mobileq ${args[0]} exited ${code}: ${err.trim().slice(0, 300)}`)))
  })
}

interface TimelineItem { id: string; role: 'user' | 'agent'; text: string; at: string; rkey?: string; [k: string]: unknown }

function toText(value: unknown): string { return JSON.stringify(value, null, 2) }
function ok(content: unknown) { return { content: [{ type: 'text', text: toText(content) }] } }

export const TOOLS = [
  {
    name: 'list_channels',
    description: '列出真实队列里的会话（conversation），与手机/桌面聊天里看到的会话同源。读操作。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_messages',
    description: '列某会话的消息+回话（与 /api/mobile/timeline 同形的合并视图），最新的在后。读操作。',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: '会话名（conversation）' },
        limit: { type: 'number', description: `最多返回几条（正整数，缺省 ${DEFAULT_LIMIT}，上限 ${MAX_LIMIT}）` },
      },
      required: ['channel'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_message',
    description: '按消息 id（m<N> 或 r<N>）在某会话里取一条。读操作。',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: '会话名' },
        id: { type: 'string', description: '消息 id，如 m3 / r1' },
      },
      required: ['channel', 'id'],
      additionalProperties: false,
    },
  },
  {
    name: 'send_message',
    description: '在某会话说一句回话（落 replies 表，server→client，聊天里能看到）。写操作（readOnly 下必过审批）。'
      + '幂等：同一 key 只写一次（同 key 不同正文会被当作重放，不重发）。',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: '会话名（conversation）' },
        to: { type: 'string', pattern: '^m?[1-9][0-9]*$',
          description: '要回的那条**入站消息**的引用：`m<N>` 或纯数字 `N`（N 是正整数）。'
            + '会话名（main/work）、回话 id（r<N>）、负数/0/非数字都会被拒且不写库；该消息必须存在于本 channel。' },
        text: { type: 'string', description: '回话正文' },
        key: { type: 'string', description: '幂等键；缺省由 channel+to+text 派生' },
        bot_id: { type: 'string', description: '可选：以哪个 Bot 身份回话' },
      },
      required: ['channel', 'to', 'text'],
      additionalProperties: false,
    },
  },
] as const

function requireString(args: Record<string, unknown>, field: string): string {
  const value = args[field]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${field} 必须是非空字符串`)
  return value
}

/**
 * 把 `send_message.to` 解析成一条**入站消息的 id（m<N>）**，严格按文档契约，不做盲截。
 *
 * 上一版是 `requireString(args,'to').replace(/^m/,'')`：任何以 `m` 开头的字符串都被削掉首字母——
 * `to='main'`（会话名，不是消息 id）被削成 `'ain'` 落进 `replies.to_msg`，`mobileq reply` 又盲收，
 * 服务端还回 `ok:true`。会话名/`r<N>`/负数/纯文本都被当成「可投递父消息」，写脏库还报成功。
 *
 * 现在的契约（与 `list_messages` / `get_message` 的 id 形状同源）：
 *   - 接受 `m<N>`（N 是**正整数**）或纯数字 `N`（正整数）；
 *   - **只**剥 `m` 前缀，且仅当其后是纯数字；不存在「把 main 的 m 削掉」这种路径；
 *   - `r<N>`（回话 id，不是入站消息）、`main`/`work` 这类会话名、负数、0、非数字 → 一律参数错误，零写。
 * 返回纯十进制字符串（交给 CLI 的 `--to`，CLI 侧再做「父消息存在且属该会话」的二次校验）。
 */
function messageRef(idValue: string): string {
  const m = /^m(\d+)$/.exec(idValue)
  const digits = m ? m[1]! : (/^\d+$/.test(idValue) ? idValue : undefined)
  if (digits === undefined) {
    throw new Error(`to 必须是某条入站消息的引用 m<N> 或纯数字 N（正整数），收到 ${JSON.stringify(idValue)}`)
  }
  // 正整数、无前导零（'007' 视为与 '7' 不同，明确拒，避免歧义投递到错误父消息）。
  if (!/^[1-9]\d*$/.test(digits)) {
    throw new Error(`to 的消息号必须是正整数（不能是 0 或有前导零），收到 ${JSON.stringify(idValue)}`)
  }
  return digits
}

/**
 * Resolve `limit` with an explicit contract, not a silent fallback:
 *  - 未传 → 缺省 50；
 *  - 正整数（含小数向下取整，得正整数）→ min(值, 500)；
 *  - 显式但非法（负数 / 0 / NaN / 非整数形 / 非数字）→ 抛出清楚参数错误（不静默回落）。
 * 只有「没传」才用默认值；给了个坏值必须让调用方知道，而不是悄悄换成 50。
 */
function resolveLimit(raw: unknown): number {
  if (raw === undefined) return DEFAULT_LIMIT
  if (typeof raw !== 'number' || !Number.isFinite(raw)) throw new Error('limit 必须是正整数（缺省 50，上限 500）')
  const floored = Math.floor(raw)
  if (floored < 1) throw new Error('limit 必须是正整数（缺省 50，上限 500）')
  return Math.min(floored, MAX_LIMIT)
}

async function listChannels(): Promise<unknown> {
  const page = JSON.parse(await runCli(['conversations'])) as { items: { id: string; messages: number }[] }
  return page.items
}

async function timelineOf(channel: string, limit?: number): Promise<TimelineItem[]> {
  const page = JSON.parse(await runCli(['timeline', '--conversation', channel, ...(limit ? ['--limit', String(limit)] : [])])) as { items: TimelineItem[] }
  return page.items
}

/**
 * 缺省幂等键：对 `channel:to:text` 取 SHA-256 摘要（前缀 `auto-`）。
 *
 * 早先是 `${channel}:${to}:${text}`.slice(0,120) —— 两条只在 120 字之后才分岔的长回话会截成同一个键，
 * `rkey` UNIQUE 把第二条当重放**静默吞掉**（业务回话丢一条、还回 ok）。摘要保留全部正文差异，形状也控制在键长内。
 */
function derivedKey(channel: string, to: string, text: string): string {
  const digest = createHash('sha256').update(`${channel}\u0000${to}\u0000${text}`).digest('hex')
  return `auto-${digest.slice(0, 56)}`
}

async function dispatch(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'list_channels':
      return listChannels()
    case 'list_messages': {
      const channel = requireString(args, 'channel')
      return timelineOf(channel, resolveLimit(args.limit))
    }
    case 'get_message': {
      const channel = requireString(args, 'channel')
      const id = requireString(args, 'id')
      // 精确主键查一行（`m<N>`/`r<N>`，会话过滤）：不受分页窗口影响，>500 历史的旧 id 照样命中，
      // 别的会话的 id 查不到。参数化查询在 `mobileq get` 内，MCP 不暴露 SQL/path。
      const page = JSON.parse(await runCli(['get', '--conversation', channel, '--id', id])) as { item: TimelineItem | null }
      if (!page.item) throw new Error(`会话 ${channel} 里没有 id=${id} 的消息`)
      return page.item
    }
    case 'send_message': {
      const channel = requireString(args, 'channel')
      const text = requireString(args, 'text')
      if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) throw new Error('这条消息太长了，拆成几句发')
      const to = messageRef(requireString(args, 'to'))
      const explicitKey = typeof args.key === 'string' && args.key ? args.key : undefined
      const key = explicitKey ?? derivedKey(channel, to, text)
      const bot = typeof args.bot_id === 'string' && args.bot_id ? ['--bot', args.bot_id] : []
      const reply = JSON.parse(await runCli(['reply', '--conversation', channel, '--to', to, '--key', key, '--text', text, ...bot])) as
        { ok: boolean; key: string; id: string | null; replayed?: boolean }
      // 显式 rkey 是幂等键：同 key 不同正文**不得**暗示「新正文已送达」。reply 会在同 key 已存在时标
      // replayed 并回原有行（正文仍是旧的），这里把 replayed 一并交回，让调用方看得见「这是重放、不是新的」。
      // 派生键（内容寻址的 SHA-256）撞键即同正文，重放语义天然正确，不误报新正文。
      return { ok: reply.ok, key: reply.key, channel, visible_reply_id: reply.id ?? null,
        ...(reply.replayed ? { replayed: true } : {}) }
    }
    default:
      throw new Error(`unknown tool: ${name}`)
  }
}

// ---------- MCP protocol ----------

type Json = Record<string, unknown>

/** A messages-service MCP handler: JSON-RPC 报文派发到频道/消息工具，`tools/call` 再落到真实 `mobileq` 队列。 */
export class MCPServer {
  initialized = false

  async handleMessage(message: Json): Promise<Json | null> {
    const method = message.method
    const id = message.id
    const params = (message.params as Json) ?? {}

    const okR = (result: unknown): Json => ({ jsonrpc: '2.0', id, result })
    const err = (code: number, msg: string): Json => ({ jsonrpc: '2.0', id, error: { code, message: msg } })

    if (id === undefined && typeof method === 'string' && method.startsWith('notifications/')) {
      if (method === 'notifications/initialized') this.initialized = true
      return null
    }
    if (method === 'initialize') {
      const req = String(params.protocolVersion || PROTOCOL_VERSION)
      const ver = SUPPORTED_PROTOCOLS.has(req) ? req : PROTOCOL_VERSION
      return okR({
        protocolVersion: ver,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'messages', version: VERSION },
        instructions:
          '内部 desktop/mobile 消息 adapter（真实 mobileq.db，非本地 JSON 信箱）。' +
          '读：list_channels / list_messages / get_message 与手机/桌面聊天同源；' +
          '写：send_message 落 replies 表（server→client，聊天可见、不触发 worker 自循环），readOnly 下必须人工审批。',
      })
    }
    if (method === 'ping') return okR({})
    if (method === 'tools/list') return okR({ tools: TOOLS })
    if (method === 'tools/call') {
      const name = params.name
      const arguments_ = (params.arguments as Json) ?? {}
      if (typeof name !== 'string' || !name) return err(-32602, 'tools/call requires params.name')
      if (typeof arguments_ !== 'object' || arguments_ === null) return err(-32602, 'params.arguments must be an object')
      try {
        return okR(ok(await dispatch(name, arguments_)))
      } catch (error) {
        return okR({ content: [{ type: 'text', text: `${(error as Error).name}: ${(error as Error).message}` }], isError: true })
      }
    }
    if (typeof method === 'string') return err(-32601, `method not found: ${method}`)
    return err(-32600, 'invalid request: missing method')
  }
}

async function serve(): Promise<void> {
  const server = new MCPServer()
  const rl = readline.createInterface({ input: process.stdin })
  rl.on('line', async line => {
    const trimmed = line.trim()
    if (!trimmed) return
    let message: Json
    try {
      message = JSON.parse(trimmed) as Json
    } catch (error) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: `parse error: ${(error as Error).message}` } }) + '\n')
      return
    }
    if (typeof message !== 'object' || message === null || Array.isArray(message)) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } }) + '\n')
      return
    }
    try {
      const response = await server.handleMessage(message)
      if (response) process.stdout.write(JSON.stringify(response) + '\n')
    } catch (error) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id ?? null, error: { code: -32603, message: (error as Error).message } }) + '\n')
    }
  })
}

async function selfCheck(): Promise<void> {
  console.log(`messages adapter self-check v${VERSION} (db=${dbPath() ?? '(cli default)'})`)
  const s = new MCPServer()
  const init = await s.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION } })
  const info = (init?.result as Json | undefined)?.serverInfo as Json | undefined
  if (info?.name !== 'messages') throw new Error('initialize bad')
  console.log('initialize: OK')
  const tl = await s.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  const names = ((tl!.result as Json).tools as Json[]).map(t => t.name)
  console.log(`tools (${names.length}): ${names.join(', ')}`)
  if (names.length !== TOOLS.length) throw new Error('tools count mismatch')
  const channels = await s.handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_channels', arguments: {} } })
  const body = JSON.parse(((channels!.result as Json).content as Json[])[0]!.text as string) as unknown[]
  console.log(`list_channels: OK ${body.length} conversation(s)`)
  console.log('self-check: PASS')
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  if (process.argv.includes('--self-check')) {
    selfCheck().then(() => process.exit(0)).catch(error => {
      console.error(`self-check FAILED: ${(error as Error).message}`)
      process.exit(1)
    })
  } else {
    serve().catch(error => {
      console.error(`messages-mcp fatal: ${(error as Error).message}`)
      process.exit(1)
    })
  }
}
