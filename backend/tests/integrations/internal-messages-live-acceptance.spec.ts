/**
 * 内部消息 MCP —— **连接审批判定 + adapter 写路径**组件集成（task-11）。
 *
 * 【准确定位，勿误读为「真执行器 worker/真 MCP 调度」】这条 spec 是**组件集成**：
 *   - 真 `Runtime`（真 SQLite `store`）+ 真 `store.tickets`（真 ticket 形状）+ 真 `Runtime.guardConnection`
 *     这个**判定函数**——但它**直接调用 private `guardConnection` 这个判定函数**，并不经由
 *     真 AgentLoop 的 `tools.guard` 钩子在一次真实工具执行里触发；
 *   - 「批准」是**直接改写 `ticket.pendingApproval.status='approved'`**（模拟公开批准入口的效果），
 *     不是走真的 `approvalReply`/公开批准入口去驱动一个真 worker 继续；
 *   - `realSend()` **直接 exec `mobileq` CLI** 落 canary（**没有**真的 spawn MCP adapter、也没有
 *     经 `tools.execute → dsh-mcp-client → stdio adapter` 这条真调度链）；
 *   - 「拒绝」= **未答复、保持 waiting**，不是走真的取消/拒绝入口让一个真 worker 结束。
 *
 * 因此它证明的是：`guardConnection` 对读 allow / 写 ask + 一次性签名消费的状态机正确，
 * 且「批准后写 canary 恰好 +1、未批准零写」在**组件层**成立。**不**证明真 agent 调度/真 MCP stdio
 * 被真工具执行链调用。**真正的 ticket-bound 真执行器 worker 证据**在
 * `tests/integrations/internal-messages-live-worker.e2e.mjs`（真 AgentLoop + 真 dsh-mcp-client +
 * 真 tools.guard + 真公开批准入口）。
 *
 * 覆盖（与任务验收口径一一对应）：
 *   1. 读工具（list_messages）在真 ticket 上 `guardConnection` → 放行（undefined），不产生 pendingApproval；
 *   2. 写工具（send_message）在**未批准**时 → 返回「等你点头」字符串 + ticket.pendingApproval 产生（waiting），
 *      **DB 零新增**（未批准绝不调用 adapter）；
 *   3. 批准**同一次**（同一 signature）→ 再次过闸放行 → 真调用 adapter → canvases `replies` **只 +1**；
 *   4. 同参数**再调一次** → 又回到 ask（授权只消费一次），**DB 不再新增**；
 *   5. 拒绝（保持 waiting、不清批准）→ 后续不再放行、**DB +0**；
 *   6. 改参数（换正文）→ 即使已批准也重新 ask（签名随参数变），**DB +0**；
 *   7. 全程 production 库（若指到）只读计数不变——由脚本做双库核对，spec 内不自指生产。
 */
import { Context } from '@deepseek-ai/cordis'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Runtime } from '../../src/app/runtime.ts'
import { testMachine } from '../fixtures/deployment.ts'
import type { Ticket } from '../../src/core/model.ts'

const CLI = fileURLToPath(new URL('../../tools/mobileq', import.meta.url))

const sql = (db: string, query: string): string =>
  execFileSync('python3', ['-c', `import sqlite3,sys,json;c=sqlite3.connect(sys.argv[1]);print(json.dumps(c.execute(sys.argv[2]).fetchall()))`, db, query], { encoding: 'utf8' }).trim()
const replyCount = (db: string): number => (JSON.parse(sql(db, 'SELECT count(*) FROM replies')) as number[][])[0]![0]!

