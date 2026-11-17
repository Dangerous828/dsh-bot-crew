/**
 * 真实 dispatch 署名（task-14 P1-06 的最后一跳）——**真 `Sessions.workOnly` 注册的 scoped wrapper**。
 *
 * 已有的 7 项 runtime 测试证明的是「guard 放行了这次调用」；它们不证明**实际执行时**带的是谁的
 * 身份。只放宽 guard 会留下最坏的一种洞：判定说「以本票 Bot 回话」，落库却是队列默认署名。
 *
 * 这里用真 DSH `Context` + 真 `tools` 服务（因此参数真的经过 `snapshotJsonValue` + `deepFreeze`）
 * 注册一个假的 `mcp__messages__send_message`，让真 `Sessions.ensure` 建 worker、真 `workOnly`
 * 装 wrapper，然后从 worker 自己的 tool 视图取到**真正会被执行的那一份**，证明：
 *
 *   1. 默认 `bot_id`（调用方没写）→ 原 MCP `execute` 收到 `bot_id` = 本票的 Bot；
 *   2. 传下去的那份是**新拷贝**，SDK 冻结的 `execution.arguments` 一个字段都没被改；
 *   3. 显式写了别的 `bot_id` → 原样保留（冒充要看得见，不被覆盖成本票 Bot）；
 *   4. wrapper 每次执行都**重新解析**当前工具（MCP 重连后拿新的那个，不是缓存旧对象）；
 *   5. `Sessions.dispose()` 之后 wrapper 与限制一起撤掉，工具回到原样。
 *
 * 不接真 MCP stdio：这一跳要观察的是**参数与调用目标**，不是队列写入；真实落库（`replies`
 * 加一行、`kind='reply'`）由 `tests/integrations/messages-mcp.spec.ts` 与
 * `internal-messages-{executor-auto,live-worker}.spec.ts` 覆盖。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Store } from '../src/app/store.ts'
import { Effects } from '../src/app/effects.ts'
import { Prompts } from '../src/app/prompts.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { Sessions } from '../src/app/sessions.ts'
import { connectionOfCall, connectionsOf, signMessageCall } from '../src/app/connections.ts'
import { workerSessionId } from '../src/executor/dsh.ts'
import type { Ticket, Trigger } from '../src/core/model.ts'

const DSH = process.env.DSH_NODE_MODULES ?? '/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh/node_modules/@deepseek-ai'
const dsh = (name: string): Promise<any> => import(`${DSH}/${name}/lib/index.js`)

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) } catch { /* */ } } })

/** What one dispatch handed the original MCP tool. */
interface Seen {
  tool: string
  args: Record<string, unknown>
  /** Whether the object actually handed to the original MCP tool is frozen (it must not be: it is a fresh copy). */
  frozen: boolean
  /** Whether the SDK's own snapshot was frozen (it is; that is why a wrapper must copy). */
  frozenGiven: boolean
  sameAsFrozen: boolean
}

/**
 * 装一套真 DSH 工具面：真 `Context` + 真 `tools`（所以 args 真的会被冻结），然后让测试自己
 * 注册 `mcp__messages__send_message`，把每次 execute 收到的参数记下来。
 */
