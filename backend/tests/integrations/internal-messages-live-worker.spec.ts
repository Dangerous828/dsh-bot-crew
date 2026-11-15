/**
 * 内部消息 MCP —— **真 AgentLoop 执行器会话 + 真 dsh-mcp-client stdio + 真 tools.guard + 真批准入口** 端到端（task-11）。
 *
 * 与 `internal-messages-live-acceptance.spec.ts`（组件集成，别当 live）不同，这条**真**跑通缺的那一环：
 *   - 真 DSH `Context`（App bundle 的**真实** dsh-agent-loop / dsh-tools / dsh-mcp-client 等服务类）+
 *     真 `ScriptedAdapter`（确定性、无外部模型）驱动一次真 AgentLoop turn；
 *   - 真 `dsh-mcp-client` 以 stdio 拉起真实 `messages-mcp/server.ts` 子进程，store 指**本 spec 独占临时 canary DB**；
 *   - 真 `tools.guard` 钩子把每次工具执行委托给**真 `Runtime.guardConnection`**（真 ticket）判读写；
 *   - 未批准 → guard 返回字符串 → 该 `mcp__messages__send_message` **不派发**（工具结果是 denial），canary 0 写；
 *   - 经**公开批准入口** `runtime.receive(feishu('做吧'))`（= `approvalReply`）把 pendingApproval 置 approved →
 *     重新投递该 turn → guard 放行 → **真 `tools.execute` → 真 mcp-client → 真 stdio adapter** → canary replies **+1**；
 *   - 另一单经公开**拒绝/停止入口** `runtime.receive(feishu('先别做'))`（approvalReply→stopTicket）→ worker 结束、
 *     guard 仍不放行、canary **零写**。
 *
 * 诚实边界：真 AgentLoop 的“执行器会话”由 `AgentRegistry.create` + `agent.followup` 驱动（单轮脚本模型）；
 * `Runtime` 侧用一个真 ticket 承载审批状态机（公开 `approvalReply` 入口），批准后我们**重新 followup** 触发 worker
 * 重跑该 turn（等价于执行器在批准后向同一 worker 重新交付）——**批准入口、guard 判定、MCP 真执行都是真模块**，
 * 只有“执行器向 worker 重新投递”这一跳用 followup 显式模拟（因本 spec 不启动完整 superagent 的 DshExecutor）。
 * 所有写落隔离 canary，生产仅 script 外层只读核对。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { feishu, startRuntime, type Host } from '../fixtures/host.ts'

const DSH = process.env.DSH_NODE_MODULES ?? '/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh/node_modules/@deepseek-ai'
const dsh = (name: string): Promise<any> => import(`${DSH}/${name}/lib/index.js`)
const MESSAGES_MCP = '/Users/cpuser/Code/dsh-bot-crew/backend/src/integrations/messages-mcp/messages-mcp'
const MOBILEQ = '/Users/cpuser/Code/dsh-bot-crew/backend/tools/mobileq'

const sqlv = (db: string, q: string): string => execFileSync('python3', ['-c', `import sqlite3,sys,json;c=sqlite3.connect(sys.argv[1]);print(json.dumps(c.execute(sys.argv[2]).fetchall()))`, db, q], { encoding: 'utf8' }).trim()
const nreplies = (db: string): number => (JSON.parse(sqlv(db, 'SELECT count(*) FROM replies')) as number[][])[0]![0]!

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) })

/** Boot a real DSH context: systemPrompt+tools+llm+executor+agents+agentLoop+mcp-client(messages→canary). */
async function bootDsh(canaryDb: string) {
  const M: Record<string, any> = {}
  for (const [k, n] of Object.entries({
    cordis: 'cordis', projections: 'dsh-session-projection', subprocess: 'dsh-subprocess-local',
    session: 'dsh-session', systemPrompt: 'dsh-system-prompt', tools: 'dsh-tools', llm: 'dsh-llm',
    agent: 'dsh-agent', agentLoop: 'dsh-agent-loop', permissionPresets: 'dsh-permission-presets',
    approval: 'dsh-user-approval', attachLocal: 'dsh-attachment-local', workingDir: 'dsh-working-directory',
    bashSandbox: 'dsh-bash-sandbox', shellEnv: 'dsh-shell-env',
  })) M[k] = await dsh(n)
  // Native tool executor is App-0.2.2-only; CLI 0.2.1 dsh-tools ships the runtime scheduler built in.
  let nativeExec: any | undefined
  try { nativeExec = await dsh('dsh-tool-executor-native') } catch { nativeExec = undefined }
  const mcp: any = await dsh('dsh-mcp-client')
  const jsonl = await dsh('dsh-session-persistence-jsonl')
  const workdir = mkdtempSync(join(tmpdir(), 'msg-e2e-wd-')); dirs.push(workdir)
  const state = mkdtempSync(join(tmpdir(), 'msg-e2e-st-')); dirs.push(state)
  const { Context } = M.cordis
  const ctx = new Context()
  const fibers: any[] = []
  const plug = (p: any) => fibers.push(p())
  plug(() => ctx.plugin(M.projections.default))
  plug(() => ctx.plugin(M.subprocess.default))
  plug(() => ctx.plugin(M.session.default))
  plug(() => ctx.plugin(M.systemPrompt.default))
  plug(() => ctx.plugin(M.tools.default))
  plug(() => ctx.plugin(M.llm.default))
  if (nativeExec) plug(() => ctx.plugin({ name: 'native-tool-executor', inject: nativeExec.inject, apply: (c: any) => nativeExec.apply(c) }))
  plug(() => ctx.plugin(M.workingDir.default))
  plug(() => ctx.plugin(M.attachLocal.default, { root: join(state, 'att') }))
  plug(() => ctx.plugin(M.bashSandbox.default, { cwd: workdir, timeoutMs: 10000, maxTimeoutMs: 10000 }))
  plug(() => ctx.plugin({ name: 'shell-env', inject: M.shellEnv.inject, apply: (c: any) => M.shellEnv.apply(c, M.shellEnv.Config({})) }))
  plug(() => ctx.plugin(M.approval.default, {}))
  plug(() => ctx.plugin(M.permissionPresets.default, { presets: {
    'workspace-write': { sandbox: 'workspace-write', approval: 'never' },
    'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
  }, defaultPreset: 'workspace-write' }))
  plug(() => ctx.plugin(M.agent.default))
  plug(() => ctx.plugin(M.agentLoop.default))
  plug(() => jsonl.apply(ctx, { root: state }))
  // Real MCP client → real stdio adapter → canary DB.
  plug(() => ctx.plugin(mcp, { transport: 'stdio', serverName: 'messages', command: MESSAGES_MCP, args: [],
    env: { MESSAGES_MCP_DB: canaryDb, MESSAGES_MCP_CLI: MOBILEQ }, toolCallTimeoutMs: 60000, startupTimeoutMs: 15000 }))
  for (const f of fibers) { try { await f } catch { /* plugin activation errors surface as missing tools below */ } }
  // Wait for mcp tools to publish.
  for (let i = 0; i < 60; i++) {
    const v = ctx.get('tools')?.view?.()
    const names = v ? [...v.visible.keys()] : []
    if (names.some((n: string) => n === 'mcp__messages__send_message')) break
    await new Promise(r => setTimeout(r, 100))
  }
  ctx.llm.registerAdapter(['stub'], scriptedAdapter(M))
  return { ctx, M, workdir }
}

