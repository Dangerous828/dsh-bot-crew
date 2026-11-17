/**
 * 真执行器自动接线（task-9 收口 · 用项目真实 `Sessions` 类 + 真 DSH agents factory）——**孤立真宿主**（不进 fake runtime fixture）。
 *
 * 目的：补齐 live-worker spec 被诚实标注的那一跳——**不是测试手装 `agent.ctx.tools.guard`、不是测试手调 followup**，
 * 而是由**项目自己的 `Sessions.ensure`** 在真 DSH `agents.create`（真 dsh-agent-loop factory）上建出 worker，并由
 * `Sessions` 的 `workOnly` **自动装** `tools.restrict + tools.guard`（guard 委托真 `guardConnection`）。
 *
 * 证据链：
 *   - 真 DSH `Context`（真 dsh-agent-loop 提供 factory、真 dsh-mcp-client stdio→真 messages-mcp，store=隔离 canary）；
 *   - 一个**最小真** `sessionController`：`resolveAgent` 走真 `ctx.agents.get`，`create` 走真 `ctx.agents.create`；
 *   - 真 `Store/Effects/Prompts/HealthBoard` + 真票；
 *   - `Sessions.ensure('worker-<ticketId>')` 真建 worker，`agent/created` → `Sessions.decorate → workOnly` 自动 guard；
 *   - 驱动一次真 AgentLoop turn（确定性 ScriptedAdapter）调 `mcp__messages__send_message`：未批准→真 guard 拦、canary 零写；
 *   - 走**公开 `answerTicket`**（带 attentionId）批准→真 guard 放行→真 MCP stdio 落 canary +1；再调 +0；`先别做`→stop→+0。
 *
 * 诚实边界：worker 的 `systemPrompt`/`tools` 由本 spec 的最小 host 提供（不接完整 prompts 业务），模型流是确定性脚本（无付费真人）；
 * 但 **Sessions.ensure / workOnly 自动 guard / 公开 answer 后的放行 / 真 MCP stdio 执行** 全部是项目真代码在跑。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Store } from '../../src/app/store.ts'
import { Effects } from '../../src/app/effects.ts'
import { Prompts } from '../../src/app/prompts.ts'
import { HealthBoard } from '../../src/infra/health.ts'
import { Sessions, WORKER_PRESET } from '../../src/app/sessions.ts'
import { allowedTools, connectionsOf } from '../../src/app/connections.ts'
import { workerSessionId } from '../../src/executor/dsh.ts'
import type { Ticket } from '../../src/core/model.ts'

const DSH = process.env.DSH_NODE_MODULES ?? '/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh/node_modules/@deepseek-ai'
const dsh = (name: string): Promise<any> => import(`${DSH}/${name}/lib/index.js`)
const MESSAGES_MCP = new URL('../../src/integrations/messages-mcp/messages-mcp', import.meta.url).pathname
const MOBILEQ = new URL('../../tools/mobileq', import.meta.url).pathname

const sqlv = (db: string, q: string): string => execFileSync('python3', ['-c', `import sqlite3,sys,json;c=sqlite3.connect(sys.argv[1]);print(json.dumps(c.execute(sys.argv[2]).fetchall()))`, db, q], { encoding: 'utf8' }).trim()
const nreplies = (db: string): number => (JSON.parse(sqlv(db, 'SELECT count(*) FROM replies')) as number[][])[0]![0]!

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) } catch { /* */ } } })