async function harness() {
  const root = mkdtempSync(join(tmpdir(), 'sessions-dispatch-')); dirs.push(root)
  const M: Record<string, any> = {}
  for (const n of ['dsh-session-projection', 'dsh-subprocess-local', 'dsh-session', 'dsh-system-prompt',
    'dsh-tools', 'dsh-llm', 'dsh-agent', 'dsh-agent-loop', 'dsh-permission-presets', 'dsh-user-approval',
    'dsh-attachment-local', 'dsh-working-directory', 'dsh-bash-sandbox', 'dsh-shell-env']) M[n] = await dsh(n)
  M.llm = M['dsh-llm']
  let nativeExec: any; try { nativeExec = await dsh('dsh-tool-executor-native') } catch { nativeExec = undefined }
  const ctx = new Context()
  const plug = (p: any) => { try { const r: any = ctx.plugin(p); if (r && typeof r.catch === 'function') r.catch(() => undefined) } catch { /* */ } }
  plug(M['dsh-session-projection'].default); plug(M['dsh-subprocess-local'].default); plug(M['dsh-session'].default)
  plug(M['dsh-system-prompt'].default); plug(M['dsh-tools'].default); plug(M['dsh-llm'].default)
  if (nativeExec) plug({ name: 'native-tool-executor', inject: nativeExec.inject, apply: (c: any) => nativeExec.apply(c) })
  plug(M['dsh-working-directory'].default)
  plug({ name: 'attachment-local', inject: M['dsh-attachment-local'].inject, apply: (c: any) => M['dsh-attachment-local'].apply(c, { root: join(root, 'att') }) })
  plug({ name: 'bash-sandbox', inject: M['dsh-bash-sandbox'].inject, apply: (c: any) => M['dsh-bash-sandbox'].apply(c, { cwd: root, timeoutMs: 10000, maxTimeoutMs: 10000 }) })
  plug({ name: 'shell-env', inject: M['dsh-shell-env'].inject, apply: (c: any) => M['dsh-shell-env'].apply(c, M['dsh-shell-env'].Config({})) })
  plug({ name: 'approval', inject: M['dsh-user-approval'].inject, apply: (c: any) => M['dsh-user-approval'].apply(c, {}) })
  plug({ name: 'permission-presets', inject: M['dsh-permission-presets'].inject, apply: (c: any) => M['dsh-permission-presets'].apply(c, {
    presets: { 'workspace-write': { sandbox: 'workspace-write', approval: 'never' }, 'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' } },
    defaultPreset: 'danger-full-access' }) })
  plug(M['dsh-agent'].default); plug(M['dsh-agent-loop'].default)
  await new Promise(resolve => setTimeout(resolve, 400))

  const tools = ctx.get('tools') as any
  const seen: Seen[] = []
  /** Register (or re-register) an MCP-shaped tool; `name` defaults to the messages connection's send_message. */
  const serve = (tag: string, name = 'mcp__messages__send_message') => tools.register({
    name,
    description: `发送一条消息（${tag}）`,
    parameters: { type: 'object', properties: { channel: { type: 'string' }, to: { type: 'string' }, text: { type: 'string' }, bot_id: { type: 'string' } }, required: ['channel', 'to', 'text'] },
    output: { schema: { type: 'object', properties: { ok: { type: 'boolean' } } }, render: () => [] },
    execute: (args: Record<string, unknown>, execution: any) => {
      // `frozen` 记的是**这次真正传下去的那一份**；`frozenGiven` 是 SDK 交给 wrapper 的那一份。
      seen.push({ tool: tag, args, frozen: Object.isFrozen(args), frozenGiven: Object.isFrozen(execution?.arguments),
        sameAsFrozen: args === execution?.arguments })
      return { ok: true }
    },
  })

  const store = new Store(join(root, 'orchestrator.sqlite'))
  const board = new HealthBoard()
  const effects = new Effects(store, board)
  const prompts = new Prompts(store, () => 100000, () => undefined, () => false)

  // 真设置：一条 messages 连接，send_message 是要审批的写。
  store.saveSettings({ ...store.settings(), connections: { readOnly: true,
    connections: [{ kind: 'messages', server: 'messages', readTools: ['list_messages'], writeTools: ['send_message'] }] } })

  // 真来源消息：team / main / 第 82 条，由 coder 接。票的 Bot 就是它。
  const ticketId = 'T-dispatch-1'
  const now = new Date().toISOString()
  const trigger: Trigger = { id: 'trig-dispatch-1', source: 'team', threads: [{ source: 'team', id: 'main:82' }],
    actor: { source: 'team', id: 'owner' }, human: true, at: now, text: '请回一句',
    channel: { source: 'team', thread: 'team:main:82',
      address: { conversation: 'main', message: '82', bot_id: 'coder' } },
    meta: { conversation: 'main', messageId: '82', bot_id: 'coder' } }
  store.triggers.save(trigger)
  const ticket: Ticket = {
    id: ticketId, title: '署名回归', decisionId: 'D-1', mandate: { strength: 'explicit' } as never,
    channels: [trigger.channel!], assignments: [], inputs: [], undelivered: [], createdAt: now, updatedAt: now,
    origin: { triggerId: trigger.id, triggerIds: [trigger.id] },
    execution: { name: 'dispatch', directory: root, assignment: 'signing acceptance' },
  }
  store.tickets.save(ticket)

  // 真签名逻辑：与 `Runtime.signConnectionCall` 同一份（精确限定 messages 连接上的 send_message）。
  const sign = (tid: string, name: string, args: unknown): unknown => {
    const call = connectionOfCall(connectionsOf(store.settings().connections), name)
    if (call?.connection.kind !== 'messages' || call.tool !== 'send_message') return args
    const t = store.tickets.get(tid)
    const bot = t?.channels[0]?.address?.bot_id
    return signMessageCall(args, typeof bot === 'string' ? bot : undefined)
  }

  const sessionController = {
    async resolveAgent(sessionId: string) {
      const live = (ctx.get('agents') as any).get(sessionId)
      return live ? { agent: live } : { error: { code: 'session/not-found' } }
    },
    async create({ sessionId }: { sessionId: string }) {
      await (ctx.get('agents') as any).create({ sessionId, agentOptions: { provider: 'stub', model: 'stub-1' }, meta: { cwd: root } })
    },
    async rename() {}, selectModel: async () => {},
  }
  const sessions = new Sessions({
    context: ctx, store, prompts, effects, health: board.claim('worker'), masterId: 'main',
    lifetime: new AbortController().signal, closing: () => false, environment: () => [], tools: () => [],
    // 本 spec 只看署名：审批闸一律放行（闸本身由 runtime.spec.ts 的真实用例覆盖）。
    guardConnection: () => undefined,
    signConnectionCall: sign,
  })
  sessions.install()
  ;(ctx as any).reflect.provide('sessionController', sessionController)
  ;(ctx as any).reflect.provide('workspaceRegistry', { create: async (cwd: string) => ({ id: cwd }), list: () => [] })
  ;(ctx as any).reflect.provide('permissionPresets', { set: () => {} })

  return { ctx, store, sessions, seen, serve, ticketId,
    /** The definition the worker's own scope resolves — the one a model call would execute. */
    workerTool: (agent: any) => (agent.ctx.tools as any).get('mcp__messages__send_message', agent),
  }
}