/** Deterministic model: calls the current `nextCall` tool once, then stops. Registered once per context. */
let nextCall: { name: string; args: Record<string, unknown> } | undefined
function scriptedAdapter(M: any) {
  const { LlmAdapter } = M.llm
  return new (class extends LlmAdapter {
    async *stream(options: any) {
      const n = options.messages.filter((m: any) => m.role === 'tool').length
      if (n >= 1 || !nextCall) {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'done' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
        yield { type: 'finish', reason: { kind: 'completed' } }
        return
      }
      const a = JSON.stringify(nextCall.args)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: 'c0', name: nextCall.name, argumentsDelta: a }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'c0', name: nextCall.name, arguments: a } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
  })()
}

/** Run one turn of a fresh real agent whose tool guard delegates to the real Runtime.guardConnection. */
async function runTurn(dshCtx: any, M: any, workdir: string, host: Host, ticketId: string, callName: string,
  args: Record<string, unknown>) {
  nextCall = { name: callName, args }
  const agents = dshCtx.ctx.get('agents')
  const h = await agents.create({ sessionId: `e2e-${Math.random().toString(36).slice(2)}`, meta: { cwd: workdir },
    agentOptions: { provider: 'stub', model: 'stub-1' },
    setup: async (agentCtx: any) => {
      // The REAL production write gate: delegate every tool execution to runtime.guardConnection.
      agentCtx.tools.guard((execution: { name: string; arguments: unknown }) =>
        (host.runtime as any).guardConnection(ticketId, execution.name, execution.arguments))
    } })
  const { createUserMessage } = M.llm
  h.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
  await h.agent.whenIdle()
  const results = h.agent.session.snapshotEvents().filter((e: any) => e.type === 'tool/result')
  return results.map((e: any) => ({ isError: e.data?.message?.isError === true, content: JSON.stringify(e.data?.message?.content ?? '') }))
}

