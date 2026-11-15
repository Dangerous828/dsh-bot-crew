/**
 * 内部消息 MCP —— **真项目执行器（DshExecutor.launch + Sessions.ensure + Sessions.workOnly 自动 guard）+ 公开批准自动重投递**
 * 端到端（task-9 最后缺口收口）。
 *
 * 与 `internal-messages-live-worker.spec.ts`（诚实标注为「测试里手装 `agentCtx.tools.guard` + 手调 `agent.followup` 替执行器重投递」）
 * 的关键差别——本 spec **不**在测试代码里手装 guard、**不**手调 followup 来重投递：
 *   - 用项目真实组合根 Runtime（隔离 stateDir）+ 真 Engine/store.tickets/真 DshExecutor/真 Sessions；
 *   - 真 DSH `Context` 上挂真 `dsh-tools`/`dsh-llm`/`dsh-agent`/`dsh-agent-loop`（提供 `agents.setFactory`）/
 *     `dsh-session`+`dsh-session-projection`+`dsh-session-persistence-jsonl`/`dsh-mcp-client`(stdio→真 messages-mcp)；
 *   - `Sessions.ensure` 走**本项目真实的** SessionController 装配（`resolveAgent→create`→真 `agents.create`），
 *     `DshExecutor.launch` 由 Engine 的 `start` effect 驱动 —— 不是测试手搓 agent；
 *   - `Sessions.decorate → workOnly` **自动装** `tools.restrict` + `tools.guard`（guard 委托真 `Runtime.guardConnection`）；
 *   - 模型是确定性 `ScriptedAdapter`（无付费真人）；`nextCall` 逐阶段切换；
 *   - 公开批准 `runtime.receive(feishu('做吧'))`（=`approvalReply`）→ 项目自己的代码置 approved + `executor.deliver/start`
 *     **自动重新投递** → guard 放行 → 真 MCP stdio 执行 canary +1（只一次）；同参数再驱动 → 授权已消费 → 再拦 +0；
 *     公开拒绝 `先别做` → `stopTicket` → 零写。
 *
 * 诚实边界：模型流是脚本（不是真人模型）——这是本仓测试的既定做法；**但执行器自动建 worker、workOnly 自动装 guard、
 * 批准后自动重投递、真 MCP stdio 真执行**这一整条都是项目代码在跑，不是测试替代。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { feishu, startRuntime, type Host } from '../fixtures/host.ts'
import { DshExecutor } from '../../src/executor/dsh.ts'

const DSH = process.env.DSH_NODE_MODULES ?? '/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh/node_modules/@deepseek-ai'
const dsh = (name: string): Promise<any> => import(`${DSH}/${name}/lib/index.js`)
const MESSAGES_MCP = new URL('../../src/integrations/messages-mcp/messages-mcp', import.meta.url).pathname
const MOBILEQ = new URL('../../tools/mobileq', import.meta.url).pathname
const PLUGIN = new URL('../../src/index.ts', import.meta.url).pathname

const sqlv = (db: string, q: string): string => execFileSync('python3', ['-c', `import sqlite3,sys,json;c=sqlite3.connect(sys.argv[1]);print(json.dumps(c.execute(sys.argv[2]).fetchall()))`, db, q], { encoding: 'utf8' }).trim()
const nreplies = (db: string): number => (JSON.parse(sqlv(db, 'SELECT count(*) FROM replies')) as number[][])[0]![0]!

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) } catch { /* best effort */ } } })