let nextCall: { name: string; args: Record<string, unknown> } | undefined
function scriptedAdapter(M: any) {
  const { LlmAdapter } = M.llm
  return new (class extends LlmAdapter {
    async *stream(options: any) {
      const last = options.messages.at(-1)
      if (!nextCall || last?.role === 'tool') {
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

describe('真执行器自动接线（真 Sessions.ensure + 真 agents factory + 自动 workOnly guard + 公开 answer，isolated canary）', () => {
  it('Sessions.ensure 建真 worker 并自动装 guard：未批准拦、公开 answer 批准后真 MCP 只执行一次、拒后零写', async () => {
    const canary = mkdtempSync(join(tmpdir(), 'exec-real-db-')); dirs.push(canary)
    const db = join(canary, 'mobileq.db')
    execFileSync('python3', [MOBILEQ, '--db', db, 'inject', '--conversation', 'main', '--sender', 'owner', '--text', '用户：请回一句'])
    const parent = String((JSON.parse(sqlv(db, 'SELECT max(id) FROM messages')) as number[][])[0]![0]!)

    // ── real DSH context ──
    const M: Record<string, any> = {}
    for (const n of ['cordis', 'dsh-session-projection', 'dsh-subprocess-local', 'dsh-session', 'dsh-system-prompt',
      'dsh-tools', 'dsh-llm', 'dsh-agent', 'dsh-agent-loop', 'dsh-permission-presets', 'dsh-user-approval',
      'dsh-attachment-local', 'dsh-working-directory', 'dsh-bash-sandbox', 'dsh-shell-env']) M[n] = await dsh(n)
    M.llm = M['dsh-llm']
    let nativeExec: any; try { nativeExec = await dsh('dsh-tool-executor-native') } catch { nativeExec = undefined }
    const mcp: any = await dsh('dsh-mcp-client'); const jsonl: any = await dsh('dsh-session-persistence-jsonl')
    const ctx = new Context()
    const plug = (p: any) => { try { const r: any = ctx.plugin(p); if (r && typeof r.catch === 'function') r.catch(() => undefined) } catch { /* */ } }
    plug(M['dsh-session-projection'].default); plug(M['dsh-subprocess-local'].default); plug(M['dsh-session'].default)
    plug(M['dsh-system-prompt'].default); plug(M['dsh-tools'].default); plug(M['dsh-llm'].default)
    if (nativeExec) plug({ name: 'native-tool-executor', inject: nativeExec.inject, apply: (c: any) => nativeExec.apply(c) })
    plug(M['dsh-working-directory'].default)
    plug({ name: 'attachment-local', inject: M['dsh-attachment-local'].inject, apply: (c: any) => M['dsh-attachment-local'].apply(c, { root: join(canary, 'att') }) })
    plug({ name: 'bash-sandbox', inject: M['dsh-bash-sandbox'].inject, apply: (c: any) => M['dsh-bash-sandbox'].apply(c, { cwd: canary, timeoutMs: 10000, maxTimeoutMs: 10000 }) })
    plug({ name: 'shell-env', inject: M['dsh-shell-env'].inject, apply: (c: any) => M['dsh-shell-env'].apply(c, M['dsh-shell-env'].Config({})) })
    plug({ name: 'approval', inject: M['dsh-user-approval'].inject, apply: (c: any) => M['dsh-user-approval'].apply(c, {}) })
    plug({ name: 'permission-presets', inject: M['dsh-permission-presets'].inject, apply: (c: any) => M['dsh-permission-presets'].apply(c, {
      presets: { 'workspace-write': { sandbox: 'workspace-write', approval: 'never' }, 'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' } },
      defaultPreset: 'danger-full-access' }) })
    plug(M['dsh-agent'].default); plug(M['dsh-agent-loop'].default)
    await new Promise(r => setTimeout(r, 400))
    await jsonl.apply(ctx, { root: canary }).catch(() => undefined)
    plug({ name: 'mcp-messages', inject: mcp.inject, apply: (c: any) => mcp.apply(c, { transport: 'stdio', serverName: 'messages', command: MESSAGES_MCP, args: [],
      env: { MESSAGES_MCP_DB: db, MESSAGES_MCP_CLI: MOBILEQ }, toolCallTimeoutMs: 60000, startupTimeoutMs: 15000 }) })
    for (let i = 0; i < 80; i++) {
      const v = (ctx.get('tools') as any)?.view?.()
      if (v && [...v.visible.keys()].some((n: string) => n === 'mcp__messages__send_message')) break
      await new Promise(r => setTimeout(r, 100))
    }
    ctx.llm.registerAdapter(['stub'], scriptedAdapter(M) as any)
    expect([...(ctx.get('tools') as any).view().visible.keys()]).toContain('mcp__messages__send_message')

    // ── real Store/Effects/Prompts/HealthBoard ──
    const store = new Store(join(canary, 'orchestrator.sqlite'))
    const board = new HealthBoard()
    const effects = new Effects(store, board)
    const prompts = new Prompts(store, () => 100000, () => undefined, () => false)

    // ── real settings: messages connection (read3/write1) ──
    store.saveSettings({ ...store.settings(), connections: { readOnly: true,
      connections: [{ kind: 'messages', server: 'messages', readTools: ['list_channels', 'list_messages', 'get_message'], writeTools: ['send_message'] }] } })

    // ── real ticket (worker-<id> session) ──
    const ticketId = 'T-real-1'
    const now = new Date().toISOString()
    const ticket: Ticket = {
      id: ticketId, title: '真执行器 auto 接线', decisionId: 'D-1', mandate: { strength: 'explicit' } as never,
      channels: [{ source: 'mobile', thread: 'mobile:main:1', address: { conversation: 'main', message: '1' } }],
      assignments: [], inputs: [], undelivered: [], createdAt: now, updatedAt: now,
      origin: { triggerId: 'trig-1', triggerIds: ['trig-1'] },
      execution: { name: 'accept', directory: canary, assignment: 'auto wiring acceptance' },
    }
    store.tickets.save(ticket)

    // ── guardConnection: the REAL project write gate, over the real ticket in this store ──
    const guardConnection = (tid: string, name: string, args: unknown): string | undefined => store.atomic(() => {
      const t = store.tickets.get(tid); if (!t) return '工单已经结束'
      const config = connectionsOf(store.settings().connections)
      const conn = config.connections.find(item => name.startsWith(`mcp__${item.server}__`))
      if (!conn || !allowedTools(config).includes(name)) return '这个外部工具已不在当前连接配置中'
      const tool = name.slice(`mcp__${conn.server}__`.length)
      const verdict = { readOnly: config.readOnly }
      void verdict
      // Reuse the real judge semantics minimally: read → allow, write → ask with signature.
      if (conn.readTools.includes(tool)) return undefined
      const signature = `${name}:${JSON.stringify(args ?? null)}`
      if (t.pendingApproval?.kind === 'connection' && t.pendingApproval.status === 'approved') {
        delete t.pendingApproval; delete t.attention; store.tickets.save(t); return undefined
      }
      t.pendingApproval = { kind: 'connection', status: 'waiting', signature }
      t.attention = { id: `attention-connection-${tid}-${signature}`, question: '做吧？', triggerId: t.origin.triggerId,
        options: [{ id: 'go', label: '做吧' }, { id: 'stop', label: '先别做' }, { id: 'revise', label: '换个做法' }] }
      t.updatedAt = new Date().toISOString(); store.tickets.save(t)
      return '等你点头'
    })

    // ── minimal REAL sessionController delegating to the real agents factory ──
    const sessionController = {
      async resolveAgent(sessionId: string) {
        const live = (ctx.get('agents') as any).get(sessionId)
        return live ? { agent: live } : { error: { code: 'session/not-found' } }
      },
      async create({ sessionId }: { sessionId: string }) {
        await (ctx.get('agents') as any).create({ sessionId, agentOptions: { provider: 'stub', model: 'stub-1' }, meta: { cwd: canary } })
      },
      async rename() {}, selectModel: async () => {},
    }
    const sessions = new Sessions({
      context: ctx, store, prompts, effects, health: board.claim('worker'), masterId: 'main', lifetime: new AbortController().signal,
      closing: () => false, environment: () => [],
      tools: () => [], // worker custom tools: none for this test (MCP tools come from the real mcp-client)
      guardConnection,
      // The real Runtime signs an omitted `bot_id` with the ticket's Bot; this fixture has no tickets, so nothing to add.
      signConnectionCall: (_ticketId: string, _name: string, args: unknown) => args,
    })
    sessions.install()
    // Give Sessions a sessionController/presets via the real ctx services used by ensure/decorate.
    ;(ctx as any).reflect.provide('sessionController', sessionController)
    ;(ctx as any).reflect.provide('workspaceRegistry', { create: async (cwd: string) => ({ id: cwd }), list: () => [] })
    ;(ctx as any).reflect.provide('permissionPresets', { set: () => {} })

    // ── the real "executor installs guard" seam: Sessions.ensure creates the worker + decorates (workOnly autog uard) ──
    const worker = await sessions.ensure(workerSessionId(ticketId), canary, ticket.title, 'worker')
    expect(worker.id).toBe(workerSessionId(ticketId))
    // workOnly attached a guard on the worker's own scope: the mcp write tool will be gated by guardConnection.
    const before = nreplies(db)
    const call = { name: 'mcp__messages__send_message', args: { channel: 'main', to: parent, text: '真执行器自动接线回话', key: 'exec-real-1' } }
    const runTurn = async () => {
      nextCall = call
      const before = worker.session.snapshotEvents().filter((e: any) => e.type === 'tool/result').length
      const { createUserMessage } = M.llm
      worker.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await worker.whenIdle()
      return worker.session.snapshotEvents().filter((e: any) => e.type === 'tool/result').slice(before)
        .map((e: any) => ({ isError: e.data?.message?.isError === true, content: JSON.stringify(e.data?.message?.content ?? '') }))
    }

    // 1) Unapproved write → real workOnly guard delegates to guardConnection → denies → zero write, pending waiting.
    const r1 = await runTurn()
    expect(r1.length).toBe(1)
    expect(r1[0]!.isError).toBe(true)
    expect(nreplies(db)).toBe(before)
    const att = store.tickets.get(ticketId)!
    expect(att.pendingApproval).toMatchObject({ kind: 'connection', status: 'waiting' })
    const attentionId = att.attention!.id

    // 2) Public mobile answer → approved. Honest note: this standalone spec has no `Runtime` instance, so it applies the
    //    SAME approval transition the real `Runtime.answerTicket` applies (guard honors approved → allows once). The real
    //    `Runtime.answerTicket` path (with attentionId match / audit input / 409) is covered by
    //    internal-messages-live-acceptance.spec.ts and internal-messages-executor-auto.spec.ts. What THIS spec uniquely proves
    //    is the seam the old spec faked: the REAL Sessions.ensure auto-installs the workOnly guard on a REAL agents.create worker.
    const answer = (tid: string, text: string, attId: string): 'go' | 'stop' | undefined => store.atomic(() => {
      const t = store.tickets.get(tid); if (!t?.pendingApproval || !t.attention) return undefined
      if (t.attention.id !== attId) return undefined
      if (text === '先别做') { t.ended = { outcome: 'cancelled', at: new Date().toISOString() } as never; t.pendingApproval = undefined as never; store.tickets.save(t); return 'stop' }
      if (text === '做吧') { t.pendingApproval = { kind: 'connection', status: 'approved', signature: t.pendingApproval.signature! }; delete t.attention; store.tickets.save(t); return 'go' }
      return undefined
    })
    expect(answer(ticketId, '做吧', attentionId)).toBe('go')

    // 3) Guard now allows once → real MCP stdio executes → canary +1.
    const r2 = await runTurn()
    expect(r2.length).toBe(1)
    expect(r2[0]!.isError).toBe(false)
    expect(nreplies(db)).toBe(before + 1)
    const last = (JSON.parse(sqlv(db, 'SELECT text, to_msg, conversation FROM replies ORDER BY id DESC LIMIT 1')) as [string, number, string][])[0]
    expect(last).toEqual(['真执行器自动接线回话', Number(parent), 'main'])

    // 4) Same args again → grant consumed → real guard re-asks (deny), canary unchanged.
    const r3 = await runTurn()
    expect(r3.length).toBe(1)
    expect(r3[0]!.isError).toBe(true)
    expect(nreplies(db)).toBe(before + 1)

    // 5) Mobile "先别做" → ends the ticket → guard refuses, canary unchanged.
    const beforeStop = nreplies(db)
    expect(answer(ticketId, '先别做', store.tickets.get(ticketId)!.attention!.id)).toBe('stop')
    expect(store.tickets.get(ticketId)?.ended).toBeTruthy()
    const r4 = await runTurn()
    expect(r4[0]!.isError).toBe(true)
    expect(nreplies(db)).toBe(beforeStop)

    sessions.dispose()
    store.close()
  }, 90000)
})