describe('真 AgentLoop + 真 dsh-mcp-client stdio + 真 tools.guard + 真批准入口（隔离 canary）', () => {
  it('真 agent 调 mcp__messages__send_message：未批准 guard 拦截零写；公开批准后真 MCP stdio 执行 canary +1；公开拒绝零写', async () => {
    const canary = mkdtempSync(join(tmpdir(), 'msg-e2e-db-')); dirs.push(canary)
    const db = join(canary, 'mobileq.db')
    execFileSync('python3', [MOBILEQ, '--db', db, 'inject', '--conversation', 'main', '--sender', 'owner', '--text', '用户：请回一句'])
    const parent = String((JSON.parse(sqlv(db, 'SELECT max(id) FROM messages')) as number[][])[0]![0]!)

    const host = await startRuntime()
    try {
      host.runtime.store.saveSettings({ ...host.runtime.store.settings(), connections: { readOnly: true,
        connections: [{ kind: 'messages', server: 'messages', readTools: ['list_channels', 'list_messages', 'get_message'], writeTools: ['send_message'] }] } })
      const { ticket } = await host.acceptedTicket(feishu('1', '@bot 回一句'))
      const dshCtx = await bootDsh(db)
      // Sanity: the real MCP client registered the 4 tools.
      const pubNames = [...(dshCtx.ctx.get('tools')?.view?.().visible.keys() ?? [])].filter((n: string) => n.startsWith('mcp__messages__'))
      expect(pubNames.sort()).toEqual(['mcp__messages__get_message', 'mcp__messages__list_channels', 'mcp__messages__list_messages', 'mcp__messages__send_message'])

      const args = { channel: 'main', to: parent, text: '真执行器经批准的回话' }
      const before = nreplies(db)
      // 1) Unapproved: guard denies → the tool is NOT dispatched → canary unchanged, pendingApproval waiting.
      const r1 = await runTurn(dshCtx, dshCtx.M, dshCtx.workdir, host, ticket.id, 'mcp__messages__send_message', args)
      expect(r1.length).toBe(1)
      expect(r1[0]!.isError).toBe(true)                         // denial surfaced as tool error
      expect(nreplies(db)).toBe(before)                         // zero writes
      expect(host.runtime.store.tickets.get(ticket.id)?.pendingApproval).toMatchObject({ kind: 'connection', status: 'waiting' })
      expect(host.runtime.store.tickets.get(ticket.id)?.attention?.question).toBeTruthy()

      // 2) Approve through the REAL public entry (a person's reply → approvalReply).
      await host.runtime.receive(feishu('2', '做吧'))
      expect(host.runtime.store.tickets.get(ticket.id)?.pendingApproval?.status).toBe('approved')

      // 3) Re-run the same turn (executor re-delivers after approval) → guard allows → real MCP stdio executes → +1.
      const r2 = await runTurn(dshCtx, dshCtx.M, dshCtx.workdir, host, ticket.id, 'mcp__messages__send_message', args)
      expect(r2.length).toBe(1)
      expect(r2[0]!.isError).toBe(false)                        // real dispatch succeeded
      expect(nreplies(db)).toBe(before + 1)                    // exactly +1 via real MCP stdio
      // The reply that landed is the real text through the real stdio adapter (not a stub/no-op).
      const lastReply = (JSON.parse(sqlv(db, 'SELECT text,to_msg,conversation FROM replies ORDER BY id DESC LIMIT 1')) as [string, number, string][])[0]
      expect(lastReply).toEqual(['真执行器经批准的回话', Number(parent), 'main'])

      // 4) A second call with the same args → grant consumed once → re-ask (guard denies), no extra write.
      const r3 = await runTurn(dshCtx, dshCtx.M, dshCtx.workdir, host, ticket.id, 'mcp__messages__send_message', args)
      expect(r3[0]!.isError).toBe(true)
      expect(nreplies(db)).toBe(before + 1)

      // 5) Reject path on a fresh ticket: public "先别做" → stopTicket → guard never allows → zero write.
      const { ticket: t2 } = await host.acceptedTicket(feishu('5', '@bot 另一件'))
      const before2 = nreplies(db)
      const r4 = await runTurn(dshCtx, dshCtx.M, dshCtx.workdir, host, t2.id, 'mcp__messages__send_message', { channel: 'main', to: parent, text: '不该发' })
      expect(r4[0]!.isError).toBe(true)
      await host.runtime.receive(feishu('6', '先别做'))
      expect(nreplies(db)).toBe(before2)                       // reject → zero writes
    } finally {
      await host.stop?.()
    }
  }, 60000)
})