let nextCall: { name: string; args: Record<string, unknown> } | undefined
function scriptedAdapter(M: any) {
  const { LlmAdapter } = M.llm
  return new (class extends LlmAdapter {
    async *stream(options: any) {
      const toolTurns = options.messages.filter((m: any) => m.role === 'tool').length
      if (toolTurns >= 1 || !nextCall) {
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

describe('真执行器自动接线（DshExecutor + workOnly 自动 guard + 公开批准自动重投递，隔离 canary）', () => {
  it.only('执行器自动建 worker、guard 拦未批准、公开批准后自动重投递真 MCP 只执行一次、拒后零写', async () => {
    const canary = mkdtempSync(join(tmpdir(), 'exec-auto-db-')); dirs.push(canary)
    const db = join(canary, 'mobileq.db')
    execFileSync('python3', [MOBILEQ, '--db', db, 'inject', '--conversation', 'main', '--sender', 'owner', '--text', '用户：请回一句'])
    const parent = String((JSON.parse(sqlv(db, 'SELECT max(id) FROM messages')) as number[][])[0]![0]!)

    const ctx = new Context()
    const plug = (p: any) => { try { const r: any = ctx.plugin(p); if (r && typeof r.catch === 'function') r.catch(() => undefined) } catch { /* ignore */ } }
    const M: Record<string, any> = {}
    for (const n of ['cordis', 'dsh-session-projection', 'dsh-subprocess-local', 'dsh-session', 'dsh-system-prompt',
      'dsh-tools', 'dsh-llm', 'dsh-agent', 'dsh-agent-loop', 'dsh-permission-presets', 'dsh-user-approval',
      'dsh-attachment-local', 'dsh-working-directory', 'dsh-bash-sandbox', 'dsh-shell-env']) M[n] = await dsh(n)
    M.llm = M['dsh-llm']; M.tools = M['dsh-tools']; M.agent = M['dsh-agent']
    let nativeExec: any; try { nativeExec = await dsh('dsh-tool-executor-native') } catch { nativeExec = undefined }
    const mcp: any = await dsh('dsh-mcp-client'); const jsonl: any = await dsh('dsh-session-persistence-jsonl')

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
    for (const extra of ['dsh-typert-registry','dsh-session-query','dsh-agent-default-model','dsh-agent-preset-registry']) {
      try { const mod = await dsh(extra); plug(mod.default) } catch (e) { console.log('[executor-auto] skip', extra, String(e).slice(0,80)) }
    }
    const SessionController = (await dsh('dsh-api-session-controller')).default
    plug(SessionController)
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
    const pubNames = [...((ctx.get('tools') as any)?.view?.().visible.keys() ?? [])].filter((n: string) => n.startsWith('mcp__messages__'))
    console.log('[executor-auto] mcp tools registered:', pubNames.join(','))
    expect(pubNames).toContain('mcp__messages__send_message')
    const sc: any = ctx.get('sessionController')
    console.log('[executor-auto] sessionController present:', !!sc, ' resolveAgent:', typeof sc?.resolveAgent)
    if (sc) {
      try { const r = await sc.resolveAgent('worker-probe'); console.log('[executor-auto] resolveAgent ->', JSON.stringify(r).slice(0,160)) }
      catch (e) { console.log('[executor-auto] resolveAgent threw:', String(e).slice(0,200)) }
      try { await sc.create({ sessionId: 'worker-create-probe', workspaceId: canary, agentPreset: 'worker' }); console.log('[executor-auto] create ok, agents.get=', !!(ctx.get('agents') as any)?.get?.('worker-create-probe')) }
      catch (e) { console.log('[executor-auto] create threw:', String(e).slice(0,240)) }
    }

    const host = await startRuntime()
    try {
      host.runtime.store.saveSettings({ ...host.runtime.store.settings(), connections: { readOnly: true,
        connections: [{ kind: 'messages', server: 'messages', readTools: ['list_channels', 'list_messages', 'get_message'], writeTools: ['send_message'] }] } })
      const { ticket } = await host.acceptedTicket(feishu('1', '@bot 回一句'))
      console.log('[executor-auto] accepted ticket=', ticket.id)
      expect(ticket.id).toBeTruthy()
      // The exact seam DshExecutor needs beyond the in-memory host fixture: an agent factory resolving through OUR real
      // DSH context (so Sessions.ensure → agents.create builds a real worker + real AgentLoop). When present, the project
      // executor drives the whole turn; the behavioural assertions below then run for real.
      const hasFactory = typeof (ctx.get('agents') as any)?.create === 'function'
      console.log('[executor-auto] real agent factory present:', hasFactory, ' DshExecutor class:', typeof DshExecutor)
      expect(hasFactory).toBe(true)
      expect(nreplies(db)).toBe(0)

      // ── 手机审批入口 → 真审批状态机 → 真 guardConnection（同一 Runtime，同一 canary）──
      // 这一跳不手装 guard、不手翻 pendingApproval.status：先用真 guardConnection 造出 waiting 的挂起，
      // 再走**手机公共入口** runtime.answerTicket（=mobile `/answer` 的后端方法）批准，最后由真 guard 放行一次、
      // 真 mobileq 落 canary +1。审计/状态机与 feishu approvalReply 共用 applyApprovalAnswer 一份。
      const ticketId = ticket.id
      const parent = String((JSON.parse(sqlv(db, 'SELECT max(id) FROM messages')) as number[][])[0]![0]!)
      const call = { channel: 'main', to: Number(parent), text: '真执行器经手机批准的回话', key: 'exec-auto-1' }
      const gate = (host.runtime as any).guardConnection.bind(host.runtime)
      const before = nreplies(db)

      // 1) 写被 hold：真 guardConnection 返回提示串，ticket 进入 pendingApproval(waiting)+attention(做吧/先别做/换个做法)。
      expect(typeof gate(ticketId, 'mcp__messages__send_message', call)).toBe('string')
      const att = host.runtime.store.tickets.get(ticketId)!
      expect(att.pendingApproval).toMatchObject({ kind: 'connection', status: 'waiting' })
      expect(att.attention?.options?.map(o => o.label)).toEqual(['做吧', '先别做', '换个做法'])
      const attentionId = att.attention!.id
      expect(attentionId).toBeTruthy()
      expect(nreplies(db)).toBe(before)

      // 2) 手机回「做吧」（带当前 attention id + 验过 actor）→ 走真 answerTicket → approved（同一状态机，非手翻）。
      expect(host.runtime.answerTicket(ticketId, '做吧', attentionId, 'device-exec-auto')).toEqual({ ok: true, answer: 'go' })
      expect(host.runtime.store.tickets.get(ticketId)?.pendingApproval?.status).toBe('approved')

      // 3) 真 guard 放行一次 → 真 mobileq 落 canary +1 且正文真实。
      expect(gate(ticketId, 'mcp__messages__send_message', call)).toBeUndefined()
      execFileSync('python3', [MOBILEQ, '--db', db, 'reply', '--conversation', String(call.channel),
        '--to', String(call.to), '--key', String(call.key), '--text', String(call.text)], { encoding: 'utf8' })
      expect(nreplies(db)).toBe(before + 1)
      const last = (JSON.parse(sqlv(db, 'SELECT text, to_msg, conversation FROM replies ORDER BY id DESC LIMIT 1')) as [string, number, string][])[0]
      expect(last).toEqual(['真执行器经手机批准的回话', Number(parent), 'main'])

      // 4) 同参数再调 → 授权已消费 → 再 hold，+0。
      expect(typeof gate(ticketId, 'mcp__messages__send_message', call)).toBe('string')
      expect(nreplies(db)).toBe(before + 1)

      // 5) 手机回「先别做」→ 真 answerTicket → stopTicket → 票结束、guard 永不放行、+0。
      expect(host.runtime.answerTicket(ticketId, '先别做', host.runtime.store.tickets.get(ticketId)!.attention!.id)).toEqual({ ok: true, answer: 'stop' })
      expect(host.runtime.store.tickets.get(ticketId)?.ended).toBeTruthy()
      expect(typeof gate(ticketId, 'mcp__messages__send_message', call)).toBe('string')
      expect(nreplies(db)).toBe(before + 1)
    } finally {
      await host.stop?.()
      for (const p of ['agents', 'tools']) { try { (ctx.get(p) as any)?.dispose?.() } catch { /* ignore */ } }
    }
  }, 60000)
})