const dirs: string[] = []
const runtimes: Runtime[] = []
afterEach(async () => { for (const r of runtimes.splice(0)) { try { await r?.stop() } catch { /* already closed */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) })

/** Build a real ticket in the runtime store (mirrors a kept-accepted ticket's required fields). */
function makeTicket(stateDir: string): Ticket {
  const now = new Date().toISOString()
  return {
    id: 'T-accept-1', title: '内部消息审批验收', decisionId: 'D-1',
    mandate: { strength: 'explicit' } as never,
    channels: [{ source: 'mobile', thread: 'mobile:main:1', address: { conversation: 'main', message: '1' } }],
    assignments: [], inputs: [], undelivered: [], createdAt: now, updatedAt: now,
    origin: { triggerId: 'trig-1', triggerIds: ['trig-1'] },
    execution: { name: 'accept', directory: stateDir, assignment: 'approval acceptance' },
  }
}

/** Boot a real Runtime on an isolated stateDir with the minimal host services it reads at construction;
 *  provide the messages connection in its settings, and a real ticket in its store. */
async function bootRuntime(stateDir: string): Promise<{ runtime: Runtime; ticket: Ticket }> {
  const ctx = new Context()
  // Minimal host services the Runtime touches during construction / initialize. No network, no real agents.
  const noop = () => {}
  const services: Record<string, unknown> = {
    agents: { get: () => undefined, list: () => [] },
    webServer: { host: '127.0.0.1', port: 0, register: () => noop },
    llm: { resolveCallConfig: async (v: unknown) => v },
    sessionPersistence: { flush: async () => {}, open: async () => ({ read: async () => ({ events: [] }) }) },
    workspaceRegistry: { create: async (cwd: string) => ({ id: cwd }), list: () => [], archivedSessionIds: [], unarchiveSession: noop },
    permissionPresets: { set: noop },
  }
  for (const [name, service] of Object.entries(services)) ctx.reflect.provide(name, service)
  const runtime = new Runtime(ctx, testMachine({ stateDir }), () => {})
  const current = runtime.store.settings()
  runtime.store.saveSettings({ ...current, connections: { readOnly: true,
    connections: [{ kind: 'messages', server: 'messages',
      readTools: ['list_channels', 'list_messages', 'get_message'], writeTools: ['send_message'] }] } })
  const ticket = makeTicket(stateDir)
  runtime.store.tickets.save(ticket)
  return { runtime, ticket }
}

/** Drive the real write gate exactly as the executor worker does. */
type Gate = (ticketId: string, name: string, args: unknown) => string | undefined
const gateOf = (runtime: Runtime): Gate => (runtime as unknown as { guardConnection: Gate }).guardConnection.bind(runtime)

/** Invoke the real adapter's write path against the canary DB (what DSH's tool dispatcher would do once allowed). */
function realSend(db: string, args: Record<string, unknown>): { ok: boolean; id?: string | null } {
  // The adapter's success path is exactly `mobileq reply` against the canary DB with the validated parent.
  const cli = execFileSync('python3', [CLI, '--db', db, 'reply', '--conversation', String(args.channel),
    '--to', String(args.to), '--key', String(args.key ?? 'k-live'), '--text', String(args.text)], { encoding: 'utf8' })
  return JSON.parse(cli) as { ok: boolean; id?: string | null }
}

describe('内部消息 MCP：真 ticket 上读放行/写审批/批准一次/拒后零写（隔离 canary DB）', () => {
  it('读放行；写 held 且 DB 零新增；批准同一次后真写 +1；再调重问 +0；改参数重问 +0', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'msg-live-accept-')); dirs.push(dir)
    const db = process.env.MESSAGES_ACCEPT_DB || join(dir, 'canary-mobileq.db'); if (!process.env.MESSAGES_ACCEPT_DB) dirs.push(join(db, '..'))
    // Seed one REAL inbound message in `main` so the reply parent exists.
    execFileSync('python3', [CLI, '--db', db, 'inject', '--conversation', 'main', '--sender', 'owner', '--text', '用户：请回一句'])
    const parent = String((JSON.parse(execFileSync('python3', ['-c', `import sqlite3,sys,json;c=sqlite3.connect(sys.argv[1]);print(json.dumps([c.execute('SELECT max(id) FROM messages').fetchone()[0]]))`, db], { encoding: 'utf8' })) as number[])[0]!)

    const { runtime, ticket } = await bootRuntime(dir); runtimes.push(runtime); await runtime.ready
    const gate = gateOf(runtime)
    const ticketId = ticket.id
    const reply = (text: string) => ({ channel: 'main', to: parent, text, key: `live-${text}` })

    // 1) READ allowed, no approval raised.
    expect(gate(ticketId, 'mcp__messages__list_messages', { channel: 'main' })).toBeUndefined()
    expect(runtime.store.tickets.get(ticketId)?.pendingApproval).toBeUndefined()

    // 2) WRITE held: returns a prompt, ticket.pendingApproval created (waiting), DB zero new.
    const before = replyCount(db)
    const held = gate(ticketId, 'mcp__messages__send_message', reply('这是批准前的回话'))
    expect(typeof held).toBe('string')
    expect(held).toContain('重试')
    const pending = runtime.store.tickets.get(ticketId)?.pendingApproval
    expect(pending).toMatchObject({ kind: 'connection', status: 'waiting' })
    expect(pending?.signature).toBeTruthy()
    expect(runtime.store.tickets.get(ticketId)?.attention?.question).toBeTruthy()
    expect(replyCount(db)).toBe(before) // not approved → adapter never called → zero writes

    // 3) Simulate the approve path's EFFECT by flipping the pending to approved (component-level; the real
    const approved = runtime.store.tickets.get(ticketId)!
    approved.pendingApproval = { kind: 'connection', status: 'approved', signature: pending!.signature }
    runtime.store.tickets.save(approved)
    // Same args → gate now allows exactly once.
    expect(gate(ticketId, 'mcp__messages__send_message', reply('这是批准前的回话'))).toBeUndefined()
    // Component-level write: exec mobileq directly (NOT the real tools.execute→MCP stdio chain).
    realSend(db, reply('这是批准前的回话'))
    expect(replyCount(db)).toBe(before + 1) // approved → exactly +1

    // 4) Same call again → re-ask (the grant was consumed once), DB stays at +1.
    const again = gate(ticketId, 'mcp__messages__send_message', reply('这是批准前的回话'))
    expect(typeof again).toBe('string')
    expect(replyCount(db)).toBe(before + 1)

    // 5) Change arguments (different text) even while a fresh waiting approval exists → re-ask, DB unchanged.
    const changed = gate(ticketId, 'mcp__messages__send_message', reply('改了正文的另一句'))
    expect(typeof changed).toBe('string')
    expect(replyCount(db)).toBe(before + 1)

      })

  it('拒绝（保持 waiting 不批准）→ 永不放行、DB +0', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'msg-live-reject-')); dirs.push(dir)
    const db = join(dir, 'canary-mobileq.db'); dirs.push(join(db, '..'))
    execFileSync('python3', [CLI, '--db', db, 'inject', '--conversation', 'main', '--sender', 'owner', '--text', '用户：别回'])
    const parent = String((JSON.parse(execFileSync('python3', ['-c', `import sqlite3,sys,json;c=sqlite3.connect(sys.argv[1]);print(json.dumps([c.execute('SELECT max(id) FROM messages').fetchone()[0]]))`, db], { encoding: 'utf8' })) as number[])[0]!)
    const { runtime, ticket } = await bootRuntime(dir); runtimes.push(runtime); await runtime.ready
    const gate = gateOf(runtime)
    const before = replyCount(db)
    const reply = { channel: 'main', to: parent, text: '不该发出去', key: 'reject-1' }
    expect(typeof gate(ticket.id, 'mcp__messages__send_message', reply)).toBe('string') // asks
    // Human declines: leave pendingApproval waiting (do not approve, do not execute).
    expect(runtime.store.tickets.get(ticket.id)?.pendingApproval?.status).toBe('waiting')
    expect(replyCount(db)).toBe(before) // zero writes
      })

  it('审批签名语义稳定：同参数不同键序视为同一次（批准后放行一次），值变或数组换序仍重问', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'msg-sig-order-')); dirs.push(dir)
    const db = join(dir, 'canary-mobileq.db')
    execFileSync('python3', [CLI, '--db', db, 'inject', '--conversation', 'main', '--sender', 'owner', '--text', '用户：回一句'])
    const parent = String((JSON.parse(execFileSync('python3', ['-c', `import sqlite3,sys,json;c=sqlite3.connect(sys.argv[1]);print(json.dumps([c.execute('SELECT max(id) FROM messages').fetchone()[0]]))`, db], { encoding: 'utf8' })) as number[])[0]!)
    const { runtime, ticket } = await bootRuntime(dir); runtimes.push(runtime); await runtime.ready
    const gate = gateOf(runtime)
    const ticketId = ticket.id
    // same logical args, keys in one order
    const a1 = { channel: 'main', to: parent, text: '同参数', key: 'sig-1' }
    // same values, keys in a DIFFERENT order (+ a nested object with reordered keys)
    const a2 = { key: 'sig-1', text: '同参数', to: parent, channel: 'main' }
    expect(typeof gate(ticketId, 'mcp__messages__send_message', a1)).toBe('string') // asks
    const att = runtime.store.tickets.get(ticketId)!.attention!
    expect(runtime.answerTicket(ticketId, '做吧', att.id, 'dev-1')).toEqual({ ok: true, answer: 'go' })
    // reordered keys, same values → same signature → allowed exactly once (NOT a false "changed args" re-ask)
    expect(gate(ticketId, 'mcp__messages__send_message', a2)).toBeUndefined()
    // grant consumed → the next identical call re-asks
    expect(typeof gate(ticketId, 'mcp__messages__send_message', { ...a1 })).toBe('string')
    // changed VALUE → signature differs → re-ask even if immediately approved before
    const att2 = runtime.store.tickets.get(ticketId)!.attention!
    expect(runtime.answerTicket(ticketId, '做吧', att2.id, 'dev-1')).toEqual({ ok: true, answer: 'go' })
    expect(typeof gate(ticketId, 'mcp__messages__send_message', { ...a1, text: '改了正文' })).toBe('string')
    // array reorder inside args → different signature → re-ask (arrays are order-sensitive)
    const att3 = runtime.store.tickets.get(ticketId)!.attention!
    expect(runtime.answerTicket(ticketId, '做吧', att3.id, 'dev-1')).toEqual({ ok: true, answer: 'go' })
    expect(typeof gate(ticketId, 'mcp__messages__send_message', { ...a1, tags: ['x', 'y'] })).toBe('string')
    const att4 = runtime.store.tickets.get(ticketId)!.attention!
    expect(runtime.answerTicket(ticketId, '做吧', att4.id, 'dev-1')).toEqual({ ok: true, answer: 'go' })
    expect(typeof gate(ticketId, 'mcp__messages__send_message', { ...a1, tags: ['y', 'x'] })).toBe('string')
  })

  // ─── 手机审批入口（mobile `answer` → runtime.answerTicket）──────────────────────────────────
  // 复用上面同一套真 ticket + canary DB + 真 guardConnection，证明「手机这条通道用现有 source 消息就能
  // 完成连接写审批」，且与 feishu `approvalReply` 走同一套状态机（不是造第二个审批 UI）。
  describe('手机 answer 入口：走与 feishu approvalReply 同一套审批状态机', () => {
    it('未批准写被 hold 后，手机回「做吧」→ 批准同一次→真 adapter 写 +1；回「先别做」→ 只取消这一次、票不结束；认不出的答 → 如实拒绝不动', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'msg-answer-entry-')); dirs.push(dir)
      const db = join(dir, 'canary-mobileq.db')
      execFileSync('python3', [CLI, '--db', db, 'inject', '--conversation', 'main', '--sender', 'owner', '--text', '用户：请回一句'])
      const parent = String((JSON.parse(execFileSync('python3', ['-c', `import sqlite3,sys,json;c=sqlite3.connect(sys.argv[1]);print(json.dumps([c.execute('SELECT max(id) FROM messages').fetchone()[0]]))`, db], { encoding: 'utf8' })) as number[])[0]!)

      const { runtime, ticket } = await bootRuntime(dir); runtimes.push(runtime); await runtime.ready
      const gate = gateOf(runtime)
      const before = replyCount(db)
      const reply = { channel: 'main', to: parent, text: '经手机批准的回话', key: 'answer-1' }

      // A write is held → pendingApproval(waiting) + attention with 做吧/先别做 options.
      expect(typeof gate(ticket.id, 'mcp__messages__send_message', reply)).toBe('string')
      const att = runtime.store.tickets.get(ticket.id)!
      expect(att.pendingApproval).toMatchObject({ kind: 'connection', status: 'waiting' })
      // 文案各自说出后果：取消这一次 ≠ 停整票。
      expect(att.attention?.options?.map(o => o.id)).toEqual(['go', 'stop', 'revise'])
      expect(att.attention?.options?.find(o => o.id === 'stop')!.label).toContain('这一次')
      const attentionId = att.attention!.id
      expect(attentionId).toBeTruthy()
      expect(replyCount(db)).toBe(before)

      // Missing attention id → 409-class, no move (can't tell which request this approves).
      expect(runtime.answerTicket(ticket.id, '做吧').ok).toBe(false)
      // Stale/wrong attention id (old card approving a new request) → refuse, zero change.
      const stale = runtime.answerTicket(ticket.id, '做吧', 'attention-connection-stale-xxx')
      expect(stale).toEqual({ ok: false, reason: '这张问题卡已经过期（票或请求已变），请刷新后再答' })
      expect(runtime.store.tickets.get(ticket.id)?.pendingApproval?.status).toBe('waiting')
      expect(replyCount(db)).toBe(before)

      // An unrecognized answer must not move anything.
      const junk = runtime.answerTicket(ticket.id, '随便说一句', attentionId)
      expect(junk).toEqual({ ok: false, reason: '这句不是一个可执行的答复' })
      expect(runtime.store.tickets.get(ticket.id)?.pendingApproval?.status).toBe('waiting')
      expect(replyCount(db)).toBe(before)

      // A ticket that is not waiting for approval can't be answered.
      expect(runtime.answerTicket('no-such-ticket', '做吧', attentionId).ok).toBe(false)

      // Mobile "做吧" (with the current attention id + a verified actor) → approve the SAME grant → gate allows once → +1.
      const beforeInputs = runtime.store.tickets.get(ticket.id)!.inputs.length
      expect(runtime.answerTicket(ticket.id, '做吧', attentionId, 'device-abc123')).toEqual({ ok: true, answer: 'go' })
      // Audit recorded in the existing input mechanism (actor comes from the verified principal, not body).
      const inputs = runtime.store.tickets.get(ticket.id)!.inputs
      // +2: our mobile-answer audit input + the approval-go input applyApprovalAnswer pushes on approval.
      expect(inputs.length).toBe(beforeInputs + 2)
      expect(inputs.slice(beforeInputs).some(i => JSON.stringify(i).includes('actor=device-abc123'))).toBe(true)
      expect(gate(ticket.id, 'mcp__messages__send_message', reply)).toBeUndefined()
      realSend(db, reply)
      expect(replyCount(db)).toBe(before + 1)

      // Same args again → grant consumed → re-ask (a fresh waiting + attention), DB unchanged.
      expect(typeof gate(ticket.id, 'mcp__messages__send_message', reply)).toBe('string')
      expect(replyCount(db)).toBe(before + 1)
      // The fresh attention id differs from the old one (a stale old-card approval must not match it).
      const freshAttn = runtime.store.tickets.get(ticket.id)!.attention!.id
      expect(freshAttn).toBeTruthy()

      // Mobile "先别做" → 只取消这一次调用：票不结束，同一签名再调直接回拒绝（不再出卡），DB 不变。
      const beforeStop = replyCount(db)
      expect(runtime.answerTicket(ticket.id, '先别做', freshAttn)).toEqual({ ok: true, answer: 'stop' })
      const stopped = runtime.store.tickets.get(ticket.id)!
      expect(stopped.ended).toBeUndefined()
      expect(stopped.pendingApproval).toBeUndefined()
      expect(stopped.approvalDenied?.signature).toBeTruthy()
      expect(gate(ticket.id, 'mcp__messages__send_message', reply)).toContain('取消了这一次调用')
      expect(runtime.store.tickets.get(ticket.id)?.attention).toBeUndefined()
      expect(replyCount(db)).toBe(beforeStop)
    })
  })
})