describe('the worker actually dispatches as its own Bot', () => {
  it('adds the ticket Bot to the arguments the original MCP tool runs with, without touching the frozen ones', async () => {
    const { sessions, seen, serve, ticketId, workerTool } = await harness()
    const unregister = serve('first')
    try {
      const worker = await sessions.ensure(workerSessionId(ticketId), (await import('node:os')).tmpdir(), '署名回归', 'worker')
      const tool = workerTool(worker)
      expect(tool).toBeTruthy()
      const execution = { arguments: Object.freeze({ channel: 'main', to: 'm82', text: '已经改好了' }) }
      await tool.execute(execution.arguments, execution)
      expect(seen).toHaveLength(1)
      // 真正落到原 MCP 的那一份：带本票的 Bot。
      expect(seen[0]!.args).toEqual({ channel: 'main', to: 'm82', text: '已经改好了', bot_id: 'coder' })
      // 传下去的是新拷贝：SDK 冻结的那份没被写进任何字段（就地改会抛，或留下 bot_id）。
      expect(seen[0]!.sameAsFrozen).toBe(false)
      // SDK 交进来的那份是冻结的（就地改会抛），而传下去的是可写的新拷贝。
      expect(seen[0]!.frozenGiven).toBe(true)
      expect(seen[0]!.frozen).toBe(false)
      expect(execution.arguments).toEqual({ channel: 'main', to: 'm82', text: '已经改好了' })
    } finally { unregister() }
    sessions.dispose()
  })

  it('keeps an explicit bot_id: a call that names another Bot is executed as that Bot', async () => {
    const { sessions, seen, serve, ticketId, workerTool } = await harness()
    const unregister = serve('first')
    try {
      const worker = await sessions.ensure(workerSessionId(ticketId), (await import('node:os')).tmpdir(), '署名回归', 'worker')
      await workerTool(worker).execute({ channel: 'main', to: 'm82', text: '我替他说', bot_id: 'lead' }, { arguments: {} })
      expect(seen[0]!.args).toMatchObject({ bot_id: 'lead' })
    } finally { unregister() }
    sessions.dispose()
  })

  it('runs whatever tool the connection now provides, so an MCP reconnect is picked up instead of a cached one', async () => {
    const { sessions, seen, serve, ticketId, workerTool } = await harness()
    const first = serve('first')
    try {
      const worker = await sessions.ensure(workerSessionId(ticketId), (await import('node:os')).tmpdir(), '署名回归', 'worker')
      const tool = workerTool(worker)
      await tool.execute({ channel: 'main', to: 'm82', text: '一' }, { arguments: {} })
      // 连接重连：旧工具下线，同名新工具上线。
      first()
      const second = serve('second')
      await workerTool(worker).execute({ channel: 'main', to: 'm82', text: '二' }, { arguments: {} })
      expect(seen.map(item => item.tool)).toEqual(['first', 'second'])
      // 两次都以本票 Bot 署名（新的那一份同样被签名，不是只对旧对象生效）。
      expect(seen.map(item => item.args.bot_id)).toEqual(['coder', 'coder'])
      second()
    } finally { sessions.dispose() }
  })

  it('leaves the tool alone once the Session is released', async () => {
    const { sessions, seen, serve, ticketId, workerTool } = await harness()
    const unregister = serve('first')
    try {
      const worker = await sessions.ensure(workerSessionId(ticketId), (await import('node:os')).tmpdir(), '署名回归', 'worker')
      const wrapped = workerTool(worker)
      await wrapped.execute({ channel: 'main', to: 'm82', text: '一' }, { arguments: {} })
      sessions.dispose()
      // wrapper 与 restrict 一起撤掉：这个作用域看到的又回到原工具本身。
      const plain = (worker.ctx.tools as any).get('mcp__messages__send_message', worker)
      expect(plain).not.toBe(wrapped)
      await plain.execute({ channel: 'main', to: 'm82', text: '二' }, { arguments: {} })
      // 不再补 bot_id：释放后没有人替它署名，也不会拿旧票的 Bot 去写。
      expect(seen.at(-1)!.args).toEqual({ channel: 'main', to: 'm82', text: '二' })
    } finally { unregister() }
  })

  it('signs only the messages connection\'s send_message, never a same-named tool of another service', async () => {
    const { sessions, store, seen, serve, ticketId } = await harness()
    // 邮件服务也提供 send_message：同名、同样要审批，但不是「消息」这一类。
    store.saveSettings({ ...store.settings(), connections: { readOnly: true, connections: [
      { kind: 'messages', server: 'messages', readTools: ['list_messages'], writeTools: ['send_message'] },
      { kind: 'mail', server: 'mail', readTools: ['list_messages'], writeTools: ['send_message'] } ] } })
    const unregisterMessages = serve('messages')
    const unregisterMail = serve('mail', 'mcp__mail__send_message')
    try {
      const worker = await sessions.ensure(workerSessionId(ticketId), (await import('node:os')).tmpdir(), '署名回归', 'worker')
      const mailTool = (worker.ctx.tools as any).get('mcp__mail__send_message', worker)
      expect(mailTool).toBeTruthy()
      await mailTool.execute({ channel: 'main', to: 'm82', text: '邮件正文' }, { arguments: {} })
      // 邮件的 send_message 原样执行：不塞一个它不认的 bot_id。
      expect(seen.at(-1)!.args).toEqual({ channel: 'main', to: 'm82', text: '邮件正文' })
      expect(seen.at(-1)!.tool).toBe('mail')
      // 同一张票、同一时刻，消息的那一个仍然被署名 —— 这不是「全都不署名」。
      await (worker.ctx.tools as any).get('mcp__messages__send_message', worker)
        .execute({ channel: 'main', to: 'm82', text: '消息正文' }, { arguments: {} })
      expect(seen.at(-1)!.args).toMatchObject({ bot_id: 'coder' })
    } finally { unregisterMessages(); unregisterMail(); sessions.dispose() }
  })
})
